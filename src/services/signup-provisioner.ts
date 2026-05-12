/**
 * signup-provisioner — provision an out-of-the-box upstream channel for a
 * freshly-signed-up tenant, so the new admin can hit /v1/messages
 * immediately without first sourcing a wholesale sk- or BYOK key.
 *
 * Two strategies, selected by env PHASE2_AUTO_PROVISION (default 'off'):
 *
 *   Phase-1 (default, OFF):
 *     Copy the platform's *shared* UPSTREAM_KEY (wsk-*) into the tenant's
 *     upstream_channel.api_key. All tenants share one wholesale identity
 *     at llmapi.pro — no per-signup ¥29 spend. Trade-off: llmapi can't
 *     differentiate channels/billing per tenant.
 *
 *   Phase-2 (ON, costs ~¥29/tenant for pro/monthly):
 *     Call POST {upstreamBaseUrl}/purchase with the platform wsk-* to
 *     mint a per-tenant sk-relay-* shadow key and persist that. llmapi
 *     now sees each tenant as a separate channel, with independent
 *     billing / cooldown / quota.  Default plan is `pro` / `monthly`.
 *
 *     We don't default-ON because each new tenant burns the platform's
 *     wholesale balance. Operator should flip the env once they have
 *     trial-only purchase support in llmapi OR are willing to spend.
 *
 *     A manual upgrade path lives at:
 *       POST /platform/tenants/:id/upgrade-shadow
 *     which mints a per-tenant sk- regardless of the env gate. Use that
 *     for paying tenants that justify the spend.
 *
 * Idempotent — if a recommended llmapi-wholesale channel already exists
 * for the tenant we leave it alone and return ok=true reason='exists'.
 *
 * Non-blocking — the signup route should treat failures as warnings and
 * still return 201. The admin can always /admin/channels manually.
 */
import type { PoolClient } from 'pg';
import { config } from '../config';
import { logger } from './logger';

export interface ProvisionResult {
  ok: boolean;
  channel_id: number | null;
  reason: string;
  /** 'phase1' (shared wsk-) or 'phase2' (per-tenant sk-relay-*). */
  phase?: 'phase1' | 'phase2';
}

export interface PurchaseShadowSkResult {
  ok: boolean;
  sk?: string;
  purchase_id?: string;
  expires_at?: string | null;
  amount_cents?: number;
  remaining_balance_cents?: number;
  error?: string;
  status?: number;
}

function phase2Enabled(): boolean {
  return (process.env.PHASE2_AUTO_PROVISION || '').toLowerCase() === 'on';
}

/**
 * Defaults for the per-tenant shadow purchase. Operator can override via env.
 *   PHASE2_DEFAULT_PLAN   — default 'pro'  (must be one of llmapi's VALID_PLANS).
 *   PHASE2_DEFAULT_CYCLE  — default 'monthly'.
 */
function defaultPlan(): string {
  return (process.env.PHASE2_DEFAULT_PLAN || 'pro').toLowerCase();
}
function defaultCycle(): string {
  return (process.env.PHASE2_DEFAULT_CYCLE || 'monthly').toLowerCase();
}

/**
 * Call llmapi.pro POST /v1/wholesale/purchase to mint a per-tenant
 * shadow sk-relay-*. Uses the platform wsk-* (config.upstreamKey).
 *
 * Returns ok=false instead of throwing so callers can decide whether
 * to fall back to phase-1 or surface the error.
 */
export async function purchaseShadowSk(opts: {
  tenantId: number;
  plan?: string;
  cycle?: string;
  requestIdSuffix?: string;
}): Promise<PurchaseShadowSkResult> {
  const wsk = config.upstreamKey;
  if (!wsk || wsk.length === 0 || wsk.startsWith('wsk-fake')) {
    return { ok: false, error: 'no_platform_wsk_in_env' };
  }
  const plan = (opts.plan || defaultPlan()).toLowerCase();
  const cycle = (opts.cycle || defaultCycle()).toLowerCase();
  const base = config.upstreamBaseUrl.replace(/\/$/, '');
  // Mirror wholesale-sync.ts probe order — operator may have configured the
  // base either as `…/v1/wholesale` (canonical) or `…/v1` (legacy). The
  // purchase endpoint is /purchase off the wholesale mount, so we try both.
  const candidates = [`${base}/purchase`, `${base}/wholesale/purchase`];
  const requestId = `tenant-${opts.tenantId}-${opts.requestIdSuffix || Date.now()}`;

  let last: PurchaseShadowSkResult = { ok: false, error: 'no_candidates' };
  for (const url of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${wsk}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': '3api-relay-panel/0.5.0',
        },
        body: JSON.stringify({ plan, cycle, request_id: requestId }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: any = {};
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      if (!res.ok) {
        last = {
          ok: false,
          status: res.status,
          error: parsed?.error?.message || parsed?.message || `upstream_${res.status}`,
        };
        // 404 / 405 — try the next candidate. Other errors are auth/server,
        // no point in re-trying the alternate mount.
        if (res.status === 404 || res.status === 405) continue;
        return last;
      }
      if (typeof parsed?.api_key !== 'string' || parsed.api_key.length === 0) {
        last = { ok: false, status: res.status, error: 'no_api_key_in_response' };
        return last;
      }
      return {
        ok: true,
        sk: parsed.api_key,
        purchase_id: typeof parsed.purchase_id === 'string' ? parsed.purchase_id : undefined,
        expires_at: parsed.expires_at ?? null,
        amount_cents: typeof parsed.amount_cents === 'number' ? parsed.amount_cents : undefined,
        remaining_balance_cents: typeof parsed.remaining_balance_cents === 'number'
          ? parsed.remaining_balance_cents : undefined,
      };
    } catch (err: any) {
      last = { ok: false, error: err?.message ?? String(err) };
      // Network errors: don't fall through to alternate mount; surface promptly.
      return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * Insert (or upsert) the recommended llmapi-wholesale channel.
 *
 * Shared logic for Phase-1, Phase-2 signup, and the manual upgrade-shadow
 * platform endpoint. `apiKey` is the wsk- (phase 1) or sk-relay-* (phase 2).
 */
async function upsertRecommendedChannel(
  client: PoolClient,
  tenantId: number,
  baseUrl: string,
  apiKey: string,
  phase: 'phase1' | 'phase2',
  meta?: {
    purchase_id?: string;
    expires_at?: string | null;
    amount_cents?: number;
  },
): Promise<number> {
  const nowIso = new Date().toISOString();
  const keysJson = JSON.stringify([{
    key: apiKey,
    status: 'active',
    added_at: nowIso,
    cooled_until: null,
    last_error: null,
  }]);
  const headersJson = JSON.stringify({
    'X-3api-Provision-Phase': phase,
    ...(meta?.purchase_id ? { 'X-3api-Shadow-Purchase-Id': meta.purchase_id } : {}),
    ...(meta?.expires_at ? { 'X-3api-Shadow-Expires-At': meta.expires_at } : {}),
  });

  // Try update existing recommended row first (upgrade path).
  // No updated_at column on upstream_channel (migration 013 adds it
  // optionally, but we keep the UPDATE column-free so the code works
  // on stock schemas without the migration applied).
  const upd = await client.query<{ id: number }>(
    `UPDATE upstream_channel
        SET api_key = $2,
            keys = $3::jsonb,
            custom_headers = $4::jsonb
      WHERE tenant_id = $1
        AND provider_type = 'llmapi-wholesale'
        AND is_recommended = TRUE
      RETURNING id`,
    [tenantId, apiKey, keysJson, headersJson],
  );
  if (upd.rows.length > 0) return upd.rows[0].id;

  const ins = await client.query<{ id: number }>(
    `INSERT INTO upstream_channel
       (tenant_id, name, base_url, api_key, type, provider_type,
        status, weight, models, model_mapping, group_access,
        keys, current_key_idx, custom_headers, enabled, is_recommended,
        is_default, priority)
     VALUES
       ($1, 'Recommended (llmapi.pro)', $2, $3, 'wholesale-3api', 'llmapi-wholesale',
        'active', 100, NULL, NULL, 'default',
        $4::jsonb, 0, $5::jsonb, TRUE, TRUE,
        TRUE, 1)
     RETURNING id`,
    [tenantId, baseUrl, apiKey, keysJson, headersJson],
  );
  return ins.rows[0].id;
}

/**
 * Provision the platform-default channel for a tenant inside an existing
 * transaction.
 *
 * Behaviour:
 *   - If a recommended llmapi-wholesale channel already exists, return
 *     ok=true reason='exists' (no overwrite).
 *   - Else if PHASE2_AUTO_PROVISION=on, attempt /wholesale/purchase to
 *     mint a sk-relay-*; on success persist + phase='phase2'.
 *   - Else (default), copy the platform wsk-* and persist + phase='phase1'.
 *
 *   The purchase call itself goes OVER THE NETWORK to llmapi.pro and
 *   runs inside the DB transaction. If it fails (network / 402 /
 *   anything), we fall back to phase-1 with reason='phase2_fallback_<err>'
 *   so signup never blocks on the upstream debit.
 */
export async function provisionTenantUpstreamInTx(
  client: PoolClient,
  tenantId: number,
): Promise<ProvisionResult> {
  const baseUrl = config.upstreamBaseUrl;
  const apiKey = config.upstreamKey;

  if (!apiKey || apiKey.length === 0 || apiKey.startsWith('wsk-fake')) {
    return { ok: false, channel_id: null, reason: 'no_upstream_key_env' };
  }

  // Already provisioned?
  const dup = await client.query<{ id: number }>(
    `SELECT id FROM upstream_channel
       WHERE tenant_id = $1
         AND provider_type IN ('llmapi-wholesale','anthropic')
         AND is_recommended = TRUE
       LIMIT 1`,
    [tenantId],
  );
  if (dup.rows.length > 0) {
    return { ok: true, channel_id: dup.rows[0].id, reason: 'exists' };
  }

  // Phase-2 path — best effort, fall back to phase-1 on any failure.
  if (phase2Enabled()) {
    const purchase = await purchaseShadowSk({ tenantId });
    if (purchase.ok && purchase.sk) {
      const channelId = await upsertRecommendedChannel(
        client, tenantId, baseUrl, purchase.sk, 'phase2',
        {
          purchase_id: purchase.purchase_id,
          expires_at: purchase.expires_at ?? null,
          amount_cents: purchase.amount_cents,
        },
      );
      logger.info(
        {
          tenantId, channelId, baseUrl, phase: 'phase2',
          purchaseId: purchase.purchase_id,
          amountCents: purchase.amount_cents,
          remainingBalanceCents: purchase.remaining_balance_cents,
        },
        'signup-provisioner:phase2:created',
      );
      return { ok: true, channel_id: channelId, reason: 'phase2_purchased', phase: 'phase2' };
    }
    logger.warn(
      { tenantId, err: purchase.error, status: purchase.status },
      'signup-provisioner:phase2:fallback_to_phase1',
    );
    const fallbackReason = `phase2_fallback_${(purchase.error || 'unknown').slice(0, 32)}`;
    const channelId = await upsertRecommendedChannel(
      client, tenantId, baseUrl, apiKey, 'phase1',
    );
    return { ok: true, channel_id: channelId, reason: fallbackReason, phase: 'phase1' };
  }

  // Phase-1 (default): shared platform wsk-*.
  const channelId = await upsertRecommendedChannel(
    client, tenantId, baseUrl, apiKey, 'phase1',
  );
  logger.info({ tenantId, channelId, baseUrl, phase: 'phase1' }, 'signup-provisioner:phase1:created');
  return { ok: true, channel_id: channelId, reason: 'created', phase: 'phase1' };
}

/**
 * Manual upgrade — mint a per-tenant sk-relay-* for an *existing* tenant
 * and replace the recommended channel's api_key with it.
 *
 * Always attempts the purchase regardless of the env gate; the caller
 * (platform endpoint) is gated by PLATFORM_TOKEN.
 *
 * Idempotent only at the llmapi.pro layer (request_id is unique per
 * call here, so each invocation will spend). Callers should rate-limit.
 */
export async function upgradeTenantToShadowSk(
  client: PoolClient,
  tenantId: number,
  opts?: { plan?: string; cycle?: string },
): Promise<ProvisionResult & { purchase?: PurchaseShadowSkResult }> {
  const baseUrl = config.upstreamBaseUrl;
  const purchase = await purchaseShadowSk({
    tenantId, plan: opts?.plan, cycle: opts?.cycle,
  });
  if (!purchase.ok || !purchase.sk) {
    return {
      ok: false, channel_id: null,
      reason: `purchase_failed_${(purchase.error || 'unknown').slice(0, 64)}`,
      purchase,
    };
  }
  const channelId = await upsertRecommendedChannel(
    client, tenantId, baseUrl, purchase.sk, 'phase2',
    {
      purchase_id: purchase.purchase_id,
      expires_at: purchase.expires_at ?? null,
      amount_cents: purchase.amount_cents,
    },
  );
  logger.info(
    {
      tenantId, channelId, phase: 'phase2',
      purchaseId: purchase.purchase_id,
      amountCents: purchase.amount_cents,
    },
    'signup-provisioner:upgrade:phase2',
  );
  return {
    ok: true, channel_id: channelId, reason: 'upgraded_to_phase2', phase: 'phase2',
    purchase,
  };
}
