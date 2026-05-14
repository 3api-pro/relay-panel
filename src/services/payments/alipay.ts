/**
 * Alipay 当面付 (PC scan QR) + 网页支付 (mobile).
 *
 * Why both: PC scan QR is the common Claude/Cursor user case; mobile
 * fallback covers "customer is paying from their phone".
 *
 * Credentials live in tenant.config -> 'payment_config' JSONB:
 *   { alipay_app_id, alipay_private_key, alipay_public_key }
 * Private key is RSA2 PKCS1. \n unescape applied before passing to SDK.
 *
 * Sandbox: set env ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do.
 *
 * Smoke note: when ALIPAY_GATEWAY=sandbox we short-circuit and return a
 * fake QR URL + accept any unsigned notify, so the smoke test does not
 * need real Alipay credentials.
 */
import { config } from "../../config";
import { getConfig } from "../app-config";
import { query } from "../database";
import { logger } from "../logger";
import { confirmPaid, creditWalletForPaidOrder } from "../order-engine";

function loadAlipaySdk(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("alipay-sdk");
  } catch (err: any) {
    logger.warn({ err: err.message }, "alipay:sdk:missing — falling back to mock");
    return null;
  }
}

export interface AlipayCreds {
  alipay_app_id: string;
  alipay_private_key: string;
  alipay_public_key: string;
}

async function loadAlipayCreds(tenantId: number): Promise<AlipayCreds | null> {
  // Resolution order: per-tenant payment_config -> platform app_config -> env fallback.
  const rows = await query<any>(
    "SELECT config->'payment_config' AS p FROM tenant WHERE id = $1 LIMIT 1",
    [tenantId],
  );
  const p = rows[0]?.p || {};
  const appId = p.alipay_app_id || getConfig('alipay_app_id') || config.alipayAppIdFallback;
  const pkRaw = p.alipay_private_key || getConfig('alipay_private_key') || config.alipayPrivateKeyFallback || "";
  const alipayPkRaw = p.alipay_public_key || getConfig('alipay_public_key') || config.alipayPublicKeyFallback || "";
  const pk = pkRaw.replace(/\\n/g, "\n");
  const alipayPk = alipayPkRaw.replace(/\\n/g, "\n");
  if (!appId || !pk || !alipayPk) return null;
  return { alipay_app_id: appId, alipay_private_key: pk, alipay_public_key: alipayPk };
}

export function isMockMode(): boolean {
  const g = (getConfig('alipay_gateway') || config.alipayGateway || "").toLowerCase();
  return g === "sandbox" || g === "" || g === "mock";
}

function getSdk(creds: AlipayCreds) {
  const mod = loadAlipaySdk();
  if (!mod) return null;
  const Cls = mod.AlipaySdk || mod.default;
  const gateway = getConfig('alipay_gateway') || config.alipayGateway;
  return new Cls({
    appId: creds.alipay_app_id,
    privateKey: creds.alipay_private_key,
    alipayPublicKey: creds.alipay_public_key,
    gateway,
    signType: "RSA2",
    timeout: 8000,
    camelcase: true,
  });
}

export interface CreatePayResult {
  out_trade_no: string;
  qr_code_url: string;
  mode: "mock" | "live";
}

export async function createAlipayQrPay(order: {
  id: number;
  tenant_id: number;
  amount_cents: number;
  currency: string;
}): Promise<CreatePayResult> {
  const outTradeNo = "order-" + order.id + "-" + Date.now();
  const subject = "3API Order #" + order.id;
  const totalAmount = (order.amount_cents / 100).toFixed(2);

  if (isMockMode()) {
    const qr = "https://qr.alipay.com/MOCK_QR_" + outTradeNo;
    await query(
      "UPDATE orders SET payment_meta = payment_meta || $1::jsonb WHERE id = $2",
      [
        JSON.stringify({
          provider: "alipay",
          mode: "mock",
          out_trade_no: outTradeNo,
          qr_code_url: qr,
          total_amount: totalAmount,
        }),
        order.id,
      ],
    );
    logger.info({ orderId: order.id, outTradeNo, mode: "mock" }, "alipay:create:mock");
    return { out_trade_no: outTradeNo, qr_code_url: qr, mode: "mock" };
  }

  const creds = await loadAlipayCreds(order.tenant_id);
  if (!creds) {
    throw Object.assign(new Error("alipay_not_configured"), { code: "ALIPAY_NOT_CONFIGURED" });
  }
  const sdk = getSdk(creds);
  if (!sdk) {
    throw Object.assign(new Error("alipay_sdk_missing"), { code: "ALIPAY_SDK_MISSING" });
  }
  const res = await sdk.exec("alipay.trade.precreate", {
    bizContent: {
      out_trade_no: outTradeNo,
      total_amount: totalAmount,
      subject,
      notify_url: config.publicBaseUrl.replace(/\/+$/, "") + "/api/payments/alipay/notify",
    },
  });
  if (!res || !res.qrCode) {
    logger.error({ orderId: order.id, res }, "alipay:create:bad-response");
    throw Object.assign(new Error("alipay_create_failed"), { code: "ALIPAY_CREATE_FAILED" });
  }
  await query(
    "UPDATE orders SET payment_meta = payment_meta || $1::jsonb WHERE id = $2",
    [
      JSON.stringify({
        provider: "alipay",
        mode: "live",
        out_trade_no: outTradeNo,
        qr_code_url: res.qrCode,
        total_amount: totalAmount,
      }),
      order.id,
    ],
  );
  logger.info({ orderId: order.id, outTradeNo, mode: "live" }, "alipay:create");
  return { out_trade_no: outTradeNo, qr_code_url: res.qrCode, mode: "live" };
}

export interface NotifyVerified {
  ok: boolean;
  order_id: number | null;
  total_amount: number | null;
  trade_no: string | null;
  reason?: string;
}

export async function verifyAlipayNotify(body: Record<string, any>): Promise<NotifyVerified> {
  const outTradeNo = String(body.out_trade_no || "");
  const tradeNo = String(body.trade_no || "");
  const totalStr = String(body.total_amount || "0");
  const tradeStatus = String(body.trade_status || "");

  const m = /^order-(\d+)-/.exec(outTradeNo);
  if (!m) return { ok: false, order_id: null, total_amount: null, trade_no: null, reason: "bad_out_trade_no" };
  const orderId = parseInt(m[1], 10);

  if (isMockMode()) {
    return {
      ok: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED",
      order_id: orderId,
      total_amount: Math.round(parseFloat(totalStr) * 100),
      trade_no: tradeNo,
      reason: tradeStatus === "TRADE_SUCCESS" ? undefined : "mock_unfinished",
    };
  }

  const rows = await query<any>("SELECT tenant_id FROM orders WHERE id = $1", [orderId]);
  if (rows.length === 0) return { ok: false, order_id: orderId, total_amount: null, trade_no: null, reason: "order_not_found" };
  const creds = await loadAlipayCreds(rows[0].tenant_id);
  if (!creds) return { ok: false, order_id: orderId, total_amount: null, trade_no: null, reason: "creds_missing" };
  const sdk = getSdk(creds);
  if (!sdk) return { ok: false, order_id: orderId, total_amount: null, trade_no: null, reason: "sdk_missing" };

  let sigOk = false;
  try {
    sigOk = sdk.checkNotifySign ? sdk.checkNotifySign(body) : false;
  } catch (err: any) {
    logger.warn({ err: err.message, orderId }, "alipay:notify:sig:throw");
  }
  if (!sigOk) {
    return { ok: false, order_id: orderId, total_amount: null, trade_no: null, reason: "bad_signature" };
  }
  if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "TRADE_FINISHED") {
    return { ok: false, order_id: orderId, total_amount: null, trade_no: tradeNo, reason: "trade_status_" + tradeStatus };
  }
  return {
    ok: true,
    order_id: orderId,
    total_amount: Math.round(parseFloat(totalStr) * 100),
    trade_no: tradeNo,
  };
}

export async function handleAlipayNotify(body: Record<string, any>): Promise<{ ok: boolean; reason?: string }> {
  const v = await verifyAlipayNotify(body);
  if (!v.ok || !v.order_id) {
    logger.warn({ body, reason: v.reason }, "alipay:notify:reject");
    return { ok: false, reason: v.reason };
  }
  await confirmPaid(v.order_id, "alipay:" + (v.trade_no || "unknown"));
  try { const r = await (await import("../order-engine")).confirmPaid(v.order_id, "alipay:" + (v.trade_no || "unknown")); /* idempotent re-call returns same row */ await creditWalletForPaidOrder(r); } catch(_) { /* logged inside */ }
  logger.info({ orderId: v.order_id, tradeNo: v.trade_no }, "alipay:notify:confirmed");
  return { ok: true };
}
