/**
 * USDT chain watcher — polls pending usdt_payment rows and matches
 * incoming TRC20 / ERC20 transfers against (address, expected_amount).
 *
 * Runs in-process via setInterval (default 60s). Disable via
 * USDT_WATCHER_ENABLED=off.
 *
 * Matching rule: exact match on expected_amount (6 decimals). We rely
 * on the jitter in usdt.ts to make this unique per pending order.
 *
 * Mock seam: usdt_chain_observed_mock (smoke creates the table) lets
 * the smoke insert fake TRC20 txns and watch the engine pick them up.
 */
import { config } from "../../config";
import { query, withTransaction } from "../database";
import { logger } from "../logger";
import { confirmPaid, creditWalletForPaidOrder } from "../order-engine";
import {
  fetchTronTrc20Incoming,
  fetchEtherscanErc20Incoming,
  fetchMockObserved,
  ChainTxn,
} from "./usdt";

let timer: NodeJS.Timeout | null = null;
const POLL_MS = 60_000;

export interface PollResult {
  matched: boolean;
  matched_txn?: string;
}

async function listChainTxns(network: "trc20" | "erc20", address: string): Promise<ChainTxn[]> {
  // Mock first — if present, prefer it (smoke).
  const mocked = await fetchMockObserved(address);
  if (mocked.length > 0) return mocked;
  if (network === "trc20") return fetchTronTrc20Incoming(address);
  return fetchEtherscanErc20Incoming(address);
}

/**
 * Match a list of chain txns against a (network, address, expected_amount).
 * Returns the matched txn hash if found.
 */
function findMatch(txns: ChainTxn[], expected: number): ChainTxn | null {
  for (const t of txns) {
    // 6-decimal precision — diff < 1 micro-USDT.
    if (Math.abs(t.value_usdt - expected) < 0.0000005) return t;
  }
  return null;
}

export async function pollOneOrder(orderId: number): Promise<PollResult> {
  const rows = await query<any>(
    `SELECT u.id, u.network, u.address, u.expected_amount::float AS expected_amount,
            u.expires_at, u.status, o.tenant_id, o.amount_cents
       FROM usdt_payment u
       JOIN orders o ON o.id = u.order_id
      WHERE u.order_id = $1
      LIMIT 1`,
    [orderId],
  );
  if (rows.length === 0) return { matched: false };
  const p = rows[0];
  if (p.status !== "pending") return { matched: p.status === "matched", matched_txn: undefined };
  if (new Date(p.expires_at) < new Date()) {
    await query(
      `UPDATE usdt_payment SET status = 'expired' WHERE order_id = $1 AND status = 'pending'`,
      [orderId],
    );
    return { matched: false };
  }

  await query(`UPDATE usdt_payment SET last_checked_at = NOW() WHERE order_id = $1`, [orderId]);
  const txns = await listChainTxns(p.network, p.address);
  const m = findMatch(txns, Number(p.expected_amount));
  if (!m) return { matched: false };

  // Atomic mark-matched + consume mock + confirmPaid.
  const claimed = await withTransaction(async (client) => {
    const cl = await client.query(
      `UPDATE usdt_payment SET status = 'matched', matched_txn = $1
        WHERE order_id = $2 AND status = 'pending'
        RETURNING id`,
      [m.txn_hash, orderId],
    );
    if (cl.rowCount === 0) return false;
    // Consume any mock row to avoid double-fire next poll.
    await client.query(
      `UPDATE usdt_chain_observed_mock SET consumed = TRUE WHERE txn_hash = $1`,
      [m.txn_hash],
    ).catch(() => undefined);
    return true;
  });
  if (!claimed) return { matched: false };

  try {
    const _paidResult = await confirmPaid(orderId, "usdt:" + p.network + ":" + m.txn_hash);
    await creditWalletForPaidOrder(_paidResult);
    logger.info(
      { orderId, network: p.network, txn: m.txn_hash, value: m.value_usdt },
      "usdt:watcher:matched",
    );
    return { matched: true, matched_txn: m.txn_hash };
  } catch (err: any) {
    logger.error({ err: err.message, orderId }, "usdt:watcher:confirmPaid:fail");
    return { matched: false };
  }
}

async function tick(): Promise<void> {
  try {
    const rows = await query<{ order_id: number }>(
      `SELECT order_id FROM usdt_payment
        WHERE status = 'pending' AND expires_at > NOW()
        ORDER BY id ASC LIMIT 50`,
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      await pollOneOrder(r.order_id).catch((e) =>
        logger.warn({ err: e.message, orderId: r.order_id }, "usdt:watcher:order:err"),
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "usdt:watcher:tick:err");
  }
}

export function startUsdtWatcher(): void {
  if (!config.usdtWatcherEnabled) {
    logger.info("usdt:watcher:disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  // Don't keep node alive solely on the watcher.
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  logger.info({ pollMs: POLL_MS }, "usdt:watcher:started");
}

export function stopUsdtWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
