/**
 * Admin webhook routes (v0.5).
 *
 * Mounted under /admin so tenantResolver + authAdmin are inherited from
 * the parent. All endpoints read/write only the calling admin's tenant —
 * a subdomain trick cannot reach another reseller's webhooks because
 * tenant_id comes from req.resellerAdmin.
 *
 *   GET    /admin/webhooks                    — list (incl. last_triggered, fail_count)
 *   POST   /admin/webhooks                    — create
 *   PATCH  /admin/webhooks/:id                — update url/events/enabled
 *   DELETE /admin/webhooks/:id                — delete (cascades deliveries)
 *   POST   /admin/webhooks/:id/test           — fire synthetic event
 *   GET    /admin/webhooks/:id/deliveries     — history (paginated)
 */
import { Router, Request, Response } from 'express';
import { query } from '../../services/database';
import {
  dispatchEvent,
  generateSecret,
  attemptDelivery,
} from '../../services/webhook';
import { SUPPORTED_EVENT_TYPES } from '../../services/webhook-events';
import { logger } from '../../services/logger';

export const adminWebhooksRouter = Router();

function validUrl(s: any): string | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return s;
  } catch {
    return null;
  }
}

function normalizeEvents(arr: any): string[] | null {
  if (!Array.isArray(arr)) return null;
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== 'string') return null;
    if (!SUPPORTED_EVENT_TYPES.includes(x as any)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

// =========================================================================
// GET /admin/webhooks
// =========================================================================
adminWebhooksRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  try {
    const rows = await query<any>(
      `SELECT w.id, w.url, w.events, w.enabled, w.last_triggered_at,
              w.fail_count_total, w.created_at,
              COALESCE((SELECT COUNT(*)::int FROM webhook_delivery d
                         WHERE d.webhook_id = w.id), 0) AS delivery_count,
              COALESCE((SELECT COUNT(*)::int FROM webhook_delivery d
                         WHERE d.webhook_id = w.id AND d.status='success'), 0) AS success_count
         FROM webhook w
        WHERE w.tenant_id = $1
        ORDER BY w.id DESC`,
      [tenantId],
    );
    res.json({ data: rows });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:webhooks:list:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// POST /admin/webhooks  { url, events[], secret? }
// =========================================================================
adminWebhooksRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body = req.body ?? {};
  const url = validUrl(body.url);
  if (!url) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'url must be a valid http/https URL ≤ 2000 chars' },
    });
    return;
  }
  const events = normalizeEvents(body.events);
  if (!events || events.length === 0) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: `events must be a non-empty array of: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
      },
    });
    return;
  }
  const secret =
    typeof body.secret === 'string' && body.secret.length >= 16 && body.secret.length <= 128
      ? body.secret
      : generateSecret();

  try {
    const rows = await query<{ id: number; created_at: string }>(
      `INSERT INTO webhook (tenant_id, url, secret, events, enabled)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       RETURNING id, created_at`,
      [tenantId, url, secret, JSON.stringify(events)],
    );
    res.status(201).json({
      id: rows[0].id,
      url,
      events,
      secret, // returned ONCE — admin must record it for verification
      enabled: true,
      created_at: rows[0].created_at,
    });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:webhooks:create:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// PATCH /admin/webhooks/:id  { url?, events?, enabled? }
// =========================================================================
adminWebhooksRouter.patch('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id || !Number.isFinite(id)) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const body = req.body ?? {};
  const sets: string[] = [];
  const params: any[] = [];

  if (body.url !== undefined) {
    const u = validUrl(body.url);
    if (!u) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid url' } });
      return;
    }
    params.push(u);
    sets.push(`url = $${params.length}`);
  }
  if (body.events !== undefined) {
    const ev = normalizeEvents(body.events);
    if (!ev || ev.length === 0) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid events' } });
      return;
    }
    params.push(JSON.stringify(ev));
    sets.push(`events = $${params.length}::jsonb`);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'enabled must be boolean' } });
      return;
    }
    params.push(body.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'no fields to update' } });
    return;
  }
  params.push(id);
  params.push(tenantId);

  try {
    const rows = await query<any>(
      `UPDATE webhook SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
        RETURNING id, url, events, enabled, last_triggered_at, fail_count_total, created_at`,
      params,
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'webhook not found' } });
      return;
    }
    res.json(rows[0]);
  } catch (err: any) {
    logger.error({ err: err.message, tenantId, id }, 'admin:webhooks:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// DELETE /admin/webhooks/:id
// =========================================================================
adminWebhooksRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  try {
    const rows = await query<{ id: number }>(
      `DELETE FROM webhook WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'webhook not found' } });
      return;
    }
    res.json({ ok: true, id });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId, id }, 'admin:webhooks:delete:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// POST /admin/webhooks/:id/test
// Fires a synthetic 'test' event. Bypasses events[] filter — sends to this
// specific webhook only.
// =========================================================================
adminWebhooksRouter.post('/:id/test', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  try {
    const wh = await query<{ id: number; enabled: boolean }>(
      `SELECT id, enabled FROM webhook WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [id, tenantId],
    );
    if (wh.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'webhook not found' } });
      return;
    }
    const payload = {
      event_type: 'test',
      timestamp: Math.floor(Date.now() / 1000),
      tenant_id: tenantId,
      message: 'Hello from 3API — your endpoint is configured correctly if you got this.',
    };
    const ins = await query<{ id: number }>(
      `INSERT INTO webhook_delivery (webhook_id, event_type, payload, next_retry_at)
       VALUES ($1, 'test', $2::jsonb, NOW()) RETURNING id`,
      [id, JSON.stringify(payload)],
    );
    const deliveryId = ins[0].id;
    // Try to deliver synchronously so the admin sees a result.
    await attemptDelivery(deliveryId);
    const after = await query<any>(
      `SELECT id, status, http_status, response_excerpt, attempts
         FROM webhook_delivery WHERE id = $1 LIMIT 1`,
      [deliveryId],
    );
    res.json({ delivery: after[0] || null });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId, id }, 'admin:webhooks:test:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// GET /admin/webhooks/:id/deliveries?limit=50
// =========================================================================
adminWebhooksRouter.get('/:id/deliveries', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);

  try {
    const own = await query<{ id: number }>(
      `SELECT id FROM webhook WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [id, tenantId],
    );
    if (own.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'webhook not found' } });
      return;
    }
    const rows = await query<any>(
      `SELECT id, event_type, status, http_status, response_excerpt,
              attempts, next_retry_at, created_at
         FROM webhook_delivery
        WHERE webhook_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [id, limit],
    );
    res.json({ data: rows, limit });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId, id }, 'admin:webhooks:deliveries:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// Touch dispatchEvent so the import doesn't get tree-shaken out — refund
// + wholesale.low callers will use it when wired.
export { dispatchEvent };
