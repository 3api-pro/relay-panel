/**
 * Public tenant self-signup — no auth required.
 *
 * Rate-limited per IP. Validates email + password, then atomically creates a
 * tenant + reseller_admin. **slug is auto-generated** (market convention —
 * Vercel/Supabase/Netlify style); admins can rename it later from settings.
 *
 * On success we **auto-sign an admin JWT and set the HttpOnly cookie**, so
 * the browser is logged in immediately and can be redirected to /admin on
 * the root domain. The response carries `redirect_to: '/admin'` and
 * `store_url` (the customer-facing subdomain). No `login_url` — admin lives
 * on the root domain; the subdomain is the storefront for end users.
 *
 * Disabled by default. Set TENANT_SELF_SIGNUP=on to enable. When off the
 * route returns 503; operators on private deployments leave it that way.
 */
import { Router, Request, Response } from 'express';
import { withTransaction, query } from '../services/database';
import { createAdminForTenant } from '../services/auth';
import { seedPlansForTenant, seedBrandConfigForTenant, ensureWholesaleBalance } from '../services/plans-seed';
import { provisionTenantUpstreamInTx } from '../services/signup-provisioner';
import { RateLimiter } from '../services/rate-limit';
import { signSession } from '../services/jwt';
import { setAdminCookie, ADMIN_TTL_SECONDS } from './auth-admin';
import { config } from '../config';
import { logger } from '../services/logger';
import { recordReferral } from '../services/affiliate';

export const signupTenantRouter = Router();

const RESERVED_SLUGS = new Set([
  'www', 'root', 'api', 'mail', 'ftp', 'ns', 'ns1', 'ns2',
  'support', 'help', 'admin', 'app', 'static', 'cdn',
  'demo', 'docs', 'blog', 'about', 'status',
  'platform', 'panel', 'auth', 'console', 'dashboard',
  'pay', 'payment', 'webhook', 'create', 'signup', 'login',
  'pricing', 'compare', 'comparison', 'changelog',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const limiter = new RateLimiter([
  { windowMs: 60_000,    max: 1  },
  { windowMs: 3_600_000, max: 10 },
]);

function enabled(): boolean {
  return (process.env.TENANT_SELF_SIGNUP || '').toLowerCase() === 'on';
}

const ADJ = ['swift', 'bright', 'calm', 'clever', 'bold', 'crisp', 'cozy', 'fair',
             'kind', 'lucky', 'merry', 'nimble', 'proud', 'quick', 'royal', 'silver',
             'star', 'sunny', 'true', 'warm', 'wise', 'zen', 'amber', 'azure',
             'coral', 'echo', 'flux', 'glow', 'haze', 'iris', 'jade', 'lark'];
const NOUN = ['fox', 'owl', 'cat', 'crab', 'dawn', 'echo', 'eagle', 'fern',
              'flame', 'forge', 'glade', 'harbor', 'lake', 'leaf', 'lion', 'loom',
              'maple', 'nest', 'oak', 'orca', 'peak', 'pine', 'reef', 'river',
              'shore', 'sky', 'spark', 'storm', 'tide', 'wave', 'wolf', 'wren'];

function randomSlugCandidate(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const tail = Math.random().toString(36).slice(2, 6);
  return `${a}-${n}-${tail}`;
}

async function generateUniqueSlug(maxTries = 12): Promise<string> {
  for (let i = 0; i < maxTries; i++) {
    const candidate = randomSlugCandidate();
    if (RESERVED_SLUGS.has(candidate)) continue;
    const dup = await query<{ id: number }>(
      `SELECT id FROM tenant WHERE slug = $1 LIMIT 1`,
      [candidate],
    );
    if (dup.length === 0) return candidate;
  }
  return Math.random().toString(36).slice(2, 14);
}

signupTenantRouter.get('/info', (_req, res) => {
  res.json({
    enabled: enabled(),
    saas_domain: config.saasDomain || null,
    reserved_slugs: Array.from(RESERVED_SLUGS),
    slug_auto_assigned: true,
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

  const { slug: maybeSlug, admin_email, admin_password } = req.body ?? {};
  // Affiliate referral (v0.4 P2 #18). Accepts ?ref=<aff_code> via either
  // body or query; advisory — never blocks signup. Recorded *after* the
  // tenant transaction commits so a malformed code can't roll us back.
  const refCode = (
    (req.body && typeof req.body.ref === 'string' && req.body.ref) ||
    (typeof req.query.ref === 'string' && req.query.ref) ||
    ''
  ).toString().toLowerCase();

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

  let slug: string;
  if (typeof maybeSlug === 'string' && maybeSlug.length > 0) {
    const normalized = maybeSlug.toLowerCase();
    if (!SLUG_RE.test(normalized) || RESERVED_SLUGS.has(normalized)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message:
            'slug must be 1–32 chars [a-z0-9-], start/end alphanumeric, and not a reserved name',
        },
      });
      return;
    }
    const dup = await query<{ id: number }>(
      `SELECT id FROM tenant WHERE slug = $1 LIMIT 1`,
      [normalized],
    );
    if (dup.length > 0) {
      res.status(409).json({
        error: { type: 'conflict', message: 'slug already taken — try a different one or leave blank for auto' },
      });
      return;
    }
    slug = normalized;
  } else {
    slug = await generateUniqueSlug();
  }

  try {
    const result = await withTransaction(async (client) => {
      const t = await client.query<{ id: number; slug: string }>(
        `INSERT INTO tenant (slug, status) VALUES ($1, 'active') RETURNING id, slug`,
        [slug],
      );
      const tenant = t.rows[0];
      const adminId = await createAdminForTenant(
        client,
        tenant.id,
        admin_email,
        admin_password,
        'Owner',
      );
      await seedPlansForTenant(client, tenant.id);
      await seedBrandConfigForTenant(client, tenant.id, tenant.slug);
      await ensureWholesaleBalance(client, tenant.id, 0);
      // Auto-provision the platform-default upstream channel so the new
      // admin can call /v1/messages immediately. Failure here is logged
      // but does NOT block signup — admin can BYOK from /admin/channels.
      let provision: Awaited<ReturnType<typeof provisionTenantUpstreamInTx>> = {
        ok: false, channel_id: null, reason: 'unattempted',
      };
      try {
        provision = await provisionTenantUpstreamInTx(client, tenant.id);
      } catch (err: any) {
        logger.warn({ tenantId: tenant.id, err: err?.message ?? String(err) }, 'tenant:self_signup:provision_failed');
      }
      return { tenant, adminId, provision };
    });

    // Affiliate: best-effort record. If the code is bad / unknown the call
    // returns { ok: false, reason } and we just log — never block signup.
    let referralRecorded = false;
    if (refCode && refCode.length >= 4 && refCode.length <= 16) {
      try {
        const r = await recordReferral(refCode, result.tenant.id);
        referralRecorded = r.ok;
        if (!r.ok) {
          logger.info({ refCode, tenantId: result.tenant.id, reason: r.reason }, 'tenant:self_signup:referral_skipped');
        }
      } catch (err: any) {
        logger.warn({ err: err?.message ?? String(err), refCode }, 'tenant:self_signup:referral_error');
      }
    }

    const storeUrl = config.saasDomain
      ? `https://${result.tenant.slug}.${config.saasDomain}/`
      : `/`;

    // Auto-sign admin into the freshly created tenant — the browser walks
    // straight into /admin without having to re-enter credentials.
    const token = signSession({
      type: 'admin',
      adminId: result.adminId,
      tenantId: result.tenant.id,
      email: admin_email.toLowerCase(),
    });
    setAdminCookie(res, token);

    logger.info(
      {
        tenantId: result.tenant.id, slug: result.tenant.slug, adminId: result.adminId,
        ip, autoSlug: !maybeSlug,
        provisionedChannelId: result.provision.channel_id,
        provisionReason: result.provision.reason,
        referralRecorded,
      },
      'tenant:self_signup',
    );

    res.status(201).json({
      tenant: { id: result.tenant.id, slug: result.tenant.slug },
      admin: { id: result.adminId, email: admin_email.toLowerCase() },
      store_url: storeUrl,
      redirect_to: '/admin',
      token,
      expires_in_seconds: ADMIN_TTL_SECONDS,
      slug_was_auto: !maybeSlug,
      upstream_channel: result.provision.ok
        ? { id: result.provision.channel_id, reason: result.provision.reason }
        : null,
      referral_recorded: referralRecorded,
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
