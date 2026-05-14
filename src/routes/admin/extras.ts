/**
 * Admin extras — endpoints the admin UI (Task #16) calls but didn't yet
 * exist server-side. All routes inherit tenantResolver + authAdmin from
 * the parent adminRouter mount.
 *
 * Endpoints:
 *   GET    /me                      — admin + tenant + brand bundle
 *   GET    /brand                   — brand_config (defaults if empty)
 *   PATCH  /brand                   — upsert brand_config
 *   GET    /orders                  — paginated orders + end_user email
 *   POST   /orders/:id/refund       — issue refund + send email
 *   GET    /stats                   — revenue/subs/tokens aggregates
 *   POST   /change-password         — bcrypt verify old → set new
 *   GET    /payment-config          — masked private_key
 *   PATCH  /payment-config          — upsert payment_config in tenant.config
 */
import { Router, Request, Response } from 'express';
import { query } from '../../services/database';
import { hashPassword, verifyPassword } from '../../services/auth';
import { logger } from '../../services/logger';
import { sendEmail } from '../../services/email-provider';

export const adminExtrasRouter = Router();

// =========================================================================
// /me — admin + tenant + brand bundle
// =========================================================================

adminExtrasRouter.get('/me', async (req: Request, res: Response) => {
  const a = req.resellerAdmin!;
  const tenantId = a.tenantId;
  try {
    const tRows = await query<any>(
      `SELECT id, slug, custom_domain, status, COALESCE(branding,'{}'::jsonb) AS branding
         FROM tenant WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const bRows = await query<any>(
      `SELECT tenant_id, store_name, logo_url, primary_color, announcement, footer_html, contact_email, updated_at
         FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const tenant = tRows[0] || null;
    const brand = bRows[0] || {
      tenant_id: tenantId,
      store_name: null,
      logo_url: null,
      primary_color: '#6366f1',
      announcement: null,
      footer_html: null,
      contact_email: null,
      updated_at: null,
    };
    res.json({
      admin: { id: a.id, email: a.email, display_name: a.displayName, role: 'admin' },
      tenant: tenant
        ? { id: tenant.id, slug: tenant.slug, name: brand.store_name || tenant.slug, custom_domain: tenant.custom_domain, status: tenant.status }
        : null,
      brand,
    });
  } catch (err: any) {
    logger.error({ err: err.message, adminId: a.id }, 'admin:me:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// /brand — read/write brand_config
// =========================================================================

const BRAND_DEFAULTS = {
  store_name: null as string | null,
  logo_url: null as string | null,
  primary_color: '#6366f1',
  announcement: null as string | null,
  footer_html: null as string | null,
  contact_email: null as string | null,
};

adminExtrasRouter.get('/brand', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  // Join tenant for slug + custom_domain so UI can render CNAME instructions
  const rows = await query<any>(
    `SELECT b.tenant_id, b.store_name, b.logo_url, b.primary_color, b.announcement,
            b.footer_html, b.contact_email, b.updated_at,
            t.slug, t.custom_domain
       FROM tenant t
       LEFT JOIN brand_config b ON b.tenant_id = t.id
      WHERE t.id = $1 LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) {
    res.json({ tenant_id: tenantId, ...BRAND_DEFAULTS, updated_at: null, slug: null, custom_domain: null });
    return;
  }
  const row = rows[0];
  // brand_config may be NULL via LEFT JOIN — synth defaults
  res.json({
    tenant_id: row.tenant_id || tenantId,
    store_name: row.store_name ?? null,
    logo_url: row.logo_url ?? null,
    primary_color: row.primary_color ?? BRAND_DEFAULTS.primary_color,
    announcement: row.announcement ?? null,
    footer_html: row.footer_html ?? null,
    contact_email: row.contact_email ?? null,
    updated_at: row.updated_at ?? null,
    slug: row.slug,
    custom_domain: row.custom_domain ?? null,
  });
});

const BRAND_FIELDS = ['store_name', 'logo_url', 'primary_color', 'announcement', 'footer_html', 'contact_email'] as const;
type BrandField = (typeof BRAND_FIELDS)[number];

function validateBrand(body: any): string | null {
  if (!body || typeof body !== 'object') return 'body must be an object';
  for (const k of BRAND_FIELDS) {
    if (body[k] != null && typeof body[k] !== 'string') {
      return `${k} must be string or null`;
    }
  }
  if (body.store_name && body.store_name.length > 64) return 'store_name max 64 chars';
  if (body.primary_color && !/^#[0-9a-fA-F]{3,8}$/.test(body.primary_color)) return 'primary_color must be hex like #RRGGBB';
  if (body.contact_email && !body.contact_email.includes('@')) return 'contact_email must be valid';
  return null;
}

adminExtrasRouter.patch('/brand', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body = req.body ?? {};
  const v = validateBrand(body);
  if (v) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: v } });
    return;
  }

  const patch: Partial<Record<BrandField, string | null>> = {};
  for (const k of BRAND_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      patch[k] = body[k] === '' ? null : body[k];
    }
  }

  try {
    const existing = await query<{ tenant_id: number }>(
      `SELECT tenant_id FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    if (existing.length === 0) {
      const merged = { ...BRAND_DEFAULTS, ...patch };
      await query(
        `INSERT INTO brand_config (tenant_id, store_name, logo_url, primary_color, announcement, footer_html, contact_email, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          tenantId,
          merged.store_name,
          merged.logo_url,
          merged.primary_color ?? '#6366f1',
          merged.announcement,
          merged.footer_html,
          merged.contact_email,
        ],
      );
    } else if (Object.keys(patch).length > 0) {
      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      for (const [k, val] of Object.entries(patch)) {
        sets.push(`${k} = $${i++}`);
        params.push(val);
      }
      sets.push(`updated_at = NOW()`);
      params.push(tenantId);
      await query(
        `UPDATE brand_config SET ${sets.join(', ')} WHERE tenant_id = $${i}`,
        params,
      );
    }

    const rows = await query<any>(
      `SELECT tenant_id, store_name, logo_url, primary_color, announcement, footer_html, contact_email, updated_at
         FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    logger.info({ tenantId, fields: Object.keys(patch) }, 'admin:brand:patch');
    res.json(rows[0]);
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:brand:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// /orders — paginated + end_user join
// =========================================================================

adminExtrasRouter.get('/orders', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const status = String(req.query.status ?? '').trim();
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  const params: any[] = [tenantId];
  let where = `o.tenant_id = $1`;
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }

  const countRows = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM orders o WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0]?.c || 0);

  params.push(limit);
  params.push(offset);
  const rows = await query<any>(
    `SELECT o.id, o.tenant_id, o.end_user_id, o.plan_id, o.amount_cents, o.currency,
            o.payment_provider, o.provider_txn_id, o.status, o.created_at, o.paid_at,
            u.email AS end_user_email, p.name AS plan_name, p.slug AS plan_slug
       FROM orders o
  LEFT JOIN end_user u ON u.id = o.end_user_id
  LEFT JOIN plans p ON p.id = o.plan_id
      WHERE ${where}
      ORDER BY o.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ data: rows, page, limit, total });
});

// =========================================================================
// /orders/:id/refund
// =========================================================================

adminExtrasRouter.post('/orders/:id/refund', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const orderId = parseInt(req.params.id, 10);
  if (!orderId || !Number.isFinite(orderId)) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid order id' } });
    return;
  }
  const { amount_cents, reason } = req.body ?? {};
  if (typeof reason !== 'string' || !reason.trim()) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'reason required' } });
    return;
  }

  try {
    const orderRows = await query<any>(
      `SELECT o.id, o.tenant_id, o.end_user_id, o.amount_cents, o.currency, o.status,
              u.email AS end_user_email
         FROM orders o
    LEFT JOIN end_user u ON u.id = o.end_user_id
        WHERE o.id = $1 AND o.tenant_id = $2 LIMIT 1`,
      [orderId, tenantId],
    );
    if (orderRows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'order not found' } });
      return;
    }
    const order = orderRows[0];
    if (!['paid', 'completed', 'active'].includes(order.status)) {
      res.status(409).json({
        error: { type: 'conflict', message: `cannot refund order in status: ${order.status}` },
      });
      return;
    }

    const requested = amount_cents == null ? order.amount_cents : Number(amount_cents);
    if (!Number.isInteger(requested) || requested <= 0 || requested > order.amount_cents) {
      res.status(400).json({
        error: { type: 'invalid_request_error', message: 'amount_cents must be a positive integer <= order.amount_cents' },
      });
      return;
    }

    const refundRows = await query<{ id: number }>(
      `INSERT INTO refund (order_id, tenant_id, amount_cents, reason, status, refunded_by, refunded_at)
       VALUES ($1, $2, $3, $4, 'completed', $5, NOW()) RETURNING id`,
      [order.id, tenantId, requested, reason.trim(), String(req.resellerAdmin!.id)],
    );

    await query(
      `UPDATE orders SET status = 'refunded' WHERE id = $1 AND tenant_id = $2`,
      [order.id, tenantId],
    );

    if (order.end_user_email) {
      sendEmail({
        to: order.end_user_email,
        template: 'refund-confirmation',
        tenantId,
        data: {
          order_id: order.id,
          amount_cents: requested,
          currency: order.currency || 'CNY',
          reason: reason.trim(),
        },
      }).catch((err: any) => logger.warn({ err: err.message, orderId }, 'admin:refund:email:fail'));
    }

    logger.info(
      { tenantId, orderId, refundId: refundRows[0].id, amount: requested, adminId: req.resellerAdmin!.id },
      'admin:refund:issued',
    );
    res.status(201).json({
      refund_id: refundRows[0].id,
      order_id: order.id,
      amount_cents: requested,
      reason: reason.trim(),
      status: 'completed',
    });
  } catch (err: any) {
    logger.error({ err: err.message, orderId }, 'admin:refund:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// /stats — revenue / active_subs / tokens / by_day [/ by_plan]
// =========================================================================

adminExtrasRouter.get('/stats', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const period = String(req.query.period ?? '7d');
  const group = String(req.query.group ?? '');
  const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;

  try {
    const headRows = await query<any>(
      `SELECT
          COALESCE((SELECT SUM(amount_cents) FROM orders
                    WHERE tenant_id = $1
                      AND status IN ('paid','completed','active')
                      AND created_at > NOW() - ($2::int || ' days')::interval), 0)::bigint AS revenue_cents,
          COALESCE((SELECT COUNT(*) FROM subscription
                    WHERE tenant_id = $1 AND status = 'active'), 0)::bigint AS active_subs,
          COALESCE((SELECT SUM(prompt_tokens + completion_tokens) FROM usage_log
                    WHERE tenant_id = $1
                      AND created_at > NOW() - ($2::int || ' days')::interval), 0)::bigint AS tokens
      `,
      [tenantId, days],
    );
    const head = headRows[0] || { revenue_cents: 0, active_subs: 0, tokens: 0 };

    const byDay = await query<any>(
      `WITH days AS (
         SELECT generate_series(
           (NOW() - ($2::int - 1 || ' days')::interval)::date,
           NOW()::date,
           '1 day'::interval
         )::date AS d
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
              COALESCE((SELECT SUM(amount_cents) FROM orders
                        WHERE tenant_id = $1 AND status IN ('paid','completed','active')
                          AND DATE(created_at) = days.d), 0)::bigint AS revenue_cents,
              COALESCE((SELECT SUM(prompt_tokens + completion_tokens) FROM usage_log
                        WHERE tenant_id = $1 AND DATE(created_at) = days.d), 0)::bigint AS tokens
       FROM days
       ORDER BY days.d ASC`,
      [tenantId, days],
    );

    const out: any = {
      period: `${days}d`,
      revenue_cents: Number(head.revenue_cents),
      active_subs: Number(head.active_subs),
      tokens: Number(head.tokens),
      by_day: byDay.map((r: any) => ({
        date: r.date,
        revenue_cents: Number(r.revenue_cents),
        tokens: Number(r.tokens),
      })),
    };

    if (group === 'plan') {
      const byPlan = await query<any>(
        `SELECT o.plan_id, COALESCE(p.name, 'unknown') AS name,
                SUM(o.amount_cents)::bigint AS revenue_cents,
                COUNT(*)::bigint AS orders
           FROM orders o
      LEFT JOIN plans p ON p.id = o.plan_id
          WHERE o.tenant_id = $1
            AND o.status IN ('paid','completed','active')
            AND o.created_at > NOW() - ($2::int || ' days')::interval
          GROUP BY o.plan_id, p.name
          ORDER BY revenue_cents DESC`,
        [tenantId, days],
      );
      out.by_plan = byPlan.map((r: any) => ({
        plan_id: r.plan_id,
        name: r.name,
        revenue_cents: Number(r.revenue_cents),
        orders: Number(r.orders),
      }));
    }

    res.json(out);
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:stats:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// /change-password
// =========================================================================

adminExtrasRouter.post('/change-password', async (req: Request, res: Response) => {
  const adminId = req.resellerAdmin!.id;
  const tenantId = req.resellerAdmin!.tenantId;
  const { old_password, new_password } = req.body ?? {};
  if (typeof old_password !== 'string' || typeof new_password !== 'string') {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'old_password and new_password required' } });
    return;
  }
  if (new_password.length < 8) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'new_password must be >=8 chars' } });
    return;
  }

  try {
    const rows = await query<{ password_hash: string }>(
      `SELECT password_hash FROM reseller_admin WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [adminId, tenantId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'admin not found' } });
      return;
    }
    const ok = await verifyPassword(old_password, rows[0].password_hash);
    if (!ok) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'old_password incorrect' } });
      return;
    }
    const newHash = await hashPassword(new_password);
    await query(
      `UPDATE reseller_admin SET password_hash = $1 WHERE id = $2 AND tenant_id = $3`,
      [newHash, adminId, tenantId],
    );
    logger.info({ adminId, tenantId }, 'admin:change-password');
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err: err.message, adminId }, 'admin:change-password:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// /payment-config — tenant.config.payment_config (mask private_key)
// =========================================================================

const PAYMENT_FIELDS = [
  'alipay_app_id',
  'alipay_private_key',
  'alipay_public_key',
  'usdt_trc20_address',
  'usdt_erc20_address',
  // PayPal (per-tenant; falls back to platform app_config if blank)
  'paypal_client_id',
  'paypal_client_secret',
  'paypal_environment',
  // Stripe (per-tenant)
  'stripe_secret_key',
  'stripe_webhook_secret',
  'stripe_mode',
  // Creem (per-tenant)
  'creem_api_key',
  'creem_webhook_secret',
  'creem_environment',
] as const;
type PayField = (typeof PAYMENT_FIELDS)[number];

function maskSecret(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

adminExtrasRouter.get('/payment-config', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const rows = await query<any>(
    `SELECT COALESCE(config->'payment_config', '{}'::jsonb) AS payment_config
       FROM tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const cfg = (rows[0]?.payment_config as Record<string, any>) || {};
  res.json({
    alipay_app_id: cfg.alipay_app_id || '',
    alipay_private_key: maskSecret(cfg.alipay_private_key),
    alipay_private_key_set: !!cfg.alipay_private_key,
    alipay_public_key: maskSecret(cfg.alipay_public_key),
    alipay_public_key_set: !!cfg.alipay_public_key,
    usdt_trc20_address: cfg.usdt_trc20_address || '',
    usdt_erc20_address: cfg.usdt_erc20_address || '',
    paypal_client_id: cfg.paypal_client_id || '',
    paypal_client_secret: maskSecret(cfg.paypal_client_secret),
    paypal_client_secret_set: !!cfg.paypal_client_secret,
    paypal_environment: cfg.paypal_environment || 'sandbox',
    stripe_secret_key: maskSecret(cfg.stripe_secret_key),
    stripe_secret_key_set: !!cfg.stripe_secret_key,
    stripe_webhook_secret: maskSecret(cfg.stripe_webhook_secret),
    stripe_webhook_secret_set: !!cfg.stripe_webhook_secret,
    stripe_mode: cfg.stripe_mode || 'test',
    creem_api_key: maskSecret(cfg.creem_api_key),
    creem_api_key_set: !!cfg.creem_api_key,
    creem_webhook_secret: maskSecret(cfg.creem_webhook_secret),
    creem_webhook_secret_set: !!cfg.creem_webhook_secret,
    creem_environment: cfg.creem_environment || 'live',
  });
});

adminExtrasRouter.patch('/payment-config', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body = req.body ?? {};
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'body must be object' } });
    return;
  }

  const patch: Partial<Record<PayField, string>> = {};
  for (const k of PAYMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      if (v != null && typeof v !== 'string') {
        res.status(400).json({ error: { type: 'invalid_request_error', message: `${k} must be string` } });
        return;
      }
      // Ignore client-echoed masked values so a partial save doesn't wipe the
      // private key. We still allow explicit clearing via empty-string ''.
      if (typeof v === 'string' && v.startsWith('***') && v.length <= 8) {
        continue;
      }
      patch[k] = v == null ? '' : String(v);
    }
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'no fields to update' } });
    return;
  }

  try {
    const params: any[] = [];
    let i = 1;
    let acc = `COALESCE(config, '{}'::jsonb)`;
    for (const [k, v] of Object.entries(patch)) {
      params.push(v);
      acc = `jsonb_set(${acc}, '{payment_config,${k}}', to_jsonb($${i}::text), true)`;
      i++;
    }
    params.push(tenantId);
    await query(`UPDATE tenant SET config = ${acc} WHERE id = $${i}`, params);
    logger.info({ tenantId, fields: Object.keys(patch) }, 'admin:payment-config:patch');

    const rows = await query<any>(
      `SELECT COALESCE(config->'payment_config', '{}'::jsonb) AS payment_config FROM tenant WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const cfg = (rows[0]?.payment_config as Record<string, any>) || {};
    res.json({
      alipay_app_id: cfg.alipay_app_id || '',
      alipay_private_key: maskSecret(cfg.alipay_private_key),
      alipay_private_key_set: !!cfg.alipay_private_key,
      alipay_public_key: maskSecret(cfg.alipay_public_key),
      alipay_public_key_set: !!cfg.alipay_public_key,
      usdt_trc20_address: cfg.usdt_trc20_address || '',
      usdt_erc20_address: cfg.usdt_erc20_address || '',
      paypal_client_id: cfg.paypal_client_id || '',
      paypal_client_secret: maskSecret(cfg.paypal_client_secret),
      paypal_client_secret_set: !!cfg.paypal_client_secret,
      paypal_environment: cfg.paypal_environment || 'sandbox',
      stripe_secret_key: maskSecret(cfg.stripe_secret_key),
      stripe_secret_key_set: !!cfg.stripe_secret_key,
      stripe_webhook_secret: maskSecret(cfg.stripe_webhook_secret),
      stripe_webhook_secret_set: !!cfg.stripe_webhook_secret,
      stripe_mode: cfg.stripe_mode || 'test',
      creem_api_key: maskSecret(cfg.creem_api_key),
      creem_api_key_set: !!cfg.creem_api_key,
      creem_webhook_secret: maskSecret(cfg.creem_webhook_secret),
      creem_webhook_secret_set: !!cfg.creem_webhook_secret,
      creem_environment: cfg.creem_environment || 'live',
    });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:payment-config:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});


// =========================================================================
// /brand/custom-domain — set CNAME-target domain + verify DNS resolution
// =========================================================================

adminExtrasRouter.patch('/brand/custom-domain', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const raw = (req.body?.custom_domain ?? '').toString().trim().toLowerCase();
  // Strip protocol + trailing slash
  const domain = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    res.status(400).json({ error: { type: 'invalid_domain', message: '请输入合法域名 (e.g. api.your-site.com)' } });
    return;
  }
  await query(
    `UPDATE tenant SET custom_domain = $2 WHERE id = $1`,
    [tenantId, domain || null],
  );
  logger.info({ tenantId, custom_domain: domain || null }, 'admin:brand:custom_domain:set');
  res.json({ ok: true, custom_domain: domain || null });
});

// =========================================================================
// /brand/cloudflare-cname — one-click CNAME via Cloudflare API
// =========================================================================
// Body: { cf_api_token, custom_domain, proxied?: false }
//
// Resolves the zone (root domain) on the reseller's CF account, creates a
// CNAME record pointing at <slug>.3api.pro. We DO NOT persist the CF token
// — it's used once per call.

adminExtrasRouter.post('/brand/cloudflare-cname', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const { cf_api_token, custom_domain, proxied } = req.body ?? {};

  if (typeof cf_api_token !== 'string' || cf_api_token.length < 20) {
    res.status(400).json({ error: { type: 'invalid_request', message: '请提供有效的 Cloudflare API Token' } });
    return;
  }
  const domain = String(custom_domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    res.status(400).json({ error: { type: 'invalid_domain', message: '请输入合法域名' } });
    return;
  }

  // Resolve tenant slug for target.
  const trows = await query<{ slug: string }>(
    `SELECT slug FROM tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  if (trows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'tenant not found' } });
    return;
  }
  const saas = (process.env.SAAS_DOMAIN || '3api.pro').toLowerCase();
  const target = `${trows[0].slug}.${saas}`;

  // Determine root domain — for X.Y.Z.tld we try Z.tld first.
  const parts = domain.split('.');
  const rootCandidates = parts.length >= 2 ? [parts.slice(-2).join('.'), parts.slice(-3).join('.')] : [domain];

  const cfHeaders = { 'Authorization': `Bearer ${cf_api_token}`, 'Content-Type': 'application/json' };

  // Step 1: find zone
  let zoneId: string | null = null;
  let zoneName: string | null = null;
  for (const root of rootCandidates) {
    if (!root || !root.includes('.')) continue;
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(root)}`, { headers: cfHeaders });
      const d: any = await r.json();
      if (r.ok && d.success && Array.isArray(d.result) && d.result.length > 0) {
        zoneId = d.result[0].id;
        zoneName = d.result[0].name;
        break;
      }
    } catch { /* try next */ }
  }
  if (!zoneId) {
    res.status(404).json({ error: { type: 'zone_not_found', message: `Cloudflare 上找不到该域名的 zone (尝试了: ${rootCandidates.join(', ')})。请确认 token 有权限 + 域名在 CF。` } });
    return;
  }

  // Step 2: create or update CNAME record
  const recordName = domain;
  const body = {
    type: 'CNAME',
    name: recordName,
    content: target,
    ttl: 1,
    proxied: proxied === true,
    comment: '3api auto-provisioned',
  };

  let recordRes: any;
  try {
    // Check if exists
    const list = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(recordName)}`, { headers: cfHeaders });
    const listD: any = await list.json();
    if (listD.success && Array.isArray(listD.result) && listD.result.length > 0) {
      // Update existing
      const recordId = listD.result[0].id;
      const u = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'PUT', headers: cfHeaders, body: JSON.stringify(body),
      });
      recordRes = await u.json();
      if (!u.ok || !recordRes.success) {
        const errMsg = (recordRes.errors && recordRes.errors[0]?.message) || 'cf_update_failed';
        res.status(400).json({ error: { type: 'cf_api_failed', message: `CF API 更新失败: ${errMsg}` } });
        return;
      }
    } else {
      // Create
      const c = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        method: 'POST', headers: cfHeaders, body: JSON.stringify(body),
      });
      recordRes = await c.json();
      if (!c.ok || !recordRes.success) {
        const errMsg = (recordRes.errors && recordRes.errors[0]?.message) || 'cf_create_failed';
        res.status(400).json({ error: { type: 'cf_api_failed', message: `CF API 创建失败: ${errMsg}` } });
        return;
      }
    }
  } catch (err: any) {
    res.status(500).json({ error: { type: 'cf_api_network', message: err.message } });
    return;
  }

  // Step 3: persist custom_domain to tenant
  await query(`UPDATE tenant SET custom_domain = $2 WHERE id = $1`, [tenantId, domain]);
  logger.info({ tenantId, domain, zone: zoneName, target, proxied: body.proxied }, 'admin:brand:cf_cname:created');

  res.json({
    ok: true,
    custom_domain: domain,
    zone: zoneName,
    target,
    proxied: body.proxied,
    note: body.proxied
      ? 'CF Proxy 已开启 (橙色云朵)，CF 提供 SSL。如想用平台 Caddy 的 LE 证书，关闭 Proxy。'
      : 'CF Proxy 已关闭 (灰色云朵)。平台 Caddy 会自动用 Let\'s Encrypt 给该域名签 SSL 证书 (首次访问可能需 10-30s)。',
  });
});

adminExtrasRouter.get('/brand/verify-domain', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const rows = await query<{ slug: string; custom_domain: string | null }>(
    `SELECT slug, custom_domain FROM tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'tenant not found' });
    return;
  }
  const { slug, custom_domain } = rows[0];
  if (!custom_domain) {
    res.json({ ok: false, reason: 'no_custom_domain', expected_target: null });
    return;
  }
  const saas = (process.env.SAAS_DOMAIN || '3api.pro').toLowerCase();
  const expectedTarget = `${slug}.${saas}`;
  try {
    const dns = await import('dns');
    const cnames = await new Promise<string[]>((resolve) => {
      dns.resolveCname(custom_domain, (err, recs) => {
        if (err) resolve([]);
        else resolve((recs || []).map((r) => r.toLowerCase().replace(/\.$/, '')));
      });
    });
    const ok = cnames.some((c) => c === expectedTarget.toLowerCase());
    res.json({
      ok,
      custom_domain,
      expected_target: expectedTarget,
      resolved_cnames: cnames,
      hint: ok
        ? '域名已正确指向 3api 平台, 客户访问会自动 SSL'
        : '请在你的域名 DNS 设置里加一条 CNAME 记录, 指向上面的 expected_target',
    });
  } catch (err: any) {
    res.json({ ok: false, custom_domain, expected_target: expectedTarget, err: err.message });
  }
});

