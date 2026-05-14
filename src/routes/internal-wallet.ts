/**
 * 3api side: internal endpoints called by llmapi.pro to read + debit a
 * reseller's wallet balance (so reseller can "pay" for their llmapi sub
 * using accumulated wallet money instead of Alipay).
 *
 *   GET  /api/internal/wallet-balance?llmapi_user_id=N
 *        Returns { ok, spendable_cents, currency } for the reseller bound
 *        to that llmapi_user_id (reseller_admin.llmapi_user_id).
 *
 *   POST /api/internal/wallet-debit
 *        Body: { llmapi_user_id, amount_cents, idempotency_key,
 *                llmapi_order_id, plan_slug, timestamp }
 *        Returns { ok, balance_after_cents }.
 *
 * Trust:
 *   - HMAC-SHA256 with app_config.internal_topup_secret (same secret used
 *     for the other direction)
 *   - IP allowlist via app_config.internal_topup_allowed_ips
 *   - Idempotency via wallet_transaction.idempotency_key UNIQUE
 */
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { getConfig } from '../services/app-config';
import { query, withTransaction } from '../services/database';
import { logger } from '../services/logger';
import { debitTopupLlmapi, getWallet } from '../services/wallet';

export const internalWalletRouter = Router();

function constantTimeEq(a: string, b: string): boolean {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function extractIp(req: Request): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined) || '';
  const first = xff.split(',')[0]?.trim();
  return first || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function checkAuth(req: Request, res: Response, rawBody: string): boolean {
  const secret = getConfig('internal_topup_secret', '');
  const allow = (getConfig('internal_topup_allowed_ips', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!secret) { res.status(503).json({ ok: false, error: 'internal endpoint not configured' }); return false; }

  const ip = extractIp(req);
  if (allow.length > 0 && !allow.includes(ip)) {
    logger.warn({ ip, allow }, 'internal_wallet:ip_denied');
    res.status(403).json({ ok: false, error: 'IP not allowlisted' });
    return false;
  }

  const sig = (req.headers['x-llmapi-signature'] as string | undefined) || '';
  if (!sig) { res.status(401).json({ ok: false, error: 'missing signature' }); return false; }
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (!constantTimeEq(sig, expected)) {
    logger.warn({ ip }, 'internal_wallet:bad_signature');
    res.status(401).json({ ok: false, error: 'bad signature' });
    return false;
  }
  return true;
}

async function findTenantByLlmapiUser(llmapiUserId: number): Promise<{ tenantId: number; adminId: number } | null> {
  const rows = await query<{ id: number; tenant_id: number }>(
    `SELECT id, tenant_id FROM reseller_admin
      WHERE llmapi_user_id = $1 AND status = 'active'
      ORDER BY id ASC LIMIT 1`,
    [llmapiUserId],
  );
  if (rows.length === 0) return null;
  return { tenantId: rows[0].tenant_id, adminId: rows[0].id };
}

/**
 * GET /api/internal/wallet-balance — uses query-string params; signature
 * is over the canonical sorted query string (excluding 'sig' itself).
 */
internalWalletRouter.get('/wallet-balance', async (req: Request, res: Response): Promise<void> => {
  // Canonicalize query string for signature
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'sig') continue;
    if (typeof v === 'string') params[k] = v;
  }
  const canonical = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  // Replace rawBody with canonical query for verification
  const rebuiltReq = { ...req, headers: { ...req.headers, 'x-llmapi-signature': req.query.sig || req.headers['x-llmapi-signature'] || '' } } as any;
  if (!checkAuth(rebuiltReq, res, canonical)) return;

  const llmapiUserId = parseInt(String(req.query.llmapi_user_id || ''), 10);
  if (!llmapiUserId) { res.status(400).json({ ok: false, error: 'llmapi_user_id required' }); return; }

  const link = await findTenantByLlmapiUser(llmapiUserId);
  if (!link) {
    res.json({ ok: true, linked: false, spendable_cents: 0, currency: 'CNY' });
    return;
  }
  const wallet = await getWallet(link.tenantId);
  res.json({
    ok: true,
    linked: true,
    tenant_id: link.tenantId,
    spendable_cents: Math.max(0, wallet.balance_cents - wallet.locked_cents),
    balance_cents: wallet.balance_cents,
    locked_cents: wallet.locked_cents,
    currency: wallet.currency,
  });
});

/**
 * POST /api/internal/wallet-debit — debit the reseller's wallet by
 * amount_cents and return ok. Used by llmapi when user picks "钱包余额支付"
 * for a sub purchase. idempotency_key MUST be tied to llmapi_order_id so
 * a duplicate webhook can't double-debit.
 */
internalWalletRouter.post('/wallet-debit', async (req: Request, res: Response): Promise<void> => {
  const raw = JSON.stringify(req.body);
  if (!checkAuth(req, res, raw)) return;

  const { llmapi_user_id, amount_cents, idempotency_key, llmapi_order_id, plan_slug, timestamp } = req.body as any;
  if (!llmapi_user_id || !amount_cents || !idempotency_key) {
    res.status(400).json({ ok: false, error: 'missing fields' });
    return;
  }
  if (typeof amount_cents !== 'number' || amount_cents <= 0 || amount_cents > 1_000_000_00) {
    res.status(400).json({ ok: false, error: 'amount_cents out of range' });
    return;
  }
  if (typeof timestamp === 'number' && Math.abs(Date.now() - timestamp) > 300_000) {
    res.status(400).json({ ok: false, error: 'timestamp drift > 5min' });
    return;
  }

  const link = await findTenantByLlmapiUser(llmapi_user_id);
  if (!link) {
    res.status(404).json({ ok: false, error: 'no_tenant_for_user — open the 3api dashboard module first to provision' });
    return;
  }

  const wallet = await getWallet(link.tenantId);
  const spendable = wallet.balance_cents - wallet.locked_cents;
  if (spendable < amount_cents) {
    res.status(402).json({ ok: false, error: 'insufficient_balance', spendable_cents: spendable });
    return;
  }

  try {
    // We reuse debitTopupLlmapi semantics — same idempotent debit shape.
    // The idempotency_key is provided by llmapi (tied to its order_id) so a
    // duplicate webhook returns the prior result without double-debiting.
    await withTransaction(async (client) => {
      // Direct INSERT to wallet_transaction with the llmapi idempotency_key.
      const dup = await client.query<{ id: number }>(
        `SELECT id FROM wallet_transaction
          WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [link.tenantId, idempotency_key],
      );
      if (dup.rows.length > 0) {
        logger.info({ idempotency_key }, 'wallet-debit:idempotent_hit');
        return;
      }
      // Lock balance row + check spendable again under lock.
      const balRow = await client.query<any>(
        `SELECT balance_cents, locked_cents FROM wallet_balance WHERE tenant_id = $1 FOR UPDATE`,
        [link.tenantId],
      );
      const bal = balRow.rows[0];
      const sp = bal.balance_cents - bal.locked_cents;
      if (sp < amount_cents) throw Object.assign(new Error('insufficient'), { code: 'INSUFFICIENT' });
      await client.query(
        `INSERT INTO wallet_transaction
           (tenant_id, delta_cents, type, idempotency_key, reference, note, created_by, ip)
         VALUES ($1, $2, 'topup_llmapi', $3, $4, $5, 'llmapi-checkout', $6)`,
        [
          link.tenantId, -amount_cents, idempotency_key,
          llmapi_order_id ? String(llmapi_order_id) : null,
          `llmapi sub purchase via wallet (plan=${plan_slug || '?'})`,
          extractIp(req),
        ],
      );
      await client.query(
        `UPDATE wallet_balance
            SET balance_cents = balance_cents - $2, updated_at = now()
          WHERE tenant_id = $1`,
        [link.tenantId, amount_cents],
      );
    });
  } catch (err: any) {
    if (err.code === 'INSUFFICIENT') {
      res.status(402).json({ ok: false, error: 'insufficient_balance' });
      return;
    }
    logger.error({ err: err.message, llmapi_user_id, amount_cents }, 'wallet-debit:fail');
    res.status(500).json({ ok: false, error: err.message });
    return;
  }

  const after = await getWallet(link.tenantId);
  logger.info({ llmapi_user_id, tenant_id: link.tenantId, amount_cents, idempotency_key }, 'wallet-debit:ok');
  res.json({ ok: true, balance_after_cents: after.balance_cents - after.locked_cents });
});
