/**
 * USDT collection — TRC20 (default) + ERC20 (opt-in).
 *
 * Strategy: per-order unique amount jitter. Customer transfers USDT to the
 * tenant's shared address; chain-watcher polls TronGrid / Etherscan,
 * matches by (network, address, expected_amount, within-TTL), and calls
 * confirmPaid().
 *
 * Why jitter not memo: TRON USDT has no memo/destination tag. Jitter to
 * 6-decimal place is the de-facto workaround.
 *
 * Tenant config (tenant.config -> 'payment_config'):
 *   usdt_trc20_address, usdt_erc20_address — at least one required.
 *
 * Watcher: src/services/payments/usdt-watcher.ts polls every 60s.
 */
import { config } from "../../config";
import { query, withTransaction } from "../database";
import { logger } from "../logger";

export type UsdtNetwork = "trc20" | "erc20";

async function loadTenantUsdtConfig(tenantId: number): Promise<{ trc20: string | null; erc20: string | null }> {
  const rows = await query<any>(
    "SELECT config->'payment_config' AS p FROM tenant WHERE id = $1 LIMIT 1",
    [tenantId],
  );
  const p = rows[0]?.p || {};
  return {
    trc20: p.usdt_trc20_address || config.usdtTrc20AddressFallback || null,
    erc20: p.usdt_erc20_address || config.usdtErc20AddressFallback || null,
  };
}

function computeExpectedAmount(orderId: number, amountCents: number, rate: number): number {
  const base = amountCents / 100 / rate;
  const jitterMicroUsdt = ((orderId * 1009) % 99999) + 1;
  const total = base + jitterMicroUsdt / 1_000_000;
  return Math.round(total * 1_000_000) / 1_000_000;
}

export interface CreateUsdtResult {
  network: UsdtNetwork;
  address: string;
  amount: number;
  amount_cny_cents: number;
  expires_at: string;
  order_id: number;
}

export async function createUsdtPay(
  order: { id: number; tenant_id: number; amount_cents: number; currency: string },
  preferred: UsdtNetwork = "trc20",
): Promise<CreateUsdtResult> {
  const cfg = await loadTenantUsdtConfig(order.tenant_id);
  let network: UsdtNetwork;
  if (preferred === "erc20" && cfg.erc20) network = "erc20";
  else if (cfg.trc20) network = "trc20";
  else if (cfg.erc20) network = "erc20";
  else throw Object.assign(new Error("usdt_not_configured"), { code: "USDT_NOT_CONFIGURED" });
  const address = network === "trc20" ? cfg.trc20! : cfg.erc20!;
  const expected = computeExpectedAmount(order.id, order.amount_cents, config.usdtCnyRate);
  const ttlMin = config.usdtPaymentTtlMinutes;

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO usdt_payment (order_id, tenant_id, network, address, expected_amount, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int || ' minutes')::interval, 'pending')
       ON CONFLICT (order_id) DO UPDATE
         SET network = EXCLUDED.network,
             address = EXCLUDED.address,
             expected_amount = EXCLUDED.expected_amount,
             expires_at = EXCLUDED.expires_at,
             status = 'pending'`,
      [order.id, order.tenant_id, network, address, expected, ttlMin],
    );

    const meta = {
      provider: "usdt",
      network,
      address,
      expected_amount: expected,
      amount_cny_cents: order.amount_cents,
    };
    await client.query("UPDATE orders SET payment_meta = payment_meta || $1::jsonb WHERE id = $2", [
      JSON.stringify(meta),
      order.id,
    ]);

    const row = await client.query<any>(
      "SELECT expires_at::text AS expires_at FROM usdt_payment WHERE order_id = $1",
      [order.id],
    );
    logger.info({ orderId: order.id, network, expected }, "usdt:create");
    return {
      network,
      address,
      amount: expected,
      amount_cny_cents: order.amount_cents,
      expires_at: row.rows[0].expires_at,
      order_id: order.id,
    };
  });
}

export async function checkUsdtOnce(orderId: number): Promise<{ status: string; matched_txn?: string | null }> {
  const rows = await query<any>(
    `SELECT u.network, u.address, u.expected_amount, u.status, u.matched_txn, u.expires_at
       FROM usdt_payment u
      WHERE u.order_id = $1
      LIMIT 1`,
    [orderId],
  );
  if (rows.length === 0) return { status: "not_found" };
  if (rows[0].status === "matched") return { status: "matched", matched_txn: rows[0].matched_txn };
  if (new Date(rows[0].expires_at) < new Date()) {
    await query("UPDATE usdt_payment SET status = 'expired' WHERE order_id = $1 AND status = 'pending'", [orderId]);
    return { status: "expired" };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pollOneOrder } = require("./usdt-watcher") as typeof import("./usdt-watcher");
  const m = await pollOneOrder(orderId);
  return { status: m.matched ? "matched" : "pending", matched_txn: m.matched_txn ?? null };
}

// ---- Chain integrations (REST, fetch only) --------------------------------

export interface ChainTxn {
  txn_hash: string;
  from: string;
  to: string;
  value_usdt: number;
  ts: number;
}

export async function fetchTronTrc20Incoming(address: string, limit = 30): Promise<ChainTxn[]> {
  try {
    const url = `${config.tronGridApi.replace(/\/+$/, "")}/v1/accounts/${address}/transactions/trc20?only_to=true&limit=${limit}&contract_address=${config.usdtTrc20Contract}`;
    const headers: Record<string, string> = {};
    if (config.tronGridApiKey) headers["TRON-PRO-API-KEY"] = config.tronGridApiKey;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      logger.warn({ status: resp.status, address }, "usdt:tron:fetch:bad-status");
      return [];
    }
    const j: any = await resp.json();
    if (!Array.isArray(j?.data)) return [];
    return j.data
      .filter((d: any) => d.type === "Transfer" || d.token_info?.symbol === "USDT")
      .map((d: any) => ({
        txn_hash: String(d.transaction_id || ""),
        from: String(d.from || ""),
        to: String(d.to || ""),
        value_usdt: Number(d.value) / 1_000_000,
        ts: Number(d.block_timestamp || 0),
      }));
  } catch (err: any) {
    logger.warn({ err: err.message, address }, "usdt:tron:fetch:throw");
    return [];
  }
}

export async function fetchEtherscanErc20Incoming(address: string, sinceMinutes = 60): Promise<ChainTxn[]> {
  if (!config.etherscanApiKey) {
    return [];
  }
  try {
    const url = `${config.etherscanApi}?module=account&action=tokentx&contractaddress=${config.usdtErc20Contract}&address=${address}&page=1&offset=30&sort=desc&apikey=${config.etherscanApiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const j: any = await resp.json();
    if (!Array.isArray(j?.result)) return [];
    const cutoff = Date.now() / 1000 - sinceMinutes * 60;
    return j.result
      .filter((t: any) => Number(t.timeStamp) > cutoff && String(t.to).toLowerCase() === address.toLowerCase())
      .map((t: any) => ({
        txn_hash: String(t.hash || ""),
        from: String(t.from || ""),
        to: String(t.to || ""),
        value_usdt: Number(t.value) / 1_000_000,
        ts: Number(t.timeStamp) * 1000,
      }));
  } catch (err: any) {
    logger.warn({ err: err.message, address }, "usdt:eth:fetch:throw");
    return [];
  }
}

/** Test seam — smoke insert into usdt_chain_observed_mock. */
export async function fetchMockObserved(address: string): Promise<ChainTxn[]> {
  try {
    const rows = await query<any>(
      `SELECT txn_hash, from_address AS "from", to_address AS "to", value_usdt, ts
         FROM usdt_chain_observed_mock
        WHERE to_address = $1
          AND consumed = FALSE`,
      [address],
    );
    return rows.map((r: any) => ({
      txn_hash: r.txn_hash,
      from: r.from,
      to: r.to,
      value_usdt: Number(r.value_usdt),
      ts: Number(r.ts),
    }));
  } catch {
    return [];
  }
}
