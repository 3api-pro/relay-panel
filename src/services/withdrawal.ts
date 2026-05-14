/**
 * Withdrawal lifecycle: request -> email-OTP confirm -> platform approve -> paid.
 *
 *   pending_confirm  — reseller submitted, OTP emailed, balance held (locked++)
 *   pending          — reseller entered correct OTP (within 60s window? we use
 *                       10min for usability), platform admin sees in queue
 *   approved         — platform admin clicked Approve (bank-payout in progress)
 *   paid             — payout completed; ledger debited gross_cents (split into
 *                      fee + net rows)
 *   rejected         — platform rejected; lock released back into spendable
 *   cancelled        — reseller cancelled before approval; lock released
 *
 * Fee: 3% of gross, kept by platform (recorded as withdrawal_fee row).
 * Net: gross - fee, what we wire to the bank.
 *
 * Security:
 *   - email OTP (6 digit) hashed (sha256) in DB; 10min TTL
 *   - reseller can only see/modify their own withdrawal_request rows
 *   - platform side requires PLATFORM_TOKEN header
 */
import crypto from 'crypto';
import { query, withTransaction } from './database';
import { logger } from './logger';
import { sendEmail } from './email-provider';
import {
  holdForWithdrawal,
  releaseWithdrawalHold,
  finalizeWithdrawalPaid,
  getWallet,
} from './wallet';

const OTP_TTL_MS = 10 * 60 * 1000;
const FEE_PCT = 3; // 3% platform fee on withdrawals

export interface WithdrawalDraft {
  tenantId: number;
  requestedBy: number;        // reseller_admin.id
  grossCents: number;
  currency: string;
  cardholderName: string;
  bankName?: string;
  cardNumber: string;
  swiftCode?: string;
  iban?: string;
  payoutCountry?: string;
  contactEmail: string;       // OTP destination
}

export interface WithdrawalRow {
  id: number;
  tenant_id: number;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  currency: string;
  status: string;
  cardholder_name: string;
  card_number: string;
  bank_name: string | null;
  swift_code: string | null;
  iban: string | null;
  payout_country: string | null;
  contact_email: string | null;
  platform_note: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function calcFee(gross: number): { fee: number; net: number } {
  // Round fee DOWN (favor user); platform never loses to rounding.
  const fee = Math.floor((gross * FEE_PCT) / 100);
  return { fee, net: gross - fee };
}

function genOtp(): { code: string; hash: string } {
  // 6-digit numeric OTP
  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  const hash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  return { code, hash };
}

/**
 * Submit a new withdrawal. Bumps locked_cents (throws if balance insufficient
 * or already locked elsewhere). Emails OTP to contact_email.
 *
 * Status transitions to 'pending' after OTP confirmation; until then no
 * platform queue entry is shown.
 */
export async function submitWithdrawal(draft: WithdrawalDraft, ip?: string | null): Promise<{ id: number; gross: number; fee: number; net: number; otp_sent_to: string }> {
  const wallet = await getWallet(draft.tenantId);
  const spendable = wallet.balance_cents - wallet.locked_cents;
  if (spendable < draft.grossCents) {
    throw Object.assign(new Error(`insufficient_balance: spendable=${spendable} requested=${draft.grossCents}`), { code: 'INSUFFICIENT_BALANCE' });
  }
  if (draft.grossCents <= 0) {
    throw Object.assign(new Error('amount must be positive'), { code: 'BAD_AMOUNT' });
  }

  const { fee, net } = calcFee(draft.grossCents);
  const { code, hash } = genOtp();

  const id = await withTransaction(async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO withdrawal_request
         (tenant_id, requested_by, gross_cents, fee_cents, net_cents, currency,
          cardholder_name, bank_name, card_number, swift_code, iban,
          payout_country, contact_email, confirm_code_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_confirm')
       RETURNING id`,
      [
        draft.tenantId, draft.requestedBy, draft.grossCents, fee, net, draft.currency,
        draft.cardholderName, draft.bankName ?? null, draft.cardNumber,
        draft.swiftCode ?? null, draft.iban ?? null, draft.payoutCountry ?? null,
        draft.contactEmail, hash,
      ],
    );
    return r.rows[0].id;
  });

  // Lock the gross outside of the create txn (own wallet txn).
  await holdForWithdrawal({
    tenantId: draft.tenantId,
    amountCents: draft.grossCents,
    withdrawalId: id,
    ip: ip ?? null,
  });

  // Best-effort email OTP. If email fails, the request stays in pending_confirm —
  // user can request a re-send.
  try {
    await sendEmail({
      to: draft.contactEmail,
      template: 'verify-email',  // reuse verify template — body data has email + verify_token slots
      tenantId: draft.tenantId,
      bypassCooldown: true,
      data: {
        email: draft.contactEmail,
        verify_token: `提现确认验证码: ${code}（10 分钟有效）。如非本人操作请忽略并立即修改密码。`,
      },
    });
  } catch (err: any) {
    logger.warn({ err: err.message, withdrawalId: id }, 'withdrawal:otp_email_fail');
  }

  logger.info({ withdrawalId: id, tenantId: draft.tenantId, gross: draft.grossCents, fee, net }, 'withdrawal:submitted');
  return { id, gross: draft.grossCents, fee, net, otp_sent_to: draft.contactEmail };
}

/**
 * Reseller confirms the OTP. Moves status pending_confirm -> pending.
 */
export async function confirmWithdrawal(opts: { withdrawalId: number; tenantId: number; otp: string }): Promise<void> {
  const hash = crypto.createHash('sha256').update(opts.otp, 'utf8').digest('hex');
  const rows = await query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending_confirm'`,
    [opts.withdrawalId, opts.tenantId],
  );
  if (rows.length === 0) throw Object.assign(new Error('not_found_or_already_confirmed'), { code: 'NOT_FOUND' });
  const row = rows[0];
  if (row.created_at && Date.now() - new Date(row.created_at as any).getTime() > OTP_TTL_MS) {
    throw Object.assign(new Error('otp_expired'), { code: 'OTP_EXPIRED' });
  }
  const expected = (row as any).confirm_code_hash;
  if (!expected || expected !== hash) {
    throw Object.assign(new Error('otp_mismatch'), { code: 'OTP_MISMATCH' });
  }
  await query(
    `UPDATE withdrawal_request
        SET status = 'pending', confirmed_at = now(), updated_at = now(),
            confirm_code_hash = NULL
      WHERE id = $1`,
    [opts.withdrawalId],
  );
  logger.info({ withdrawalId: opts.withdrawalId, tenantId: opts.tenantId }, 'withdrawal:confirmed');
}

export async function cancelWithdrawal(opts: { withdrawalId: number; tenantId: number }): Promise<void> {
  const rows = await query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request
      WHERE id = $1 AND tenant_id = $2
        AND status IN ('pending_confirm','pending')`,
    [opts.withdrawalId, opts.tenantId],
  );
  if (rows.length === 0) throw Object.assign(new Error('not_cancellable'), { code: 'BAD_STATE' });
  const row = rows[0];
  await query(
    `UPDATE withdrawal_request SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [opts.withdrawalId],
  );
  await releaseWithdrawalHold({
    tenantId: opts.tenantId,
    amountCents: row.gross_cents,
    withdrawalId: opts.withdrawalId,
    reason: 'cancelled',
  });
}

// ------ Platform-side -------------------------------------------------------

export async function listPlatformQueue(status: string[] = ['pending', 'approved']): Promise<WithdrawalRow[]> {
  return query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request WHERE status = ANY($1) ORDER BY created_at ASC LIMIT 200`,
    [status],
  );
}

export async function approveWithdrawal(opts: { withdrawalId: number; approvedBy: string; note?: string }): Promise<void> {
  const rows = await query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request WHERE id = $1 AND status = 'pending'`,
    [opts.withdrawalId],
  );
  if (rows.length === 0) throw Object.assign(new Error('not_pending'), { code: 'BAD_STATE' });
  await query(
    `UPDATE withdrawal_request
        SET status='approved', approved_by=$2, approved_at=now(),
            platform_note=$3, updated_at=now()
      WHERE id=$1`,
    [opts.withdrawalId, opts.approvedBy, opts.note ?? null],
  );
  logger.info({ withdrawalId: opts.withdrawalId, by: opts.approvedBy }, 'withdrawal:approved');
}

export async function rejectWithdrawal(opts: { withdrawalId: number; approvedBy: string; reason: string }): Promise<void> {
  const rows = await query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request WHERE id = $1 AND status IN ('pending','pending_confirm')`,
    [opts.withdrawalId],
  );
  if (rows.length === 0) throw Object.assign(new Error('not_rejectable'), { code: 'BAD_STATE' });
  const row = rows[0];
  await query(
    `UPDATE withdrawal_request
        SET status='rejected', approved_by=$2, approved_at=now(),
            platform_note=$3, updated_at=now()
      WHERE id=$1`,
    [opts.withdrawalId, opts.approvedBy, opts.reason],
  );
  await releaseWithdrawalHold({
    tenantId: row.tenant_id,
    amountCents: row.gross_cents,
    withdrawalId: opts.withdrawalId,
    reason: 'rejected',
  });
  logger.info({ withdrawalId: opts.withdrawalId, by: opts.approvedBy, reason: opts.reason }, 'withdrawal:rejected');
}

/**
 * Platform admin marks bank payout completed. Debits gross (split into
 * withdrawal_fee + withdrawal_paid rows; releases the lock).
 */
export async function markWithdrawalPaid(opts: { withdrawalId: number; approvedBy: string; bankTxnRef?: string }): Promise<void> {
  const rows = await query<WithdrawalRow>(
    `SELECT * FROM withdrawal_request WHERE id = $1 AND status = 'approved'`,
    [opts.withdrawalId],
  );
  if (rows.length === 0) throw Object.assign(new Error('not_approved'), { code: 'BAD_STATE' });
  const row = rows[0];
  await finalizeWithdrawalPaid({
    tenantId: row.tenant_id,
    grossCents: row.gross_cents,
    feeCents: row.fee_cents,
    withdrawalId: opts.withdrawalId,
    approvedBy: opts.approvedBy,
  });
  await query(
    `UPDATE withdrawal_request
        SET status='paid', paid_at=now(), platform_note=COALESCE(platform_note,'') || $2, updated_at=now()
      WHERE id=$1`,
    [opts.withdrawalId, opts.bankTxnRef ? `\n[bank_ref: ${opts.bankTxnRef}]` : ''],
  );
  logger.info({ withdrawalId: opts.withdrawalId, by: opts.approvedBy }, 'withdrawal:paid');
}
