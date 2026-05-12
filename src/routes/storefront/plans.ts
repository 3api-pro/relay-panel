/**
 * Storefront public plan catalog + order endpoints.
 *
 * Mounted under /storefront with tenant-resolver and (where authenticated)
 * customer auth. Anonymous browsers can GET /plans; placing an order
 * requires an end_user session.
 */
import { Router, Request, Response } from 'express';
import { query } from '../../services/database';
import { authCustomer } from '../../middleware/auth-customer';
import { createOrder, confirmPaid } from '../../services/order-engine';
import { logger } from '../../services/logger';
import { getForTenant as getSystemSetting } from '../../services/system-setting';

export const storefrontPlansRouter = Router();

// --- public: list enabled plans for the tenant -----------------------------
storefrontPlansRouter.get('/plans', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const rows = await query<any>(
    `SELECT id, name, slug, period_days, quota_tokens, price_cents,
            allowed_models, sort_order
       FROM plans
      WHERE tenant_id = $1 AND enabled = TRUE
      ORDER BY sort_order ASC, id ASC`,
    [tenantId],
  );
  res.json({ data: rows });
});

// --- public: brand info + system announcement ------------------------------
// Combines brand_config (logo / colors / footer) with the system_setting
// announcement so the storefront only needs one fetch to render the banner.
storefrontPlansRouter.get('/brand', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const [brandRows, ss] = await Promise.all([
    query<any>(
      `SELECT store_name, logo_url, primary_color, announcement, footer_html, contact_email
         FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    ),
    getSystemSetting(tenantId).catch(() => null),
  ]);
  const base = brandRows[0] ?? { store_name: null, primary_color: '#6366f1' };
  res.json({
    ...base,
    // Surface system_setting announcement alongside brand. UI can pick the
    // system one (admin-controlled, latest) over brand.announcement.
    system_announcement: ss?.announcement ?? null,
    system_announcement_level: ss?.announcement_level ?? 'info',
    maintenance_mode: ss?.maintenance_mode ?? false,
    signup_enabled: ss?.signup_enabled ?? true,
  });
});

// --- authed: create order --------------------------------------------------
storefrontPlansRouter.post('/orders', authCustomer, async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const endUserId = req.endUser!.id;
  const planId = parseInt(String(req.body?.plan_id ?? ''), 10);
  const couponCode = req.body?.coupon_code ? String(req.body.coupon_code) : undefined;
  const paymentProvider = req.body?.payment_provider ? String(req.body.payment_provider) : undefined;
  // Allow client to supply its own idempotency key for retry safety.
  const idempotencyKey =
    typeof req.body?.idempotency_key === 'string' && req.body.idempotency_key.length > 0
      ? req.body.idempotency_key
      : (req.headers['idempotency-key'] as string | undefined);

  if (!planId) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'plan_id required' } });
    return;
  }

  try {
    const order = await createOrder({
      tenantId,
      endUserId,
      planId,
      couponCode,
      paymentProvider,
      idempotencyKey,
    });
    res.status(201).json({ order });
  } catch (err: any) {
    if (err.code === 'PLAN_NOT_FOUND') {
      res.status(404).json({ error: { type: 'not_found', message: 'plan not found' } });
      return;
    }
    if (err.code === 'PLAN_DISABLED') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'plan disabled' } });
      return;
    }
    logger.error({ err: err.message }, 'storefront:order:create:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// --- authed: list own orders ------------------------------------------------
storefrontPlansRouter.get('/orders', authCustomer, async (req: Request, res: Response) => {
  const u = req.endUser!;
  const rows = await query<any>(
    `SELECT o.id, o.plan_id, o.amount_cents, o.currency, o.status,
            o.payment_provider, o.created_at, o.paid_at, o.expires_at,
            p.name AS plan_name, p.slug AS plan_slug
       FROM orders o
       JOIN plans p ON p.id = o.plan_id
      WHERE o.tenant_id = $1 AND o.end_user_id = $2
      ORDER BY o.id DESC
      LIMIT 100`,
    [u.tenantId, u.id],
  );
  res.json({ data: rows });
});

// --- authed: list own subscriptions ----------------------------------------
storefrontPlansRouter.get('/subscriptions', authCustomer, async (req: Request, res: Response) => {
  const u = req.endUser!;
  const rows = await query<any>(
    `SELECT s.id, s.plan_id, s.plan_name, s.status, s.period_start, s.period_end,
            s.expires_at, s.remaining_tokens, s.order_id,
            p.quota_tokens AS plan_quota_tokens,
            (SELECT id FROM end_token WHERE subscription_id = s.id LIMIT 1) AS end_token_id
       FROM subscription s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1 AND s.end_user_id = $2
      ORDER BY s.id DESC`,
    [u.tenantId, u.id],
  );
  res.json({ data: rows });
});

// --- DEV ONLY: simulate payment confirmation -------------------------------
// In production this endpoint must be gated behind a payment-provider
// webhook handler. For P0 smoke testing we accept the call as long as
// caller is the order's end_user. The env STOREFRONT_DEV_PAY_ENABLED gate
// keeps it out of accidental production exposure.
storefrontPlansRouter.post(
  '/orders/:id/dev-confirm-paid',
  authCustomer,
  async (req: Request, res: Response) => {
    if ((process.env.STOREFRONT_DEV_PAY_ENABLED || '').toLowerCase() !== 'on') {
      res.status(503).json({
        error: { type: 'service_unavailable', message: 'dev-confirm-paid disabled — set STOREFRONT_DEV_PAY_ENABLED=on' },
      });
      return;
    }
    const u = req.endUser!;
    const orderId = parseInt(req.params.id, 10);
    const own = await query<{ id: number }>(
      `SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 AND end_user_id = $3 LIMIT 1`,
      [orderId, u.tenantId, u.id],
    );
    if (own.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'order not found' } });
      return;
    }

    try {
      const result = await confirmPaid(orderId, `dev-${Date.now()}`);
      res.json({
        ok: true,
        order: { id: result.order.id, status: result.order.status },
        subscription: result.subscription
          ? {
              id: result.subscription.id,
              remaining_tokens: result.subscription.remaining_tokens,
              expires_at: result.subscription.expires_at,
            }
          : null,
        api_token: result.api_token
          ? { id: result.api_token.id, key_prefix: result.api_token.key_prefix }
          : null,
        raw_key: result.raw_key || null,
        wholesale_shortage: result.wholesale_shortage,
      });
    } catch (err: any) {
      if (err.code === 'ORDER_NOT_FOUND') {
        res.status(404).json({ error: { type: 'not_found', message: 'order not found' } });
        return;
      }
      logger.error({ err: err.message }, 'storefront:dev_confirm_paid:error');
      res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
    }
  },
);
