import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/jwt';
import { query } from '../services/database';

/**
 * Validate admin JWT in Authorization: Bearer <token>.
 * Sets req.resellerAdmin for downstream admin routes.
 * Tenant scope enforced — admin can only act on their own tenant.
 */
export async function authAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization;
  const token = auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Missing admin token' } });
    return;
  }

  const session = verifySession(token);
  if (!session || session.type !== 'admin') {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid or expired admin token' } });
    return;
  }

  // Tenant guard: session tenant must match resolved tenant
  if (req.tenantId && req.tenantId !== session.tenantId) {
    res.status(403).json({ error: { type: 'permission_error', message: 'Tenant mismatch' } });
    return;
  }

  // Confirm admin still exists + active
  const rows = await query<any>(
    `SELECT id, tenant_id, email, display_name, status
       FROM reseller_admin
      WHERE id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
    [session.adminId, session.tenantId],
  );
  if (rows.length === 0) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Admin account not found or suspended' } });
    return;
  }

  req.resellerAdmin = {
    id: rows[0].id,
    tenantId: rows[0].tenant_id,
    email: rows[0].email,
    displayName: rows[0].display_name,
  };
  next();
}
