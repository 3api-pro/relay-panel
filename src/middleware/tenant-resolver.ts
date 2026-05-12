import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { query } from '../services/database';
import { logger } from '../services/logger';

/**
 * Resolve req.tenantId.
 *
 * - single mode: always tenantId = 1
 * - multi mode: parse Host header, look up by slug or custom_domain
 *
 * **Root-domain admin path is allowed**: hosts that equal the SaaS apex
 * (3api.pro / www.3api.pro) are the *reseller's own console* — the admin
 * authenticates with email+password, and tenant_id is carried in the JWT.
 * For these requests we leave req.tenantId = null and let the admin auth
 * route (login) or middleware (authed routes) populate it. Storefront and
 * /v1 routes that strictly need a tenant slug will still 404 via a
 * downstream guard if req.tenantId is null.
 */
export async function tenantResolver(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (config.tenantMode === 'single') {
    req.tenantId = 1;
    return next();
  }

  const host = (req.hostname || '').toLowerCase();
  if (!host) {
    res.status(400).json({ error: { type: 'bad_request', message: 'Missing Host header' } });
    return;
  }

  const saasDomain = (config.saasDomain || '').toLowerCase();
  let slug: string | null = null;
  let customDomain: string | null = null;

  if (saasDomain && (host === saasDomain || host === `www.${saasDomain}`)) {
    // Root-domain mode — admin console only. tenant_id comes from JWT for
    // authed routes, or from email lookup for login. Downstream guards
    // refuse storefront/v1 traffic without a tenant.
    req.tenantId = null as any;
    return next();
  }

  if (saasDomain && host.endsWith(`.${saasDomain}`)) {
    slug = host.slice(0, -(saasDomain.length + 1)).toLowerCase();
  } else {
    customDomain = host;
  }

  try {
    const rows = slug
      ? await query<{ id: number }>(
          `SELECT id FROM tenant WHERE slug = $1 AND status = 'active' LIMIT 1`,
          [slug],
        )
      : await query<{ id: number }>(
          `SELECT id FROM tenant WHERE custom_domain = $1 AND status = 'active' LIMIT 1`,
          [customDomain],
        );

    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: { type: 'not_found', message: `Unknown tenant for host: ${host}` } });
      return;
    }
    req.tenantId = rows[0].id;
    next();
  } catch (err: any) {
    logger.error({ err: err.message, host }, 'tenant-resolver:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Tenant resolution failed' } });
  }
}

/**
 * Guard for routes that REQUIRE a tenant slug in the host (storefront, /v1).
 * Returns 404 if tenant_id is null (root domain or unresolved).
 */
export function requireTenantHost(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId) {
    res
      .status(404)
      .json({ error: { type: 'not_found', message: 'This endpoint requires a tenant subdomain' } });
    return;
  }
  next();
}
