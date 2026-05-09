import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../services/database';
import { verifyPassword } from '../services/auth';
import { signSession } from '../services/jwt';
import { logger } from '../services/logger';

export const adminAuthRouter = Router();

/**
 * POST /admin/login
 * Body: { email, password }
 * Returns: { token, expires_in_seconds, admin: { id, email, display_name } }
 */
adminAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'email and password required' } });
      return;
    }

    const tenantId = req.tenantId!;
    const rows = await query<any>(
      `SELECT id, email, password_hash, display_name, status
         FROM reseller_admin
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
      type: 'admin',
      adminId: rows[0].id,
      tenantId,
      email: rows[0].email,
    });

    logger.info({ adminId: rows[0].id, tenantId }, 'admin:login');

    res.json({
      token,
      expires_in_seconds: 7 * 24 * 60 * 60,
      admin: {
        id: rows[0].id,
        email: rows[0].email,
        display_name: rows[0].display_name,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'admin:login:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * POST /admin/logout — stateless JWT, server has nothing to do. Client drops token.
 */
adminAuthRouter.post('/logout', (_req: Request, res: Response) => {
  res.json({ ok: true });
});
