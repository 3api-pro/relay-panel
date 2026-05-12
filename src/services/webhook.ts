/**
 * Webhook dispatch + retry service (v0.5).
 *
 * Public surface:
 *   - generateSecret()                  random 32-byte hex
 *   - signPayload(secret, body)         HMAC SHA256 hex digest
 *   - dispatchEvent(tenantId, type, payload)  insert webhook_delivery row
 *                                       for every matching subscription;
 *                                       returns the number of rows enqueued
 *   - attemptDelivery(deliveryId)       single-shot fetch attempt,
 *                                       updates row state in place
 *   - startWebhookWorker()              boot the 30s scanner loop
 *
 * Retry policy:
 *   - HTTP 2xx                  -> status='success'
 *   - HTTP 4xx (non-408)        -> status='failed', no retry
 *                                  (configuration error; subscriber must
 *                                  fix and re-test manually)
 *   - HTTP 5xx / network / 408  -> exponential backoff
 *                                  1min, 5min, 30min, then 'exhausted'
 *   - Max attempts: 3 (initial + 2 retries)
 *
 * Worker tick = 30s. unref()'d so it never blocks process exit.
 */
import crypto from 'crypto';
import { query } from './database';
import { logger } from './logger';

const WORKER_TICK_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_SEC = [60, 300, 1800]; // 1min, 5min, 30min
const RESPONSE_EXCERPT_MAX = 200;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function generateSecret(): string {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

export function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Enqueue an event row for every webhook subscription matching
 * (tenant_id, enabled=TRUE, events contains type).
 *
 * Returns the number of rows enqueued. PG triggers in migration 014
 * cover order.paid and subscription.expired automatically — this is
 * for the application-level events (refund.processed, wholesale.low,
 * and the admin "test" helper).
 */
export async function dispatchEvent(
  tenantId: number,
  eventType: string,
  payload: object,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO webhook_delivery (webhook_id, event_type, payload, next_retry_at)
     SELECT w.id, $1, $2::jsonb, NOW()
       FROM webhook w
      WHERE w.tenant_id = $3
        AND w.enabled = TRUE
        AND w.events @> to_jsonb($1::text)
     RETURNING id`,
    [eventType, JSON.stringify(payload), tenantId],
  );
  if (rows.length > 0) {
    logger.info(
      { tenantId, eventType, enqueued: rows.length },
      'webhook:dispatch:enqueued',
    );
    for (const r of rows) {
      void attemptDelivery(r.id).catch((err: any) => {
        logger.warn(
          { err: err?.message, deliveryId: r.id },
          'webhook:dispatch:initial:fail',
        );
      });
    }
  }
  return rows.length;
}

/**
 * Attempt a single delivery. Loads the row, signs the body, POSTs to
 * webhook.url, then updates the row based on the response.
 */
export async function attemptDelivery(deliveryId: number): Promise<void> {
  const rows = await query<any>(
    `SELECT d.id, d.webhook_id, d.event_type, d.payload, d.status, d.attempts,
            w.url, w.secret, w.tenant_id, w.enabled
       FROM webhook_delivery d
       JOIN webhook w ON w.id = d.webhook_id
      WHERE d.id = $1 LIMIT 1`,
    [deliveryId],
  );
  if (rows.length === 0) return;
  const row = rows[0];
  if (row.status === 'success' || row.status === 'exhausted') return;
  if (!row.enabled) {
    await query(
      `UPDATE webhook_delivery SET status='exhausted', next_retry_at=NULL WHERE id=$1`,
      [deliveryId],
    );
    return;
  }

  const bodyStr = typeof row.payload === 'string'
    ? row.payload
    : JSON.stringify(row.payload);
  const sig = signPayload(row.secret, bodyStr);
  const attempts = (row.attempts ?? 0) + 1;
  const startedAt = Date.now();

  let httpStatus: number | null = null;
  let responseExcerpt: string | null = null;
  let ok = false;
  let isClient4xx = false;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const resp = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': '3api-webhook/1.0',
        'X-3api-Event': row.event_type,
        'X-3api-Delivery': String(deliveryId),
        'X-3api-Signature': 'sha256=' + sig,
        'X-3api-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    httpStatus = resp.status;
    try {
      const text = await resp.text();
      responseExcerpt = text.slice(0, RESPONSE_EXCERPT_MAX);
    } catch {
      responseExcerpt = null;
    }
    ok = resp.status >= 200 && resp.status < 300;
    isClient4xx = resp.status >= 400 && resp.status < 500 && resp.status !== 408;
  } catch (err: any) {
    responseExcerpt = (err?.name === 'AbortError' ? 'timeout' : err?.message || String(err))
      .slice(0, RESPONSE_EXCERPT_MAX);
    httpStatus = null;
    ok = false;
    isClient4xx = false;
  } finally {
    clearTimeout(to);
  }

  const elapsedMs = Date.now() - startedAt;
  const tenantId = row.tenant_id;

  if (ok) {
    await query(
      `UPDATE webhook_delivery
          SET status='success',
              http_status=$1,
              response_excerpt=$2,
              attempts=$3,
              next_retry_at=NULL
        WHERE id=$4`,
      [httpStatus, responseExcerpt, attempts, deliveryId],
    );
    await query(
      `UPDATE webhook SET last_triggered_at=NOW() WHERE id=$1`,
      [row.webhook_id],
    );
    logger.info(
      { deliveryId, webhookId: row.webhook_id, tenantId, eventType: row.event_type, httpStatus, elapsedMs },
      'webhook:delivery:success',
    );
    return;
  }

  if (isClient4xx || attempts >= MAX_ATTEMPTS) {
    const finalStatus = isClient4xx ? 'failed' : 'exhausted';
    await query(
      `UPDATE webhook_delivery
          SET status=$1,
              http_status=$2,
              response_excerpt=$3,
              attempts=$4,
              next_retry_at=NULL
        WHERE id=$5`,
      [finalStatus, httpStatus, responseExcerpt, attempts, deliveryId],
    );
    await query(
      `UPDATE webhook SET fail_count_total = fail_count_total + 1 WHERE id=$1`,
      [row.webhook_id],
    );
    logger.warn(
      { deliveryId, webhookId: row.webhook_id, tenantId, eventType: row.event_type, httpStatus, attempts, finalStatus, responseExcerpt },
      'webhook:delivery:done_not_ok',
    );
    return;
  }

  const idx = Math.min(attempts - 1, RETRY_DELAYS_SEC.length - 1);
  const delaySec = RETRY_DELAYS_SEC[idx];
  await query(
    `UPDATE webhook_delivery
        SET status='failed',
            http_status=$1,
            response_excerpt=$2,
            attempts=$3,
            next_retry_at=NOW() + ($4::int || ' seconds')::interval
      WHERE id=$5`,
    [httpStatus, responseExcerpt, attempts, delaySec, deliveryId],
  );
  logger.warn(
    { deliveryId, webhookId: row.webhook_id, tenantId, eventType: row.event_type, httpStatus, attempts, retryInSec: delaySec },
    'webhook:delivery:retry',
  );
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = await query<{ id: number }>(
      `SELECT id FROM webhook_delivery
        WHERE status IN ('pending','failed')
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= NOW()
        ORDER BY next_retry_at
        LIMIT 50`,
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      await attemptDelivery(r.id).catch((err: any) => {
        logger.warn({ err: err?.message, deliveryId: r.id }, 'webhook:worker:attempt:fail');
      });
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'webhook:worker:tick:fail');
  } finally {
    ticking = false;
  }
}

export function startWebhookWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, WORKER_TICK_MS);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  logger.info({ tickMs: WORKER_TICK_MS }, 'webhook:worker:started');
}

export function stopWebhookWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
