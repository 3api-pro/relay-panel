/**
 * Public tenant self-signup — no auth required.
 *
 * Rate-limited per IP (1/min, 10/hour). Validates slug + email + password,
 * then atomically creates a tenant row + reseller_admin row using the same
 * helpers as the platform-token route.
 *
 * Disabled by default. Set TENANT_SELF_SIGNUP=on to enable. When off the
 * route returns 503; operators on private deployments leave it that way.
 */
import { Router, Request, Response } from 'express';
import { withTransaction, query } from '../services/database';
import { createAdminForTenant } from '../services/auth';
import { RateLimiter } from '../services/rate-limit';
import { config } from '../config';
import { logger } from '../services/logger';

export const signupTenantRouter = Router();

const RESERVED_SLUGS = new Set([
  'www', 'root', 'api', 'mail', 'ftp', 'ns', 'ns1', 'ns2',
  'support', 'help', 'admin', 'app', 'static', 'cdn',
  'demo', 'docs', 'blog', 'about', 'status',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const limiter = new RateLimiter([
  { windowMs: 60_000,    max: 1  },  // 1 per minute
  { windowMs: 3_600_000, max: 10 },  // 10 per hour
]);

function enabled(): boolean {
  return (process.env.TENANT_SELF_SIGNUP || '').toLowerCase() === 'on';
}

signupTenantRouter.get('/info', (_req, res) => {
  res.json({
    enabled: enabled(),
    saas_domain: config.saasDomain || null,
    reserved_slugs: Array.from(RESERVED_SLUGS),
  });
});

signupTenantRouter.post('/', async (req: Request, res: Response) => {
  if (!enabled()) {
    res.status(503).json({
      error: { type: 'service_unavailable', message: 'Tenant self-signup is disabled' },
    });
    return;
  }

  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
  const verdict = limiter.check(ip);
  if (!verdict.allowed) {
    res.status(429).json({
      error: {
        type: 'rate_limit_exceeded',
        message: `Too many signup attempts. Retry in ${verdict.retryAfterSec}s.`,
      },
    });
    return;
  }

  const { slug, admin_email, admin_password } = req.body ?? {};

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
  if (typeof admin_email !== 'string' || !admin_email.includes('@') || admin_email.length > 255) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'valid admin_email required' },
    });
    return;
  }
  if (typeof admin_password !== 'string' || admin_password.length < 8 || admin_password.length > 128) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'admin_password must be 8–128 chars' },
    });
    return;
  }

  // Cheap pre-check (cuts a unique-violation roundtrip + nicer error message)
  const dup = await query<{ id: number }>(
    `SELECT id FROM tenant WHERE slug = $1 LIMIT 1`,
    [slug.toLowerCase()],
  );
  if (dup.length > 0) {
    res.status(409).json({
      error: { type: 'conflict', message: 'slug already taken' },
    });
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      const t = await client.query<{ id: number; slug: string }>(
        `INSERT INTO tenant (slug, status) VALUES ($1, 'active') RETURNING id, slug`,
        [slug.toLowerCase()],
      );
      const tenant = t.rows[0];
      const adminId = await createAdminForTenant(
        client,
        tenant.id,
        admin_email,
        admin_password,
        'Owner',
      );
      return { tenant, adminId };
    });

    const loginUrl = config.saasDomain
      ? `https://${slug.toLowerCase()}.${config.saasDomain}/admin/login/`
      : `/admin/login/`;

    logger.info(
      { tenantId: result.tenant.id, slug: result.tenant.slug, adminId: result.adminId, ip },
      'tenant:self_signup',
    );

    res.status(201).json({
      tenant: { id: result.tenant.id, slug: result.tenant.slug },
      admin: { id: result.adminId, email: admin_email.toLowerCase() },
      login_url: loginUrl,
    });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({
        error: { type: 'conflict', message: 'slug or admin email collision' },
      });
      return;
    }
    logger.error({ err: err?.message ?? String(err), ip }, 'tenant:self_signup:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
