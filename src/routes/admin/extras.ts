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
import { sendEmail } from '../../services/email-resend';

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
  const rows = await query<any>(
    `SELECT tenant_id, store_name, logo_url, primary_color, announcement, footer_html, contact_email, updated_at
       FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) {
    res.json({ tenant_id: tenantId, ...BRAND_DEFAULTS, updated_at: null });
    return;
  }
  res.json(rows[0]);
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
    });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:payment-config:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
