import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/jwt';
import { query } from '../services/database';

export async function authCustomer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization;
  const token = auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Missing customer token' } });
    return;
  }

  const session = verifySession(token);
  if (!session || session.type !== 'customer') {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid or expired customer token' } });
    return;
  }
  if (req.tenantId && req.tenantId !== session.tenantId) {
    res.status(403).json({ error: { type: 'permission_error', message: 'Tenant mismatch' } });
    return;
  }

  const rows = await query<any>(
    `SELECT id, tenant_id, email, group_name, quota_cents, used_quota_cents, status
       FROM end_user
      WHERE id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
    [session.endUserId, session.tenantId],
  );
  if (rows.length === 0) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Customer not found or suspended' } });
    return;
  }
  req.endUser = {
    id: rows[0].id,
    tenantId: rows[0].tenant_id,
    email: rows[0].email,
    groupName: rows[0].group_name,
    quotaCents: Number(rows[0].quota_cents),
    usedQuotaCents: Number(rows[0].used_quota_cents),
  };
  next();
}
