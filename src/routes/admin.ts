/**
 * Reseller admin routes — manage end-users, tokens, redemption codes,
 * view usage stats. All require authAdmin middleware.
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../services/database';
import { hashPassword } from '../services/auth';
import { logger } from '../services/logger';
import { channelsRouter } from "./admin-channels";
import { adminPlansRouter } from "./admin/plans";
import { adminWholesaleRouter } from "./admin/wholesale";
import { adminExtrasRouter } from "./admin/extras";

export const adminRouter = Router();

// /admin/channels/* — upstream-channel CRUD (BYOK)
adminRouter.use('/channels', channelsRouter);
adminRouter.use('/plans', adminPlansRouter);
adminRouter.use('/wholesale', adminWholesaleRouter);
// Extras (me / brand / orders / refund / stats / change-password / payment-config).
// Mounted BEFORE the legacy '/me' below so the richer payload wins.
adminRouter.use('/', adminExtrasRouter);

// =============== End users ===============

/**
 * GET /admin/end-users?limit=50&offset=0&q=search
 */
adminRouter.get('/end-users', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
  const q = String(req.query.q ?? '').trim();

  const params: any[] = [tenantId];
  let where = `tenant_id = $1`;
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (LOWER(email) LIKE $${params.length} OR LOWER(display_name) LIKE $${params.length})`;
  }
  params.push(limit);
  params.push(offset);

  const rows = await query<any>(
    `SELECT id, email, display_name, group_name, quota_cents, used_quota_cents, status, created_at
       FROM end_user
      WHERE ${where}
      ORDER BY id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json({ data: rows, limit, offset });
});

/**
 * POST /admin/end-users
 * Body: { email, password, display_name?, initial_quota_cents?, group_name? }
 */
adminRouter.post('/end-users', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const { email, password, display_name, initial_quota_cents, group_name } = req.body ?? {};

  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Valid email required' } });
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Password must be ≥6 chars' } });
    return;
  }
  const initialQuota = Number(initial_quota_cents ?? 0);

  try {
    const hash = await hashPassword(password);
    const affCode = crypto.randomBytes(8).toString('hex');
    const rows = await query<{ id: number }>(
      `INSERT INTO end_user
         (tenant_id, email, password_hash, display_name, group_name, quota_cents, aff_code, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING id`,
      [tenantId, email.toLowerCase(), hash, display_name ?? null, group_name ?? 'default', initialQuota, affCode],
    );
    res.status(201).json({ id: rows[0].id, email, aff_code: affCode, initial_quota_cents: initialQuota });
  } catch (err: any) {
    if (err.message?.includes('duplicate key')) {
      res.status(409).json({ error: { type: 'conflict', message: 'email already exists in this tenant' } });
      return;
    }
    logger.error({ err: err.message }, 'admin:end-user:create:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * POST /admin/end-users/:id/topup
 * Body: { amount_cents, note? }
 */
adminRouter.post('/end-users/:id/topup', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const userId = parseInt(req.params.id, 10);
  const amount = Number(req.body?.amount_cents);
  if (!userId || !amount || amount <= 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Positive amount_cents required' } });
    return;
  }

  const rows = await query<any>(
    `UPDATE end_user
        SET quota_cents = quota_cents + $1
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, quota_cents, used_quota_cents`,
    [amount, userId, tenantId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'end_user not found' } });
    return;
  }
  logger.info({ userId, amount, adminId: req.resellerAdmin!.id }, 'admin:topup');
  res.json({ id: rows[0].id, new_quota_cents: Number(rows[0].quota_cents), used_quota_cents: Number(rows[0].used_quota_cents) });
});

/**
 * POST /admin/end-users/:id/suspend  /  POST /admin/end-users/:id/activate
 */
adminRouter.post('/end-users/:id/suspend', async (req, res) => setStatus(req, res, 'suspended'));
adminRouter.post('/end-users/:id/activate', async (req, res) => setStatus(req, res, 'active'));

async function setStatus(req: Request, res: Response, status: string): Promise<void> {
  const tenantId = req.resellerAdmin!.tenantId;
  const userId = parseInt(req.params.id, 10);
  const rows = await query<any>(
    `UPDATE end_user SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, status`,
    [status, userId, tenantId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'end_user not found' } });
    return;
  }
  res.json(rows[0]);
}

// =============== Tokens ===============

/**
 * POST /admin/end-users/:id/tokens
 * Body: { name?, remain_quota_cents?, unlimited_quota?, allowed_models?, expires_at? }
 * Returns: { id, key, key_prefix }   (raw key returned ONCE)
 */
adminRouter.post('/end-users/:id/tokens', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const userId = parseInt(req.params.id, 10);

  const userRows = await query<any>(
    `SELECT id FROM end_user WHERE id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
    [userId, tenantId],
  );
  if (userRows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'end_user not found or suspended' } });
    return;
  }

  const rawKey = `sk-relay-${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.substring(0, 16);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { name, remain_quota_cents, unlimited_quota, allowed_models, expires_at } = req.body ?? {};

  const rows = await query<{ id: number }>(
    `INSERT INTO end_token
       (tenant_id, end_user_id, name, key_prefix, key_hash,
        remain_quota_cents, unlimited_quota, allowed_models, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
     RETURNING id`,
    [
      tenantId,
      userId,
      name ?? 'Default',
      keyPrefix,
      keyHash,
      Number(remain_quota_cents ?? 0),
      !!unlimited_quota,
      Array.isArray(allowed_models) ? JSON.stringify(allowed_models) : null,
      expires_at ?? null,
    ],
  );

  res.status(201).json({ id: rows[0].id, key: rawKey, key_prefix: keyPrefix });
});

/**
 * GET /admin/end-users/:id/tokens
 */
adminRouter.get('/end-users/:id/tokens', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const userId = parseInt(req.params.id, 10);
  const rows = await query<any>(
    `SELECT id, name, key_prefix, status, remain_quota_cents, unlimited_quota,
            used_quota_cents, last_used_at, expires_at, created_at
       FROM end_token
      WHERE tenant_id = $1 AND end_user_id = $2
      ORDER BY id DESC`,
    [tenantId, userId],
  );
  res.json({ data: rows });
});

/**
 * POST /admin/tokens/:id/revoke
 */
adminRouter.post('/tokens/:id/revoke', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const tokenId = parseInt(req.params.id, 10);
  const rows = await query<any>(
    `UPDATE end_token SET status = 'revoked' WHERE id = $1 AND tenant_id = $2 RETURNING id, status`,
    [tokenId, tenantId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'token not found' } });
    return;
  }
  res.json(rows[0]);
});

// =============== Redemption codes ===============

/**
 * POST /admin/redemption  Body: { quota_cents, count?, expires_at?, prefix? }
 * Generates `count` codes (default 1).
 */
adminRouter.post('/redemption', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const quota = Number(req.body?.quota_cents);
  const count = Math.min(Math.max(parseInt(String(req.body?.count ?? '1'), 10), 1), 1000);
  const expires_at = req.body?.expires_at ?? null;
  const prefix = (req.body?.prefix ?? '').toString().slice(0, 16);

  if (!quota || quota <= 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Positive quota_cents required' } });
    return;
  }

  const codes: string[] = [];
  await withTransaction(async (client) => {
    for (let i = 0; i < count; i++) {
      const code = `${prefix}${crypto.randomBytes(12).toString('hex')}`.slice(0, 64);
      await client.query(
        `INSERT INTO redemption (tenant_id, code, quota_cents, expires_at) VALUES ($1, $2, $3, $4)`,
        [tenantId, code, quota, expires_at],
      );
      codes.push(code);
    }
  });

  res.status(201).json({ count: codes.length, codes, quota_cents_each: quota });
});

/**
 * GET /admin/redemption?status=unused&limit=100
 */
adminRouter.get('/redemption', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const status = String(req.query.status ?? 'unused');
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10), 500);
  const rows = await query<any>(
    `SELECT id, code, quota_cents, status, redeemed_by, redeemed_at, expires_at, created_at
       FROM redemption
      WHERE tenant_id = $1 AND status = $2
      ORDER BY id DESC LIMIT $3`,
    [tenantId, status, limit],
  );
  res.json({ data: rows });
});

// =============== Usage / stats ===============

/**
 * GET /admin/usage/summary?days=7
 */
adminRouter.get('/usage/summary', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10), 1), 90);

  const rows = await query<any>(
    `SELECT DATE(created_at) AS day,
            COUNT(*) AS reqs,
            SUM(prompt_tokens)::bigint AS prompt_tokens,
            SUM(completion_tokens)::bigint AS completion_tokens,
            SUM(quota_charged_cents)::bigint AS revenue_cents
       FROM usage_log
      WHERE tenant_id = $1
        AND created_at > NOW() - ($2::int || ' days')::interval
      GROUP BY 1
      ORDER BY 1 DESC`,
    [tenantId, days],
  );
  res.json({ data: rows, days });
});

/**
 * GET /admin/me
 */
adminRouter.get('/me', (req: Request, res: Response) => {
  res.json(req.resellerAdmin);
});
