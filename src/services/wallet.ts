/**
 * wallet — append-only ledger over wallet_balance + wallet_transaction.
 *
 * All movements go through credit() / debit() inside a SERIALIZABLE
 * transaction; balance_cents is the denormalised cache of
 * SUM(delta_cents). Reconciliation can be added as a periodic job.
 *
 * Idempotency:
 *   - pass `idempotencyKey`; the UNIQUE (tenant_id, idempotency_key) index
 *     guarantees a webhook delivered twice will not credit twice. A second
 *     call with the same key returns the original row without re-applying.
 *
 * locked_cents:
 *   - bumped by withdrawal_hold and decremented by withdrawal_release /
 *     withdrawal_paid. balance_cents stays unchanged on hold (still belongs
 *     to the reseller, just not spendable); on paid we subtract from both.
 */
import type { PoolClient } from 'pg';
import { withTransaction, query } from './database';
import { logger } from './logger';

export type WalletTxType =
  | 'order_credit'
  | 'order_refund'
  | 'topup_llmapi'
  | 'withdrawal_hold'
  | 'withdrawal_release'
  | 'withdrawal_fee'
  | 'withdrawal_paid'
  | 'adjustment';

export interface WalletTxInput {
  tenantId: number;
  deltaCents: number;
  type: WalletTxType;
  idempotencyKey?: string | null;
  reference?: string | null;
  note?: string | null;
  createdBy?: string;
  ip?: string | null;
  /** Only used for withdrawal_hold (delta is 0, locked_cents bumped). */
  alsoLockCents?: number;
  /** Only used for withdrawal_release/withdrawal_paid (locked_cents reduced). */
  alsoUnlockCents?: number;
}

export interface WalletBalance {
  tenant_id: number;
  balance_cents: number;
  locked_cents: number;
  currency: string;
}

async function ensureBalanceRow(client: PoolClient, tenantId: number): Promise<void> {
  await client.query(
    `INSERT INTO wallet_balance (tenant_id, balance_cents, locked_cents, currency)
     VALUES ($1, 0, 0, 'CNY')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
}

async function getBalanceRow(client: PoolClient, tenantId: number): Promise<WalletBalance> {
  const r = await client.query<WalletBalance>(
    `SELECT tenant_id, balance_cents, locked_cents, currency FROM wallet_balance WHERE tenant_id = $1 FOR UPDATE`,
    [tenantId],
  );
  if (r.rows.length === 0) {
    throw new Error(`wallet_balance row missing for tenant ${tenantId}`);
  }
  return r.rows[0] as any;
}

/**
 * Apply a wallet transaction inside the given transaction client. The caller
 * is responsible for holding the transaction (callers in this module always
 * wrap with withTransaction).
 *
 * Idempotency: if idempotencyKey is set and a row already exists for
 * (tenant_id, idempotency_key), we early-return WITHOUT mutating balance.
 *
 * Throws if the resulting balance would go negative (for debits).
 */
async function applyTx(
  client: PoolClient,
  inp: WalletTxInput,
): Promise<{ txId: number; balance: WalletBalance; duplicate: boolean }> {
  await ensureBalanceRow(client, inp.tenantId);

  // Idempotency early exit
  if (inp.idempotencyKey) {
    const dup = await client.query<{ id: number }>(
      `SELECT id FROM wallet_transaction
        WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [inp.tenantId, inp.idempotencyKey],
    );
    if (dup.rows.length > 0) {
      const bal = await getBalanceRow(client, inp.tenantId);
      return { txId: dup.rows[0].id, balance: bal, duplicate: true };
    }
  }

  const bal = await getBalanceRow(client, inp.tenantId);
  const newBalance = bal.balance_cents + inp.deltaCents;
  if (newBalance < 0) {
    throw new Error(`insufficient_balance: tenant=${inp.tenantId} balance=${bal.balance_cents} delta=${inp.deltaCents}`);
  }
  let newLocked = bal.locked_cents + (inp.alsoLockCents ?? 0) - (inp.alsoUnlockCents ?? 0);
  if (newLocked < 0) {
    throw new Error(`locked_underflow: tenant=${inp.tenantId} locked=${bal.locked_cents}`);
  }
  if (newLocked > newBalance) {
    throw new Error(`locked_exceeds_balance: tenant=${inp.tenantId} locked=${newLocked} balance=${newBalance}`);
  }

  const insRes = await client.query<{ id: number }>(
    `INSERT INTO wallet_transaction (tenant_id, delta_cents, type, idempotency_key, reference, note, created_by, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      inp.tenantId,
      inp.deltaCents,
      inp.type,
      inp.idempotencyKey ?? null,
      inp.reference ?? null,
      inp.note ?? null,
      inp.createdBy ?? 'system',
      inp.ip ?? null,
    ],
  );
  const txId = insRes.rows[0].id;

  await client.query(
    `UPDATE wallet_balance SET balance_cents = $2, locked_cents = $3, updated_at = now() WHERE tenant_id = $1`,
    [inp.tenantId, newBalance, newLocked],
  );

  return {
    txId,
    balance: { ...bal, balance_cents: newBalance, locked_cents: newLocked },
    duplicate: false,
  };
}

export async function creditOrder(opts: {
  tenantId: number;
  amountCents: number;
  orderId: number;
  provider: string;
  txExternalId?: string | null;
  ip?: string | null;
}): Promise<{ txId: number; duplicate: boolean; balanceCents: number }> {
  if (opts.amountCents <= 0) throw new Error('amount must be positive for order_credit');
  const idemKey = `order_credit:${opts.provider}:${opts.txExternalId || opts.orderId}`;
  return withTransaction(async (client) => {
    const r = await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: opts.amountCents,
      type: 'order_credit',
      idempotencyKey: idemKey,
      reference: String(opts.orderId),
      note: `order #${opts.orderId} via ${opts.provider}`,
      createdBy: 'payment-webhook',
      ip: opts.ip ?? null,
    });
    logger.info(
      {
        tenantId: opts.tenantId,
        orderId: opts.orderId,
        amount_cents: opts.amountCents,
        provider: opts.provider,
        duplicate: r.duplicate,
        balance_cents: r.balance.balance_cents,
      },
      'wallet:order_credit',
    );
    return { txId: r.txId, duplicate: r.duplicate, balanceCents: r.balance.balance_cents };
  });
}

export async function getWallet(tenantId: number): Promise<WalletBalance> {
  const r = await query<WalletBalance>(
    `SELECT tenant_id, balance_cents, locked_cents, currency FROM wallet_balance WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r.length === 0) {
    return { tenant_id: tenantId, balance_cents: 0, locked_cents: 0, currency: 'CNY' };
  }
  return r[0] as any;
}

export async function listTransactions(
  tenantId: number,
  limit = 50,
): Promise<Array<{ id: number; delta_cents: number; type: string; reference: string | null; note: string | null; created_at: Date }>> {
  return query(
    `SELECT id, delta_cents, type, reference, note, created_at
       FROM wallet_transaction
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, Math.min(Math.max(limit, 1), 500)],
  );
}

/**
 * Hold balance for a pending withdrawal. Bumps locked_cents WITHOUT changing
 * balance (money still belongs to the reseller, just not spendable).
 */
export async function holdForWithdrawal(opts: {
  tenantId: number;
  amountCents: number;
  withdrawalId: number;
  ip?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const r = await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: 0,
      type: 'withdrawal_hold',
      idempotencyKey: `withdrawal_hold:${opts.withdrawalId}`,
      reference: String(opts.withdrawalId),
      note: `hold for withdrawal #${opts.withdrawalId}`,
      createdBy: 'withdrawal-request',
      ip: opts.ip ?? null,
      alsoLockCents: opts.amountCents,
    });
    logger.info({ tenantId: opts.tenantId, withdrawalId: opts.withdrawalId, lock: opts.amountCents, duplicate: r.duplicate }, 'wallet:withdrawal_hold');
  });
}

export async function releaseWithdrawalHold(opts: {
  tenantId: number;
  amountCents: number;
  withdrawalId: number;
  reason: 'rejected' | 'cancelled';
}): Promise<void> {
  await withTransaction(async (client) => {
    await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: 0,
      type: 'withdrawal_release',
      idempotencyKey: `withdrawal_release:${opts.withdrawalId}`,
      reference: String(opts.withdrawalId),
      note: `release hold (${opts.reason}) for withdrawal #${opts.withdrawalId}`,
      createdBy: `withdrawal-${opts.reason}`,
      alsoUnlockCents: opts.amountCents,
    });
  });
}

/**
 * Mark withdrawal paid: deduct gross from balance + locked, take fee.
 * Two ledger rows so the audit trail shows the fee discretely.
 */
export async function finalizeWithdrawalPaid(opts: {
  tenantId: number;
  grossCents: number;
  feeCents: number;
  withdrawalId: number;
  approvedBy: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    // Fee row (negative, no lock change — we lock the gross, so this just moves it)
    await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: -opts.feeCents,
      type: 'withdrawal_fee',
      idempotencyKey: `withdrawal_fee:${opts.withdrawalId}`,
      reference: String(opts.withdrawalId),
      note: `3% platform fee on withdrawal #${opts.withdrawalId}`,
      createdBy: opts.approvedBy,
    });
    // Net row (negative, drains the lock equally)
    await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: -(opts.grossCents - opts.feeCents),
      type: 'withdrawal_paid',
      idempotencyKey: `withdrawal_paid:${opts.withdrawalId}`,
      reference: String(opts.withdrawalId),
      note: `bank payout for withdrawal #${opts.withdrawalId}`,
      createdBy: opts.approvedBy,
      alsoUnlockCents: opts.grossCents,
    });
  });
}

export async function debitTopupLlmapi(opts: {
  tenantId: number;
  amountCents: number;
  topupId: number;
  ip?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    await applyTx(client, {
      tenantId: opts.tenantId,
      deltaCents: -opts.amountCents,
      type: 'topup_llmapi',
      idempotencyKey: `topup_llmapi:${opts.topupId}`,
      reference: String(opts.topupId),
      note: `apply wallet balance to llmapi sub via topup #${opts.topupId}`,
      createdBy: 'topup-llmapi',
      ip: opts.ip ?? null,
    });
  });
}
