/**
 * wholesale-sync — periodic poll of the upstream llmapi reseller account
 * balance via the wsk-* key. Mirrors result into wholesale_platform_balance
 * so admin UI / billing alerting can show real floating capital.
 *
 * Calls GET ${UPSTREAM_BASE_URL}/wholesale/balance with Bearer wsk-... and
 * upserts the singleton row id=1.
 *
 * Skipped entirely when:
 *   - UPSTREAM_KEY is empty
 *   - UPSTREAM_KEY starts with "wsk-fake" (placeholder)
 *
 * On HTTP / network errors we keep the last-good balance and only update
 * last_sync_status + last_sync_error so the dashboard can show the staleness.
 */
import { config } from '../config';
import { query } from './database';
import { logger } from './logger';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Build candidate balance URLs to probe.
 *
 *   Canonical: {base}/balance   (where base ends with /v1/wholesale)
 *   Fallback:  {base}/wholesale/balance  (legacy /wholesale/v1 layout)
 *
 * We probe canonical first; on 404 the caller retries with fallback. This
 * keeps both the new and old UPSTREAM_BASE_URL env values working without
 * a config migration.
 */
function balanceUrlCandidates(): string[] {
  const base = config.upstreamBaseUrl.replace(/\/$/, '');
  return [
    `${base}/balance`,
    `${base}/wholesale/balance`,
  ];
}

function balanceUrl(): string {
  return balanceUrlCandidates()[0];
}

function isConfigured(): boolean {
  if (!config.upstreamKey) return false;
  if (config.upstreamKey.startsWith('wsk-fake')) return false;
  return true;
}

export async function syncWholesaleOnce(): Promise<void> {
  if (!isConfigured()) {
    await query(
      `INSERT INTO wholesale_platform_balance (id, last_sync_at, last_sync_status, last_sync_error, updated_at)
         VALUES (1, NOW(), 'unconfigured', 'UPSTREAM_KEY missing or wsk-fake placeholder', NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_sync_at      = NOW(),
         last_sync_status  = 'unconfigured',
         last_sync_error   = 'UPSTREAM_KEY missing or wsk-fake placeholder',
         updated_at        = NOW()`,
    );
    logger.debug({ url: balanceUrl() }, 'wholesale-sync:skip:unconfigured');
    return;
  }

  const candidates = balanceUrlCandidates();
  const t0 = Date.now();
  let chosenUrl: string = candidates[0];
  try {
    // Probe each candidate until one returns 2xx or non-404. Anything
    // other than 404 is treated as authoritative — auth failures, 5xx,
    // etc. all stop the chain.
    let res: Response | null = null;
    let lastStatus = 0;
    let lastText = '';
    for (const url of candidates) {
      chosenUrl = url;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.upstreamKey}`,
          'User-Agent': '3api-relay-panel/wholesale-sync',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.ok) { res = r; break; }
      lastStatus = r.status;
      lastText = await r.text().catch(() => '');
      if (r.status !== 404) {
        // non-404 = authoritative failure, stop probing.
        res = r;
        break;
      }
      // 404 — try next candidate (legacy path).
      logger.debug({ url, status: r.status }, 'wholesale-sync:try_fallback');
    }

    if (!res || !res.ok) {
      await query(
        `INSERT INTO wholesale_platform_balance (id, last_sync_at, last_sync_status, last_sync_error, updated_at)
           VALUES (1, NOW(), 'http_error', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET
           last_sync_at      = NOW(),
           last_sync_status  = 'http_error',
           last_sync_error   = $1,
           updated_at        = NOW()`,
        [`HTTP ${res?.status ?? lastStatus}: ${(lastText || '').slice(0, 200)}`],
      );
      logger.warn({ url: chosenUrl, status: res?.status ?? lastStatus, body: (lastText || '').slice(0, 200) }, 'wholesale-sync:http_error');
      return;
    }

    const body: any = await res.json();
    const balanceCents = Number(body?.balance_cents ?? 0);
    const totalDeposited = Number(body?.total_deposited_cents ?? 0);
    const totalPurchased = Number(body?.total_purchased_cents ?? 0);
    const resellerId = Number(body?.reseller_id ?? 0) || null;

    await query(
      `INSERT INTO wholesale_platform_balance
         (id, balance_cents, total_deposited_cents, total_purchased_cents,
          reseller_id, last_sync_at, last_sync_status, last_sync_error, updated_at)
       VALUES (1, $1, $2, $3, $4, NOW(), 'ok', NULL, NOW())
       ON CONFLICT (id) DO UPDATE SET
         balance_cents          = EXCLUDED.balance_cents,
         total_deposited_cents  = EXCLUDED.total_deposited_cents,
         total_purchased_cents  = EXCLUDED.total_purchased_cents,
         reseller_id            = EXCLUDED.reseller_id,
         last_sync_at           = NOW(),
         last_sync_status       = 'ok',
         last_sync_error        = NULL,
         updated_at             = NOW()`,
      [balanceCents, totalDeposited, totalPurchased, resellerId],
    );
    logger.info(
      {
        url: chosenUrl,
        balance_cents: balanceCents,
        reseller_id: resellerId,
        elapsed_ms: Date.now() - t0,
      },
      'wholesale-sync:ok',
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await query(
      `INSERT INTO wholesale_platform_balance (id, last_sync_at, last_sync_status, last_sync_error, updated_at)
         VALUES (1, NOW(), 'network_error', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_sync_at      = NOW(),
         last_sync_status  = 'network_error',
         last_sync_error   = $1,
         updated_at        = NOW()`,
      [msg.slice(0, 500)],
    );
    logger.warn({ url: chosenUrl, err: msg, elapsed_ms: Date.now() - t0 }, 'wholesale-sync:network_error');
  }
}

export function startWholesaleSync(): NodeJS.Timeout {
  // Defer first sync so the rest of boot finishes; then interval every 5 min.
  setTimeout(() => {
    void syncWholesaleOnce();
  }, 5_000);
  return setInterval(() => {
    void syncWholesaleOnce();
  }, SYNC_INTERVAL_MS);
}
