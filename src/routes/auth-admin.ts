import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../services/database';
import { verifyPassword } from '../services/auth';
import { signSession } from '../services/jwt';
import { logger } from '../services/logger';

export const adminAuthRouter = Router();

const ADMIN_COOKIE_NAME = '3api_admin_token';
const ADMIN_TTL_SECONDS = 7 * 24 * 60 * 60;

function setAdminCookie(res: Response, token: string): void {
  // HttpOnly + SameSite=Lax + Path=/. Set Secure in prod (PUBLIC_URL https).
  const secure = /^https:/i.test(process.env.PUBLIC_URL || '');
  const parts: string[] = [
    `${ADMIN_COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${ADMIN_TTL_SECONDS}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * POST /admin/login
 * Body: { email, password }
 *
 * Reseller admin login. **Tenant is resolved from the admin's email**, not
 * from the Host header — admins log into 3api.pro/admin (root domain) and
 * their JWT carries the tenant_id. Subdomains are the storefront for end
 * users; resellers never need to visit them to manage their tenant.
 *
 * If req.tenantId was set by the resolver (i.e. caller is on the tenant
 * subdomain), we additionally constrain the lookup to that tenant so a
 * shared-email admin on tenant A cannot accidentally log into tenant B
 * via the wrong subdomain.
 *
 * Response: { token, expires_in_seconds, admin: {...}, tenant: {...} }
 * Also sets an HttpOnly cookie for browser-driven flows.
 */
adminAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'email and password required' } });
      return;
    }

    const tenantHint = (req as any).tenantId ?? null;
    const params: any[] = [email];
    let where = `LOWER(email) = LOWER($1)`;
    if (tenantHint) {
      params.push(tenantHint);
      where += ` AND tenant_id = $${params.length}`;
    }
    const rows = await query<any>(
      `SELECT id, email, password_hash, display_name, status, tenant_id
         FROM reseller_admin
        WHERE ${where} AND status = 'active'
        ORDER BY id ASC
        LIMIT 2`,
      params,
    );
    if (rows.length === 0) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }

    // We rank by id ASC; if the same email owns multiple active tenants we
    // bind to the first match and let the admin switch later. Log a hint.
    const row = rows[0];
    if (rows.length > 1) {
      logger.warn({ email: row.email, tenantIds: rows.map((r: any) => r.tenant_id) }, 'admin:login:multi_tenant_email');
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }

    // Look up tenant slug for the response (so UI can show "you're managing X").
    const tRows = await query<any>(
      `SELECT id, slug, custom_domain, status FROM tenant WHERE id = $1 LIMIT 1`,
      [row.tenant_id],
    );
    const tenant = tRows[0] || null;

    const token = signSession({
      type: 'admin',
      adminId: row.id,
      tenantId: row.tenant_id,
      email: row.email,
    });

    setAdminCookie(res, token);
    logger.info({ adminId: row.id, tenantId: row.tenant_id, host: req.hostname }, 'admin:login');

    res.json({
      token,
      expires_in_seconds: ADMIN_TTL_SECONDS,
      admin: {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
      },
      tenant: tenant
        ? { id: tenant.id, slug: tenant.slug, custom_domain: tenant.custom_domain, status: tenant.status }
        : null,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'admin:login:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * POST /admin/logout — clear the cookie. JWT is stateless so the bearer
 * version still works until expiry; this is a best-effort browser logout.
 */
adminAuthRouter.post('/logout', (_req: Request, res: Response) => {
  const secure = /^https:/i.test(process.env.PUBLIC_URL || '');
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok: true });
});

export { ADMIN_COOKIE_NAME, ADMIN_TTL_SECONDS, setAdminCookie };
