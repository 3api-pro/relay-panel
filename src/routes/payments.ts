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
