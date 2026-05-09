/**
 * Customer (end-user) routes — self-service: view balance, manage tokens,
 * redeem codes, view usage.
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../services/database';
import { logger } from '../services/logger';

export const customerRouter = Router();

/** GET /customer/me */
customerRouter.get('/me', (req: Request, res: Response) => {
  res.json({
    ...req.endUser,
    remain_cents: req.endUser!.quotaCents - req.endUser!.usedQuotaCents,
  });
});

/** GET /customer/tokens — own tokens */
customerRouter.get('/tokens', async (req: Request, res: Response) => {
  const u = req.endUser!;
  const rows = await query<any>(
    `SELECT id, name, key_prefix, status, remain_quota_cents, unlimited_quota,
            used_quota_cents, last_used_at, expires_at, created_at
       FROM end_token
      WHERE tenant_id = $1 AND end_user_id = $2
      ORDER BY id DESC`,
    [u.tenantId, u.id],
  );
  res.json({ data: rows });
});

/** POST /customer/tokens  Body: { name?, remain_quota_cents?, unlimited_quota?, expires_at? } */
customerRouter.post('/tokens', async (req: Request, res: Response) => {
  const u = req.endUser!;
  const { name, remain_quota_cents, unlimited_quota, expires_at } = req.body ?? {};

  // Cap: unlimited token only if user has remaining balance > 0; else require explicit cap
  const wantUnlimited = !!unlimited_quota;
  const remain = Number(remain_quota_cents ?? 0);

  const rawKey = `sk-relay-${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.substring(0, 16);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const rows = await query<{ id: number }>(
    `INSERT INTO end_token
       (tenant_id, end_user_id, name, key_prefix, key_hash,
        remain_quota_cents, unlimited_quota, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING id`,
    [u.tenantId, u.id, name ?? 'Default', keyPrefix, keyHash, remain, wantUnlimited, expires_at ?? null],
  );
  res.status(201).json({ id: rows[0].id, key: rawKey, key_prefix: keyPrefix });
});

/** POST /customer/tokens/:id/revoke */
customerRouter.post('/tokens/:id/revoke', async (req: Request, res: Response) => {
  const u = req.endUser!;
  const tokenId = parseInt(req.params.id, 10);
  const rows = await query<any>(
    `UPDATE end_token SET status = 'revoked'
      WHERE id = $1 AND tenant_id = $2 AND end_user_id = $3
      RETURNING id, status`,
    [tokenId, u.tenantId, u.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'token not found' } });
    return;
  }
  res.json(rows[0]);
});

/** POST /customer/redeem  Body: { code } */
customerRouter.post('/redeem', async (req: Request, res: Response) => {
  const u = req.endUser!;
  const code = String(req.body?.code ?? '').trim();
  if (!code) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'code required' } });
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      const codeRows = await client.query<any>(
        `SELECT id, quota_cents, status, expires_at
           FROM redemption
          WHERE tenant_id = $1 AND code = $2 FOR UPDATE`,
        [u.tenantId, code],
      );
      if (codeRows.rows.length === 0) {
        throw new Error('not_found');
      }
      const r = codeRows.rows[0];
      if (r.status !== 'unused') throw new Error('already_used');
      if (r.expires_at && new Date(r.expires_at) < new Date()) throw new Error('expired');

      await client.query(
        `UPDATE redemption SET status = 'used', redeemed_by = $1, redeemed_at = NOW() WHERE id = $2`,
        [u.id, r.id],
      );
      await client.query(
        `UPDATE end_user SET quota_cents = quota_cents + $1 WHERE id = $2`,
        [r.quota_cents, u.id],
      );
      return { added_cents: Number(r.quota_cents) };
    });

    logger.info({ userId: u.id, code: code.slice(0, 8) + '***', added: result.added_cents }, 'customer:redeem');
    res.json(result);
  } catch (err: any) {
    if (err.message === 'not_found') {
      res.status(404).json({ error: { type: 'not_found', message: 'Code not found' } });
    } else if (err.message === 'already_used') {
      res.status(409).json({ error: { type: 'conflict', message: 'Code already used' } });
    } else if (err.message === 'expired') {
      res.status(410).json({ error: { type: 'expired', message: 'Code expired' } });
    } else {
      logger.error({ err: err.message }, 'customer:redeem:error');
      res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
    }
  }
});

/** GET /customer/usage?days=7 */
customerRouter.get('/usage', async (req: Request, res: Response) => {
  const u = req.endUser!;
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10), 1), 90);
  const rows = await query<any>(
    `SELECT DATE(created_at) AS day,
            COUNT(*) AS reqs,
            SUM(prompt_tokens)::bigint AS prompt_tokens,
            SUM(completion_tokens)::bigint AS completion_tokens,
            SUM(quota_charged_cents)::bigint AS spend_cents
       FROM usage_log
      WHERE tenant_id = $1 AND end_user_id = $2
        AND created_at > NOW() - ($3::int || ' days')::interval
      GROUP BY 1 ORDER BY 1 DESC`,
    [u.tenantId, u.id, days],
  );
  res.json({ data: rows, days });
});
