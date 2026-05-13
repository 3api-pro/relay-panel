/**
 * sso-llmapi — verify a cross-system SSO token issued by llmapi.pro, then
 * find-or-create a reseller_admin + tenant + upstream_channel so the user
 * lands in /admin with the panel already wired to their llmapi subscription.
 *
 * Trust model:
 *   - HMAC-SHA256, shared secret in BOTH llmapi.app_config and
 *     3api.app_config under `sso_shared_secret`. Rotation: rotate both
 *     atomically (poll refresh 5 min).
 *   - aud='3api', iss='llmapi'
 *   - 5min TTL (exp claim)
 *   - one-time nonce, INSERT-on-consume guards replay
 *
 * Payload shape:
 *   { iss:'llmapi', aud:'3api', iat, exp, nonce, user_id, email,
 *     sub_id, plan_name, sk }
 *
 *   sk is a freshly-minted sk-relay-* api_key that llmapi has registered
 *   to the reseller's account. The panel persists this in upstream_channel
 *   so all relay traffic from this tenant authenticates as that reseller.
 *
 * Side effects on successful verify (all in one transaction):
 *   1. INSERT sso_nonces (rejects replay)
 *   2. find-or-create reseller_admin (by email, lowest tenant_id wins)
 *   3. find-or-create tenant (auto slug)
 *   4. seed plans @ 2x markup + brand_config + wholesale_balance
 *   5. upsert upstream_channel (provider_type='llmapi-sub', is_recommended)
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './database';
import { getConfig } from './app-config';
import { logger } from './logger';
import { createAdminForTenant } from './auth';
import {
  seedPlansForTenant,
  seedBrandConfigForTenant,
  ensureWholesaleBalance,
} from './plans-seed';

export interface LlmapiSsoClaims {
  iss: 'llmapi';
  aud: '3api';
  iat: number;
  exp: number;
  nonce: string;
  user_id: number;
  email: string;
  sub_id: number | null;
  plan_name: string | null;
  sk: string;
}

export class SsoTokenError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  return Buffer.from(s + '='.repeat(pad), 'base64');
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Parse + HMAC-verify the JWT. Throws SsoTokenError on any defect.
 */
export function verifySsoToken(token: string): LlmapiSsoClaims {
  const secret = getConfig('sso_shared_secret', '');
  if (!secret) throw new SsoTokenError('not_configured', 'SSO shared secret not configured');

  const parts = token.split('.');
  if (parts.length !== 3) throw new SsoTokenError('malformed', 'token must have 3 parts');

  const [h, p, s] = parts;
  const sig = b64urlDecode(s);
  const want = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest();
  if (!constantTimeEqual(sig, want)) {
    throw new SsoTokenError('bad_signature', 'signature mismatch');
  }

  let header: any;
  let payload: any;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new SsoTokenError('malformed', 'json parse failed');
  }

  if (header.alg !== 'HS256') throw new SsoTokenError('bad_alg', `alg must be HS256, got ${header.alg}`);
  if (payload.iss !== 'llmapi') throw new SsoTokenError('bad_iss', 'iss must be llmapi');
  if (payload.aud !== '3api') throw new SsoTokenError('bad_aud', 'aud must be 3api');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new SsoTokenError('expired', 'token expired');
  }
  // Optional iat sanity: must be in the past (clock skew tolerated 60s)
  if (typeof payload.iat === 'number' && payload.iat > now + 60) {
    throw new SsoTokenError('bad_iat', 'iat in future');
  }
  if (typeof payload.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(payload.nonce)) {
    throw new SsoTokenError('bad_nonce', 'nonce must be 64-hex');
  }
  if (typeof payload.user_id !== 'number' || typeof payload.email !== 'string') {
    throw new SsoTokenError('bad_payload', 'user_id/email missing');
  }
  if (typeof payload.sk !== 'string' || !payload.sk.startsWith('sk-')) {
    throw new SsoTokenError('bad_sk', 'sk must be sk-* prefix');
  }
  return payload as LlmapiSsoClaims;
}

/**
 * Consume the nonce; rejects if already seen (PK conflict).
 */
async function consumeNonce(client: PoolClient, nonce: string): Promise<void> {
  try {
    await client.query(
      `INSERT INTO sso_nonces (nonce, source) VALUES ($1, 'llmapi')`,
      [nonce],
    );
  } catch (err: any) {
    if (String(err.code) === '23505') {
      throw new SsoTokenError('replay', 'nonce already consumed');
    }
    throw err;
  }
}

/**
 * Find-or-create reseller_admin (by email, lowest tenant_id wins).
 * If admin exists in any tenant under this email, return it; otherwise
 * create a fresh tenant + admin + seed + upstream.
 */
async function findOrCreateAdminAndTenant(
  client: PoolClient,
  email: string,
  displayName: string | null,
): Promise<{ adminId: number; tenantId: number; tenantSlug: string; fresh: boolean }> {
  const existing = await client.query<{ id: number; tenant_id: number }>(
    `SELECT id, tenant_id FROM reseller_admin
      WHERE LOWER(email) = LOWER($1) AND status = 'active'
      ORDER BY id ASC LIMIT 1`,
    [email],
  );
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    const tenant = await client.query<{ slug: string }>(
      `SELECT slug FROM tenant WHERE id = $1`,
      [r.tenant_id],
    );
    return { adminId: r.id, tenantId: r.tenant_id, tenantSlug: tenant.rows[0]?.slug ?? '', fresh: false };
  }

  // Fresh — generate slug, create tenant + admin.
  const slug = await generateLlmapiSlug(client);
  const t = await client.query<{ id: number; slug: string }>(
    `INSERT INTO tenant (slug, status) VALUES ($1, 'active') RETURNING id, slug`,
    [slug],
  );
  const tenant = t.rows[0];
  const randomPwd = crypto.randomBytes(32).toString('hex');
  const adminId = await createAdminForTenant(
    client,
    tenant.id,
    email,
    randomPwd,
    displayName,
  );
  // Seed plans (2x markup), brand, wholesale balance
  await seedPlansForTenant(client, tenant.id);
  await seedBrandConfigForTenant(client, tenant.id, tenant.slug);
  await ensureWholesaleBalance(client, tenant.id, 0);
  return { adminId, tenantId: tenant.id, tenantSlug: tenant.slug, fresh: true };
}

const ADJ = ['swift', 'bright', 'calm', 'clever', 'bold', 'crisp', 'cozy', 'fair', 'kind', 'lucky'];
const NOUN = ['fox', 'owl', 'cat', 'crab', 'eagle', 'fern', 'glade', 'harbor', 'pine', 'wren'];

async function generateLlmapiSlug(client: PoolClient): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const a = ADJ[Math.floor(Math.random() * ADJ.length)];
    const n = NOUN[Math.floor(Math.random() * NOUN.length)];
    const tail = Math.random().toString(36).slice(2, 6);
    const cand = `${a}-${n}-${tail}`;
    const dup = await client.query<{ id: number }>(
      `SELECT id FROM tenant WHERE slug = $1`,
      [cand],
    );
    if (dup.rows.length === 0) return cand;
  }
  return 'llmapi-' + Math.random().toString(36).slice(2, 12);
}

/**
 * Upsert upstream_channel pointing to the llmapi sk-key. Idempotent on
 * provider_type='llmapi-sub' per tenant: updates api_key if it changed
 * (e.g. user rotated the key on llmapi side).
 */
async function upsertLlmapiUpstream(
  client: PoolClient,
  tenantId: number,
  skKey: string,
  llmapiUserId: number,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const baseUrl = 'https://api.llmapi.pro/v1';
  const keysJson = JSON.stringify([{
    key: skKey,
    status: 'active',
    added_at: nowIso,
    cooled_until: null,
    last_error: null,
  }]);
  const headersJson = JSON.stringify({
    'X-3api-Provision': 'sso-llmapi',
    'X-3api-Llmapi-User-Id': String(llmapiUserId),
  });

  // Try update first
  const upd = await client.query<{ id: number }>(
    `UPDATE upstream_channel
        SET api_key = $2,
            keys = $3::jsonb,
            custom_headers = $4::jsonb,
            base_url = $5,
            status = 'active',
            enabled = TRUE,
            is_recommended = TRUE,
            is_default = TRUE
      WHERE tenant_id = $1
        AND provider_type IN ('llmapi-sub','llmapi-wholesale','anthropic')
        AND is_recommended = TRUE
      RETURNING id`,
    [tenantId, skKey, keysJson, headersJson, baseUrl],
  );
  if (upd.rows.length > 0) return upd.rows[0].id;

  const ins = await client.query<{ id: number }>(
    `INSERT INTO upstream_channel
       (tenant_id, name, base_url, api_key, type, provider_type,
        status, weight, models, model_mapping, group_access,
        keys, current_key_idx, custom_headers, enabled, is_recommended,
        is_default, priority)
     VALUES
       ($1, 'llmapi.pro (从你的订阅)', $2, $3, 'wholesale-3api', 'llmapi-sub',
        'active', 100, NULL, NULL, 'default',
        $4::jsonb, 0, $5::jsonb, TRUE, TRUE,
        TRUE, 1)
     RETURNING id`,
    [tenantId, baseUrl, skKey, keysJson, headersJson],
  );
  return ins.rows[0].id;
}

export interface SsoConsumeResult {
  adminId: number;
  tenantId: number;
  tenantSlug: string;
  channelId: number;
  fresh: boolean;
}

/**
 * Atomically consume the verified token: nonce-lock + provision tenant
 * + upsert upstream + update reseller_admin.llmapi_user_id link.
 */
export async function consumeLlmapiSsoToken(
  claims: LlmapiSsoClaims,
): Promise<SsoConsumeResult> {
  return withTransaction(async (client) => {
    await consumeNonce(client, claims.nonce);
    const { adminId, tenantId, tenantSlug, fresh } = await findOrCreateAdminAndTenant(
      client,
      claims.email,
      null,
    );
    // Mark linkage on reseller_admin for future analytics (skip if column absent — soft).
    try {
      await client.query(
        `UPDATE reseller_admin SET llmapi_user_id = $1 WHERE id = $2 AND (llmapi_user_id IS NULL OR llmapi_user_id <> $1)`,
        [claims.user_id, adminId],
      );
    } catch {
      // column may not exist on older deployments — non-blocking
    }
    const channelId = await upsertLlmapiUpstream(client, tenantId, claims.sk, claims.user_id);
    logger.info(
      {
        adminId,
        tenantId,
        tenantSlug,
        channelId,
        llmapi_user_id: claims.user_id,
        fresh,
        plan: claims.plan_name,
      },
      'sso:llmapi:consumed',
    );
    return { adminId, tenantId, tenantSlug, channelId, fresh };
  });
}
