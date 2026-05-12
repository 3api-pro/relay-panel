/**
 * signup-provisioner — provision an out-of-the-box upstream channel for a
 * freshly-signed-up tenant, so the new admin can hit /v1/messages
 * immediately without first sourcing a wholesale sk- or BYOK key.
 *
 * Strategy (carry-over #18):
 *
 *   We do NOT call llmapi.pro's /v1/wholesale/purchase here — that would
 *   debit the platform's wholesale balance for every spam signup. Instead
 *   we copy the platform's *default* UPSTREAM_KEY (from env) into a per-tenant
 *   row with type=wholesale-3api / provider_type=llmapi-wholesale /
 *   is_recommended=true. The tenant's storefront shows it as the
 *   "recommended" channel; resellers immediately have a working upstream
 *   even though the actual sk-* is shared with the platform until the
 *   admin runs /admin/wholesale-purchase to mint their own.
 *
 *   This is a deliberate Phase-1 trade-off: we burn a little of the
 *   shared platform balance on probe/onboarding traffic in exchange for
 *   zero-friction signup. Phase-2 (deferred) would call llmapi.pro for
 *   a real per-tenant sk-* and persist it instead.
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
}

/**
 * Provision the platform-default channel for a tenant.
 *
 * Pass a PoolClient if you want this to participate in the signup
 * transaction; otherwise call provisionTenantUpstream which acquires its
 * own client.
 */
export async function provisionTenantUpstreamInTx(
  client: PoolClient,
  tenantId: number,
): Promise<ProvisionResult> {
  const baseUrl = config.upstreamBaseUrl;
  const apiKey = config.upstreamKey;

  // Nothing to provision against — the operator has not set UPSTREAM_KEY
  // on this deployment. Don't insert a placeholder; the admin can BYOK.
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

  const nowIso = new Date().toISOString();
  const keysJson = JSON.stringify([{
    key: apiKey,
    status: 'active',
    added_at: nowIso,
    cooled_until: null,
    last_error: null,
  }]);

  const ins = await client.query<{ id: number }>(
    `INSERT INTO upstream_channel
       (tenant_id, name, base_url, api_key, type, provider_type,
        status, weight, models, model_mapping, group_access,
        keys, current_key_idx, custom_headers, enabled, is_recommended,
        is_default, priority)
     VALUES
       ($1, 'Recommended (llmapi.pro)', $2, $3, 'wholesale-3api', 'llmapi-wholesale',
        'active', 100, NULL, NULL, 'default',
        $4::jsonb, 0, '{}'::jsonb, TRUE, TRUE,
        TRUE, 1)
     RETURNING id`,
    [tenantId, baseUrl, apiKey, keysJson],
  );
  const channelId = ins.rows[0].id;
  logger.info({ tenantId, channelId, baseUrl }, 'signup-provisioner:created');
  return { ok: true, channel_id: channelId, reason: 'created' };
}
