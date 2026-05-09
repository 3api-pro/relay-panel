import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../services/database';
import { hashPassword, verifyPassword } from '../services/auth';
import { signSession } from '../services/jwt';
import { logger } from '../services/logger';

export const customerAuthRouter = Router();

/**
 * POST /customer/signup
 * Body: { email, password, display_name?, inviter_aff_code? }
 * Whether signup is open is controlled by tenant config (default open).
 */
customerAuthRouter.post('/signup', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { email, password, display_name, inviter_aff_code } = req.body ?? {};
    if (typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'Valid email required' } });
      return;
    }
    if (typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'Password must be ≥6 chars' } });
      return;
    }

    let inviterId: number | null = null;
    if (typeof inviter_aff_code === 'string' && inviter_aff_code) {
      const inviter = await query<{ id: number }>(
        `SELECT id FROM end_user WHERE tenant_id = $1 AND aff_code = $2 LIMIT 1`,
        [tenantId, inviter_aff_code],
      );
      if (inviter.length > 0) inviterId = inviter[0].id;
    }

    const hash = await hashPassword(password);
    const affCode = crypto.randomBytes(8).toString('hex');

    const rows = await query<{ id: number }>(
      `INSERT INTO end_user
         (tenant_id, email, password_hash, display_name, group_name, aff_code, inviter_id, status)
       VALUES ($1, $2, $3, $4, 'default', $5, $6, 'active')
       RETURNING id`,
      [tenantId, email.toLowerCase(), hash, display_name ?? null, affCode, inviterId],
    );
    const userId = rows[0].id;

    const token = signSession({
      type: 'customer',
      endUserId: userId,
      tenantId,
      email: email.toLowerCase(),
    });

    logger.info({ userId, tenantId, inviterId }, 'customer:signup');

    res.status(201).json({
      token,
      user: { id: userId, email: email.toLowerCase(), aff_code: affCode },
    });
  } catch (err: any) {
    if (err.message?.includes('duplicate key')) {
      res.status(409).json({ error: { type: 'conflict', message: 'email already exists' } });
      return;
    }
    logger.error({ err: err.message }, 'customer:signup:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * POST /customer/login
 */
customerAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'email and password required' } });
      return;
    }

    const rows = await query<any>(
      `SELECT id, email, password_hash, status FROM end_user
        WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [tenantId, email],
    );
    if (rows.length === 0 || rows[0].status !== 'active') {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }
    const ok = await verifyPassword(password, rows[0].password_hash);
    if (!ok) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }

    const token = signSession({
      type: 'customer',
      endUserId: rows[0].id,
      tenantId,
      email: rows[0].email,
    });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email } });
  } catch (err: any) {
    logger.error({ err: err.message }, 'customer:login:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

customerAuthRouter.post('/logout', (_req: Request, res: Response) => {
  res.json({ ok: true });
});
