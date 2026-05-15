import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../services/database';
import { logger } from '../services/logger';

/**
 * Authenticate /v1/* requests using sk-* Bearer or x-api-key header.
 * Validates the end_token and end_user for the current tenant.
 */
export async function authToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.tenantId) {
      res.status(500).json({ error: { type: 'internal_error', message: 'tenant not resolved' } });
      return;
    }

    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        error: {
          type: 'authentication_error',
          message: 'Missing API key. Use Authorization: Bearer or x-api-key header.',
        },
      });
      return;
    }

    const keyPrefix = apiKey.substring(0, 16);
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const tokens = await query<any>(
      `SELECT t.*, u.email, u.group_name, u.quota_cents, u.used_quota_cents,
              s.id AS subscription_id,
              s.remaining_tokens AS sub_remaining_tokens,
              s.expires_at AS sub_expires_at,
              s.status AS sub_status,
              s.plan_id AS sub_plan_id
         FROM end_token t
         JOIN end_user u ON u.id = t.end_user_id AND u.tenant_id = t.tenant_id
         LEFT JOIN subscription s ON s.id = t.subscription_id
        WHERE t.tenant_id = $1
          AND t.key_prefix = $2
          AND t.key_hash = $3
          AND t.status = 'active'
          AND u.status = 'active'
        LIMIT 1`,
      [req.tenantId, keyPrefix, keyHash],
    );

    if (tokens.length === 0) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
      return;
    }
    const tok = tokens[0];

    if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'API key expired' } });
      return;
    }

    // Subscription-bound token: check remaining_tokens + expiry.
    // Legacy token (no subscription_id): fall back to cents-based check.
    //
    // v0.3 dual-billing: a token may be minted against a (now-empty)
    // monthly subscription while the user also holds a non-empty token
    // pack. So the pre-debit gate sums remaining_tokens across ALL active
    // non-expired subs for the end_user instead of inspecting only the
    // bound row. Debit logic in order-engine.recordUsage walks the same
    // set FIFO-by-expiry.
    if (tok.subscription_id) {
      const aggRow = await query<{ total_remaining: string; any_active: string }>(
        `SELECT COALESCE(SUM(remaining_tokens), 0)::text AS total_remaining,
                COUNT(*)::text AS any_active
           FROM subscription
          WHERE tenant_id = $1
            AND end_user_id = $2
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > NOW())
            AND remaining_tokens > 0`,
        [req.tenantId, tok.end_user_id],
      );
      const totalRemaining = Number(aggRow[0]?.total_remaining ?? 0);
      const anyActive = Number(aggRow[0]?.any_active ?? 0);
      if (anyActive === 0 || totalRemaining <= 0) {
        res.status(402).json({
          error: { type: 'insufficient_quota', message: 'No active subscription or token pack with remaining quota' },
        });
        return;
      }
    } else if (!tok.unlimited_quota) {
      // Legacy cents-based token, not unlimited: both token-level and
      // account-level quotas must be positive. Unlimited tokens (admin-minted
      // free passes / test handouts) bypass both — they were authored exactly
      // so the holder doesn't get blocked by the end_user's empty balance.
      if (Number(tok.remain_quota_cents) <= 0) {
        res.status(402).json({
          error: { type: 'insufficient_quota', message: 'Token quota exhausted' },
        });
        return;
      }
      if (Number(tok.quota_cents) - Number(tok.used_quota_cents) <= 0) {
        res.status(402).json({
          error: { type: 'insufficient_quota', message: 'Account balance exhausted' },
        });
        return;
      }
    }

    req.endToken = {
      id: tok.id,
      tenantId: tok.tenant_id,
      endUserId: tok.end_user_id,
      remainQuotaCents: Number(tok.remain_quota_cents),
      unlimitedQuota: !!tok.unlimited_quota,
      allowedModels: parseAllowedModels(tok.allowed_models),
      subscriptionId: tok.subscription_id ?? null,
      subscriptionRemainingTokens: tok.subscription_id ? Number(tok.sub_remaining_tokens ?? 0) : null,
    };
    req.endUser = {
      id: tok.end_user_id,
      tenantId: tok.tenant_id,
      email: tok.email,
      groupName: tok.group_name,
      quotaCents: Number(tok.quota_cents),
      usedQuotaCents: Number(tok.used_quota_cents),
    };

    next();
  } catch (err: any) {
    logger.error({ err: err.message }, 'auth-token:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
}

function extractApiKey(req: Request): string | null {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.length > 0) return x;
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return null;
}

function parseAllowedModels(raw: any): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // CSV fallback
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return null;
}
