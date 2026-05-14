/**
 * Payment routes — surface for Alipay + USDT.
 *
 * Public webhooks (no auth):
 *   POST /payments/alipay/notify           — Alipay async notify (form-urlencoded)
 *
 * Authed (customer JWT):
 *   POST /storefront/payments/alipay/create
 *   POST /storefront/payments/usdt/create
 *   POST /storefront/payments/usdt/check
 *
 * For convenience the webhook is also mounted at /api/payments/...
 * (see src/index.ts).
 */
import { Router, Request, Response } from "express";
import express from "express";
import { authCustomer } from "../middleware/auth-customer";
import { query } from "../services/database";
import { logger } from "../services/logger";
import { createAlipayQrPay, handleAlipayNotify } from "../services/payments/alipay";
import { createUsdtPay, checkUsdtOnce, UsdtNetwork } from "../services/payments/usdt";
import { createPaypalOrder, capturePaypalOrder, isPaypalConfigured } from "../services/payments/paypal";
import { createCreemCheckout, verifyCreemSignature, isCreemConfigured } from "../services/payments/creem";
import { confirmPaid, creditWalletForPaidOrder } from "../services/order-engine";
import { config } from "../config";

export const paymentsRouter = Router();

// --- Webhook (form-urlencoded, public, no tenant resolution required) ------
paymentsRouter.post(
  "/alipay/notify",
  express.urlencoded({ extended: true, limit: "100kb" }),
  async (req: Request, res: Response) => {
    try {
      const body: Record<string, any> = (req.body as Record<string, any>) || {};
      const result = await handleAlipayNotify(body);
      if (!result.ok) {
        // Alipay retries unless we return literal "success"; "fail" tells them
        // to retry. Send "fail" so they retry on transient errors, but log.
        logger.warn({ reason: result.reason }, "alipay:notify:reject");
        res.status(400).send("fail");
        return;
      }
      res.status(200).send("success");
    } catch (err: any) {
      logger.error({ err: err.message }, "alipay:notify:err");
      res.status(500).send("fail");
    }
  },
);

// --- Authed: create alipay QR ---------------------------------------------
export const storefrontPaymentsRouter = Router();

async function loadOrderForUser(orderId: number, tenantId: number, endUserId: number) {
  const rows = await query<any>(
    `SELECT id, tenant_id, end_user_id, plan_id, amount_cents, currency, status, payment_meta
       FROM orders WHERE id = $1 AND tenant_id = $2 AND end_user_id = $3 LIMIT 1`,
    [orderId, tenantId, endUserId],
  );
  return rows[0] || null;
}

storefrontPaymentsRouter.post(
  "/alipay/create",
  authCustomer,
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const u = req.endUser!;
    const orderId = parseInt(String(req.body?.order_id ?? ""), 10);
    if (!orderId) {
      res.status(400).json({ error: { type: "invalid_request_error", message: "order_id required" } });
      return;
    }
    const order = await loadOrderForUser(orderId, tenantId, u.id);
    if (!order) {
      res.status(404).json({ error: { type: "not_found", message: "order not found" } });
      return;
    }
    if (order.status !== "pending") {
      res.status(409).json({ error: { type: "conflict", message: "order_status_" + order.status } });
      return;
    }
    try {
      const out = await createAlipayQrPay(order);
      res.json({
        ok: true,
        order_id: orderId,
        provider: "alipay",
        out_trade_no: out.out_trade_no,
        qr_code_url: out.qr_code_url,
        mode: out.mode,
      });
    } catch (err: any) {
      logger.error({ err: err.message, orderId }, "alipay:create:err");
      res.status(500).json({ error: { type: "internal_error", message: err.message } });
    }
  },
);

storefrontPaymentsRouter.post(
  "/usdt/create",
  authCustomer,
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const u = req.endUser!;
    const orderId = parseInt(String(req.body?.order_id ?? ""), 10);
    const network: UsdtNetwork = req.body?.network === "erc20" ? "erc20" : "trc20";
    if (!orderId) {
      res.status(400).json({ error: { type: "invalid_request_error", message: "order_id required" } });
      return;
    }
    const order = await loadOrderForUser(orderId, tenantId, u.id);
    if (!order) {
      res.status(404).json({ error: { type: "not_found", message: "order not found" } });
      return;
    }
    if (order.status !== "pending") {
      res.status(409).json({ error: { type: "conflict", message: "order_status_" + order.status } });
      return;
    }
    try {
      const out = await createUsdtPay(order, network);
      res.json({
        ok: true,
        provider: "usdt",
        ...out,
      });
    } catch (err: any) {
      if (err.code === "USDT_NOT_CONFIGURED") {
        res.status(503).json({
          error: { type: "service_unavailable", message: "usdt not configured for this tenant" },
        });
        return;
      }
      logger.error({ err: err.message, orderId }, "usdt:create:err");
      res.status(500).json({ error: { type: "internal_error", message: err.message } });
    }
  },
);

storefrontPaymentsRouter.post(
  "/usdt/check",
  authCustomer,
  async (req: Request, res: Response) => {
    const u = req.endUser!;
    const orderId = parseInt(String(req.body?.order_id ?? ""), 10);
    if (!orderId) {
      res.status(400).json({ error: { type: "invalid_request_error", message: "order_id required" } });
      return;
    }
    const order = await loadOrderForUser(orderId, u.tenantId, u.id);
    if (!order) {
      res.status(404).json({ error: { type: "not_found", message: "order not found" } });
      return;
    }
    const r = await checkUsdtOnce(orderId);
    res.json({ ok: true, order_id: orderId, ...r, order_status: order.status });
  },
);


// =============================================================================
// PayPal (国际信用卡)
// =============================================================================
// POST /storefront/payments/paypal/create
//   Body: { order_id }
//   Returns: { paypal_order_id, approve_url }
storefrontPaymentsRouter.post("/paypal/create", async (req, res) => {
  try {
    const { order_id } = req.body ?? {};
    if (typeof order_id !== "number") {
      res.status(400).json({ error: { type: "invalid_request", message: "order_id required" } });
      return;
    }
    if (!isPaypalConfigured()) {
      res.status(503).json({ error: { type: "not_configured", message: "PayPal not configured" } });
      return;
    }
    const orderRows = await query<any>(
      `SELECT id, tenant_id, amount_cents, currency, status FROM orders WHERE id=$1 AND tenant_id=$2`,
      [order_id, req.tenantId!],
    );
    if (orderRows.length === 0) {
      res.status(404).json({ error: { type: "not_found", message: "order not found" } });
      return;
    }
    const order = orderRows[0];
    if (order.status !== "pending") {
      res.status(400).json({ error: { type: "bad_state", message: `order status=${order.status}` } });
      return;
    }
    const base = (config.publicBaseUrl || "").replace(/\/$/, "");
    const result = await createPaypalOrder({
      orderId: order.id,
      amountCents: order.amount_cents,
      currency: order.currency || "USD",
      returnUrl: `${base}/storefront/payments/paypal/return`,
      cancelUrl: `${base}/storefront/payments/paypal/cancel`,
    });
    await query<any>(
      `UPDATE orders SET payment_provider='paypal', payment_meta = payment_meta || $2::jsonb WHERE id=$1`,
      [order.id, JSON.stringify({ paypal_order_id: result.paypal_order_id })],
    );
    res.json(result);
  } catch (err: any) {
    logger.error({ err: err.message }, "paypal:create:err");
    res.status(500).json({ error: { type: "internal", message: err.message } });
  }
});

// GET /storefront/payments/paypal/return?token=<paypalOrderId>
// PayPal redirects user here after approval. We capture, mark paid, redirect.
storefrontPaymentsRouter.get("/paypal/return", async (req, res) => {
  try {
    const ppOrderId = String(req.query.token || "");
    if (!ppOrderId) { res.status(400).send("missing token"); return; }
    const cap = await capturePaypalOrder(ppOrderId);
    if (cap.status !== "COMPLETED") {
      res.status(400).send(`PayPal capture status: ${cap.status}`);
      return;
    }
    const ourOrderId = parseInt(cap.custom_id, 10);
    if (!ourOrderId) { res.status(400).send("invalid custom_id"); return; }
    const result = await confirmPaid(ourOrderId, `paypal:${cap.capture_id}`);
    await creditWalletForPaidOrder(result);
    // Redirect to a success page on the storefront.
    res.redirect(302, `/dashboard?payment=success&order=${ourOrderId}`);
  } catch (err: any) {
    logger.error({ err: err.message }, "paypal:return:err");
    res.status(500).send(`PayPal 处理失败: ${err.message}`);
  }
});

storefrontPaymentsRouter.get("/paypal/cancel", (_req, res) => {
  res.redirect(302, `/dashboard?payment=cancelled`);
});

// =============================================================================
// Creem (国际信用卡 MoR)
// =============================================================================
// POST /storefront/payments/creem/create
storefrontPaymentsRouter.post("/creem/create", async (req, res) => {
  try {
    const { order_id, product_id } = req.body ?? {};
    if (typeof order_id !== "number" || typeof product_id !== "string") {
      res.status(400).json({ error: { type: "invalid_request", message: "order_id + product_id required" } });
      return;
    }
    if (!isCreemConfigured()) {
      res.status(503).json({ error: { type: "not_configured", message: "Creem not configured" } });
      return;
    }
    const orderRows = await query<any>(
      `SELECT id, tenant_id, amount_cents, status FROM orders WHERE id=$1 AND tenant_id=$2`,
      [order_id, req.tenantId!],
    );
    if (orderRows.length === 0) { res.status(404).json({ error: "not found" }); return; }
    const order = orderRows[0];
    if (order.status !== "pending") {
      res.status(400).json({ error: { type: "bad_state", message: `order status=${order.status}` } });
      return;
    }
    const base = (config.publicBaseUrl || "").replace(/\/$/, "");
    const result = await createCreemCheckout({
      orderId: order.id,
      productId: product_id,
      successUrl: `${base}/dashboard?payment=success&order=${order.id}`,
      cancelUrl: `${base}/dashboard?payment=cancelled`,
    });
    await query<any>(
      `UPDATE orders SET payment_provider='creem', payment_meta = payment_meta || $2::jsonb WHERE id=$1`,
      [order.id, JSON.stringify({ creem_checkout_id: result.checkout_id })],
    );
    res.json(result);
  } catch (err: any) {
    logger.error({ err: err.message }, "creem:create:err");
    res.status(500).json({ error: { type: "internal", message: err.message } });
  }
});

// POST /payments/creem/webhook (no auth — HMAC verified)
paymentsRouter.post(
  "/creem/webhook",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    try {
      const sig = (req.headers["creem-signature"] as string | undefined) || "";
      const raw = (req.body as Buffer).toString("utf8");
      if (!verifyCreemSignature(raw, sig)) {
        logger.warn("creem:webhook:bad_sig");
        res.status(401).json({ error: "bad signature" });
        return;
      }
      const evt = JSON.parse(raw);
      // Looking for checkout.completed events; metadata.order_id maps back.
      const eventType = evt.eventType || evt.type || "";
      if (eventType.indexOf("completed") < 0 && eventType.indexOf("paid") < 0) {
        res.json({ ok: true, ignored: eventType });
        return;
      }
      const orderId = parseInt((evt.data?.metadata?.order_id || evt.metadata?.order_id || "0"), 10);
      if (!orderId) { res.status(400).json({ error: "no order_id" }); return; }
      const result = await confirmPaid(orderId, `creem:${evt.data?.id || evt.id || "unknown"}`);
      await creditWalletForPaidOrder(result);
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err: err.message }, "creem:webhook:err");
      res.status(500).json({ error: err.message });
    }
  }
);
