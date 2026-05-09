/**
 * Platform-level routes (multi-tenant SaaS operator only).
 *
 * Auth: static `X-Platform-Token` header matching env PLATFORM_TOKEN.
 * No tenant resolver is mounted upstream — these routes operate above the
 * per-tenant layer.
 *
 * When PLATFORM_TOKEN is unset every route here returns 503 so a typical
 * single-tenant deployment never accidentally exposes provisioning.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { withTransaction, query } from '../services/database';
import { createAdminForTenant } from '../services/auth';
import { config } from '../config';
import { logger } from '../services/logger';

export const platformRouter = Router();

const RESERVED_SLUGS = new Set([
  'www', 'root', 'api', 'mail', 'ftp', 'ns', 'ns1', 'ns2',
  'support', 'help', 'admin', 'app', 'static', 'cdn',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function platformGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.platformToken) {
    res.status(503).json({
      error: {
        type: 'service_unavailable',
        message: 'Platform routes disabled — set PLATFORM_TOKEN to enable',
      },
    });
    return;
  }
  const presented = req.headers['x-platform-token'];
  if (typeof presented !== 'string' || presented !== config.platformToken) {
    res.status(401).json({
      error: { type: 'authentication_error', message: 'Invalid platform token' },
    });
    return;
  }
  next();
}

platformRouter.use(platformGuard);

/**
 * POST /platform/tenants
 * Body:
 *   {
 *     slug: "acme",                          // 1-32 chars [a-z0-9-]
 *     admin_email: "owner@acme.com",
 *     admin_password: "hunter2hunter2",
 *     custom_domain?: "panel.acme.com",
 *     branding?: object,
 *     config?: object
 *   }
 * Response 201:
 *   {
 *     tenant: { id, slug, custom_domain, status },
 *     admin:  { id, email },
 *     login_url: "https://acme.<saas_domain>/admin/login"
 *   }
 */
platformRouter.post('/tenants', async (req: Request, res: Response) => {
  const { slug, admin_email, admin_password, custom_domain, branding, config: tConfig } =
    req.body ?? {};

  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message:
          'slug must be 1–32 chars [a-z0-9-], start/end alphanumeric, and not a reserved name',
      },
    });
    return;
  }
  if (typeof admin_email !== 'string' || !admin_email.includes('@')) {
    res
      .status(400)
      .json({ error: { type: 'invalid_request_error', message: 'admin_email is required' } });
    return;
  }
  if (typeof admin_password !== 'string' || admin_password.length < 8) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'admin_password must be ≥8 chars' },
    });
    return;
  }
  if (custom_domain != null && (typeof custom_domain !== 'string' || custom_domain.length > 255)) {
    res
      .status(400)
      .json({ error: { type: 'invalid_request_error', message: 'custom_domain invalid' } });
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      const t = await client.query<{ id: number; slug: string; custom_domain: string | null; status: string }>(
        `INSERT INTO tenant (slug, custom_domain, status, branding, config)
         VALUES ($1, $2, 'active', $3, $4)
         RETURNING id, slug, custom_domain, status`,
        [
          slug.toLowerCase(),
          custom_domain ?? null,
          branding ? JSON.stringify(branding) : null,
          tConfig ? JSON.stringify(tConfig) : null,
        ],
      );
      const tenant = t.rows[0];

      const adminId = await createAdminForTenant(
        client,
        tenant.id,
        admin_email,
        admin_password,
        'Tenant Admin',
      );

      return { tenant, adminId };
    });

    const loginUrl = config.saasDomain
      ? `https://${slug.toLowerCase()}.${config.saasDomain}/admin/login`
      : null;

    logger.info(
      { tenantId: result.tenant.id, slug: result.tenant.slug, adminId: result.adminId },
      'platform:tenant_created',
    );

    res.status(201).json({
      tenant: result.tenant,
      admin: { id: result.adminId, email: admin_email.toLowerCase() },
      login_url: loginUrl,
    });
  } catch (err: any) {
    if (err?.code === '23505') {
      // unique_violation
      res.status(409).json({
        error: { type: 'conflict', message: 'slug or custom_domain already exists' },
      });
      return;
    }
    logger.error({ err: err?.message ?? String(err) }, 'platform:tenant:create:error');
    res
      .status(500)
      .json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * GET /platform/tenants — list all tenants (operator dashboard data).
 * No pagination yet; the operator's own SaaS will not have millions of tenants.
 */
platformRouter.get('/tenants', async (_req: Request, res: Response) => {
  const rows = await query<any>(
    `SELECT id, slug, custom_domain, status, created_at FROM tenant ORDER BY id ASC`,
  );
  res.json({ data: rows });
});

/**
 * POST /platform/tenants/:id/suspend  /  /activate
 */
platformRouter.post('/tenants/:id/suspend', (req, res) => setTenantStatus(req, res, 'suspended'));
platformRouter.post('/tenants/:id/activate', (req, res) => setTenantStatus(req, res, 'active'));

async function setTenantStatus(req: Request, res: Response, status: string): Promise<void> {
  const id = parseInt(req.params.id, 10);
  if (!id || id === 1) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'Cannot change status of tenant 1 (default)' },
    });
    return;
  }
  const rows = await query<any>(
    `UPDATE tenant SET status = $1 WHERE id = $2 RETURNING id, slug, status`,
    [status, id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'tenant not found' } });
    return;
  }
  logger.info({ tenantId: id, status }, 'platform:tenant_status_changed');
  res.json(rows[0]);
}
