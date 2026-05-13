import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../services/database';
import { verifyPassword } from '../services/auth';
import { signSession } from '../services/jwt';
import { logger } from '../services/logger';
import { getAuthorizeUrl, exchangeCode, getUserInfo, isGoogleOAuthConfigured } from '../services/oauth-google';
import { withTransaction } from '../services/database';
import { createAdminForTenant } from '../services/auth';
import { seedPlansForTenant, seedBrandConfigForTenant, ensureWholesaleBalance } from '../services/plans-seed';
import { provisionTenantUpstreamInTx } from '../services/signup-provisioner';
import { generateUniqueSlug } from './signup-tenant';
import { config } from '../config';

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
 * POST /admin/login-lookup
 * Body: { email }
 *
 * Public (no auth) — used by /admin/login "Forgot my shop address?" modal so
 * resellers who don't remember which subdomain owns their store can recover
 * it from their email. Returns { tenant_slug } or { tenant_slug: null } if
 * not found. We DO NOT return any other tenant fields here to keep this
 * surface tight: an attacker who guesses an email only learns the public
 * subdomain slug (already exposed via DNS for active shops).
 *
 * Rate-limit: 1 req / 1.5s per IP (in-memory rolling map). The window is
 * coarse on purpose — admins use this once. The limit's only job is to
 * make email enumeration painful.
 */
const LOOKUP_RATE_MS = 1500;
const lookupHits = new Map<string, number>();
function lookupRateLimitHit(ip: string): boolean {
  const now = Date.now();
  const last = lookupHits.get(ip) || 0;
  if (now - last < LOOKUP_RATE_MS) return true;
  lookupHits.set(ip, now);
  // Periodic GC — keep map small.
  if (lookupHits.size > 5000) {
    const cutoff = now - LOOKUP_RATE_MS * 4;
    for (const [k, v] of lookupHits.entries()) {
      if (v < cutoff) lookupHits.delete(k);
    }
  }
  return false;
}

adminAuthRouter.post('/login-lookup', async (req: Request, res: Response) => {
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    if (lookupRateLimitHit(ip)) {
      res.status(429).json({ error: { type: 'rate_limited', message: 'Too many requests' } });
      return;
    }

    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'email required' } });
      return;
    }

    const rows = await query<any>(
      `SELECT t.slug AS tenant_slug
         FROM reseller_admin a
         JOIN tenant t ON t.id = a.tenant_id
        WHERE LOWER(a.email) = LOWER($1)
          AND a.status = 'active'
          AND t.status <> 'deleted'
        ORDER BY a.id ASC
        LIMIT 1`,
      [email.trim()],
    );
    const slug = rows.length > 0 ? rows[0].tenant_slug : null;
    res.json({ tenant_slug: slug });
  } catch (err: any) {
    logger.error({ err: err.message }, 'admin:login_lookup:error');
    // Don't leak DB errors here — just say not found so the modal stays usable.
    res.json({ tenant_slug: null });
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



// =============================================================================
// Google OAuth (admin login). Reseller admins only; never used for end-users.
// =============================================================================

const OAUTH_STATE_COOKIE = '3api_oauth_state';
const OAUTH_STATE_TTL = 300;

function makeStateCookie(state: string, secure: boolean): string {
  const parts = [
    `${OAUTH_STATE_COOKIE}=${state}`,
    `Path=/`,
    `Max-Age=${OAUTH_STATE_TTL}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function makeStateClearCookie(secure: boolean): string {
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildAdminCookieValue(token: string, secure: boolean): string {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${ADMIN_TTL_SECONDS}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function googleRedirectUri(): string {
  // Always root domain — never tenant subdomains or custom domains.
  return `${(config.publicBaseUrl || '').replace(/\/$/, '')}/admin/auth/google/callback`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * GET /admin/auth/google — start the OAuth flow.
 * Sets a short-lived state cookie, 302 to Google authorize URL.
 */
adminAuthRouter.get('/auth/google', (_req: Request, res: Response) => {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).type('html').send('<h1>Google login not configured</h1><p>Set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET env.</p>');
    return;
  }
  const state = crypto.randomBytes(24).toString('hex');
  const secure = /^https:/i.test(process.env.PUBLIC_URL || '');
  res.setHeader('Set-Cookie', makeStateCookie(state, secure));
  const url = getAuthorizeUrl(state, googleRedirectUri());
  res.redirect(302, url);
});

/**
 * GET /admin/auth/google/callback — handle Google's redirect.
 *
 * Resolution order:
 *   1. reseller_admin.google_sub matches → log in (no DB write).
 *   2. reseller_admin.email matches (no google_sub yet) → link + log in.
 *   3. no match → redirect to /create with prefilled google_email + google_sub
 *      so the signup wizard can create a tenant tied to this Google account.
 */
adminAuthRouter.get('/auth/google/callback', async (req: Request, res: Response) => {
  try {
    if (!isGoogleOAuthConfigured()) {
      res.status(503).type('html').send('<h1>Google login not configured</h1>');
      return;
    }
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) {
      res.status(400).type('html').send(`<h1>Google login cancelled</h1><p>${escapeHtml(error)}</p><p><a href="/admin/login">返回登录</a></p>`);
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).type('html').send('<h1>Bad request</h1><p>Missing code or state.</p>');
      return;
    }

    // Verify state cookie matches the state echoed back by Google.
    const cookieHeader = req.headers.cookie || '';
    const stateCookie = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
    const stateValue = stateCookie ? stateCookie.substring(`${OAUTH_STATE_COOKIE}=`.length) : '';
    if (!stateValue || stateValue !== state) {
      res.status(400).type('html').send('<h1>Bad state</h1><p>Login session expired. <a href="/admin/login">重试</a></p>');
      return;
    }

    const tokens = await exchangeCode(code, googleRedirectUri());
    const userinfo = await getUserInfo(tokens.access_token);
    if (!userinfo.sub || !userinfo.email) {
      throw new Error('userinfo missing sub or email');
    }

    const secure = /^https:/i.test(process.env.PUBLIC_URL || '');
    const stateClear = makeStateClearCookie(secure);

    // 1. google_sub match
    let rows = await query<any>(
      `SELECT id, email, status, tenant_id, google_sub
         FROM reseller_admin
        WHERE google_sub = $1 AND status = 'active'
        ORDER BY id ASC LIMIT 1`,
      [userinfo.sub],
    );

    if (rows.length === 0) {
      // 2. email match (any tenant — pick lowest id, link google_sub if NULL)
      rows = await query<any>(
        `SELECT id, email, status, tenant_id, google_sub
           FROM reseller_admin
          WHERE LOWER(email) = LOWER($1) AND status = 'active'
          ORDER BY id ASC LIMIT 1`,
        [userinfo.email],
      );
      if (rows.length > 0 && !rows[0].google_sub) {
        await query(
          `UPDATE reseller_admin SET google_sub = $1 WHERE id = $2 AND google_sub IS NULL`,
          [userinfo.sub, rows[0].id],
        );
        logger.info({ adminId: rows[0].id, email: userinfo.email }, 'admin:google:linked');
      }
    }

    if (rows.length === 0) {
      // 3. New user — auto-provision a tenant + admin tied to this Google
      //    account. No /create form: Google has already verified email.
      //    password_hash gets a random 64-byte hex (unguessable; password
      //    login path is effectively disabled for this admin).
      const slug = await generateUniqueSlug();
      const randomPwd = crypto.randomBytes(32).toString('hex');

      const provisioned = await withTransaction(async (client) => {
        const t = await client.query<{ id: number; slug: string }>(
          `INSERT INTO tenant (slug, status) VALUES ($1, 'active') RETURNING id, slug`,
          [slug],
        );
        const tenant = t.rows[0];
        const adminId = await createAdminForTenant(
          client,
          tenant.id,
          userinfo.email,
          randomPwd,
          userinfo.name || null,
        );
        // Link google_sub so future Google logins skip the email-fallback path.
        await client.query(
          `UPDATE reseller_admin SET google_sub = $1 WHERE id = $2`,
          [userinfo.sub, adminId],
        );
        await seedPlansForTenant(client, tenant.id);
        await seedBrandConfigForTenant(client, tenant.id, tenant.slug);
        await ensureWholesaleBalance(client, tenant.id, 0);
        try {
          await provisionTenantUpstreamInTx(client, tenant.id);
        } catch (err: any) {
          logger.warn({ tenantId: tenant.id, err: err?.message ?? String(err) }, 'oauth:google:provision_failed');
        }
        return { tenantId: tenant.id, slug: tenant.slug, adminId };
      });

      const tok = signSession({
        type: 'admin',
        adminId: provisioned.adminId,
        tenantId: provisioned.tenantId,
        email: userinfo.email.toLowerCase(),
      });
      res.setHeader('Set-Cookie', [stateClear, buildAdminCookieValue(tok, secure)]);
      logger.info({
        adminId: provisioned.adminId,
        tenantId: provisioned.tenantId,
        slug: provisioned.slug,
        email: userinfo.email,
      }, 'admin:google:auto-provision');
      res.redirect(302, '/admin');
      return;
    }

    const row = rows[0];
    const token = signSession({
      type: 'admin',
      adminId: row.id,
      tenantId: row.tenant_id,
      email: row.email,
    });

    res.setHeader('Set-Cookie', [stateClear, buildAdminCookieValue(token, secure)]);
    logger.info({ adminId: row.id, tenantId: row.tenant_id, host: req.hostname }, 'admin:google:login');
    res.redirect(302, '/admin');
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, 'admin:google:callback:error');
    res.status(500).type('html').send(`<h1>Google login error</h1><p>${escapeHtml(err.message || 'internal')}</p><p><a href="/admin/login">返回登录</a></p>`);
  }
});

export { ADMIN_COOKIE_NAME, ADMIN_TTL_SECONDS, setAdminCookie };
