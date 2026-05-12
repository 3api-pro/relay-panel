import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/jwt';
import { query } from '../services/database';

const ADMIN_COOKIE_NAME = '3api_admin_token';

/**
 * Pull a cookie value by name from the raw Cookie header. We don't use
 * cookie-parser to keep deps tight; admin cookie is the only one we read.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

/**
 * Validate admin session. Token source order:
 *   1. Authorization: Bearer <token>   (SDK / curl)
 *   2. Cookie: 3api_admin_token=<token>  (browser)
 *
 * Sets req.resellerAdmin and req.tenantId (from JWT). If tenantResolver
 * left req.tenantId null (root domain), the JWT tenantId is authoritative.
 * If both are set, they must match — protects against admin from tenant A
 * authenticating to a request that resolved tenant B from the subdomain.
 */
export async function authAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization;
  let token: string | null = null;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    token = auth.slice(7);
  } else {
    token = readCookie(req.headers.cookie, ADMIN_COOKIE_NAME);
  }
  if (!token) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Missing admin token' } });
    return;
  }

  const session = verifySession(token);
  if (!session || session.type !== 'admin') {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid or expired admin token' } });
    return;
  }

  // Tenant guard: if request resolved to a subdomain tenant, it must match
  // the admin's tenant. Root-domain requests have req.tenantId == null and
  // adopt the JWT's tenant.
  if (req.tenantId && req.tenantId !== session.tenantId) {
    res.status(403).json({ error: { type: 'permission_error', message: 'Tenant mismatch' } });
    return;
  }
  if (!req.tenantId) {
    req.tenantId = session.tenantId;
  }

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
