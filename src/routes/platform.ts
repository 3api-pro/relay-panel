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
import { seedPlansForTenant, seedBrandConfigForTenant, ensureWholesaleBalance } from '../services/plans-seed';
import { upgradeTenantToShadowSk } from '../services/signup-provisioner';
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

      // Seed default plans + brand_config + wholesale_balance.
      // All idempotent (ON CONFLICT DO NOTHING) so re-running platform/signup is safe.
      await seedPlansForTenant(client, tenant.id);
      await seedBrandConfigForTenant(client, tenant.id, tenant.slug);
      await ensureWholesaleBalance(client, tenant.id, 0);
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

/**
 * POST /platform/tenants/:id/upgrade-shadow
 * Body: { plan?: 'pro' | 'max5x' | …, cycle?: 'monthly' | 'quarterly' | 'annual' }
 *
 * Phase-2 manual upgrade — mints a per-tenant sk-relay-* against llmapi.pro
 * /v1/wholesale/purchase using the platform wsk-* and replaces the
 * tenant's recommended upstream_channel.api_key with it.
 *
 * COSTS the platform wholesale_balance (currently ~¥29 for pro/monthly).
 * Use this for paying tenants who justify the spend; cheap / spam signups
 * stay on the shared phase-1 key.
 *
 * Idempotency: each call mints a *new* purchase (request_id varies by ms).
 * The caller is responsible for not double-spending — typically you'd
 * call this from an admin "upgrade tenant" button, not in a loop.
 */
platformRouter.post('/tenants/:id/upgrade-shadow', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid tenant id' } });
    return;
  }
  const plan = typeof req.body?.plan === 'string' ? req.body.plan : undefined;
  const cycle = typeof req.body?.cycle === 'string' ? req.body.cycle : undefined;

  // Confirm tenant exists before debiting wholesale_balance.
  const existing = await query<{ id: number; slug: string; status: string }>(
    `SELECT id, slug, status FROM tenant WHERE id = $1`,
    [id],
  );
  if (existing.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'tenant not found' } });
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      return upgradeTenantToShadowSk(client, id, { plan, cycle });
    });
    if (!result.ok) {
      // Don't 500 — return the structured failure so the operator UI can
      // surface "insufficient balance" / "402" / network without an alarm.
      logger.warn(
        { tenantId: id, reason: result.reason, purchase: result.purchase },
        'platform:upgrade_shadow:failed',
      );
      res.status(502).json({
        error: { type: 'upstream_error', message: result.reason },
        purchase: result.purchase,
      });
      return;
    }
    logger.info(
      {
        tenantId: id, channelId: result.channel_id,
        purchase: result.purchase ? {
          purchase_id: result.purchase.purchase_id,
          amount_cents: result.purchase.amount_cents,
          remaining_balance_cents: result.purchase.remaining_balance_cents,
        } : null,
      },
      'platform:upgrade_shadow:ok',
    );
    res.json({
      ok: true,
      tenant: { id, slug: existing[0].slug },
      channel_id: result.channel_id,
      phase: result.phase,
      purchase: result.purchase
        ? {
          purchase_id: result.purchase.purchase_id,
          expires_at: result.purchase.expires_at,
          amount_cents: result.purchase.amount_cents,
          remaining_balance_cents: result.purchase.remaining_balance_cents,
        }
        : null,
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err), tenantId: id }, 'platform:upgrade_shadow:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
