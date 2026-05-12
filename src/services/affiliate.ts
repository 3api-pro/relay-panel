/**
 * Affiliate / referral service (v0.4 P2 #18).
 *
 * Reseller-to-reseller "site owner invites site owner" — A shares
 * https://3api.pro/create?ref=<aff_code>, B signs up, every paid order
 * from B's customers credits A 10% lifetime commission.
 *
 * The actual commission accumulation runs in a Postgres AFTER UPDATE
 * trigger on orders (see migration 012), so we never miss a paid event
 * regardless of which provider's webhook updated the row. This module
 * only handles:
 *   - recording the referral link at signup time (recordReferral)
 *   - aggregating numbers for the admin UI (getAffiliateStats /
 *     listReferrals / listWithdrawals)
 *   - filing withdrawal requests (requestWithdrawal)
 */
import { query } from './database';
import { logger } from './logger';

export interface AffiliateStats {
  aff_code: string | null;
  referred_count: number;
  active_referred_count: number;
  total_commission_cents: number;
  pending_withdrawal_cents: number;
  paid_withdrawal_cents: number;
  available_balance_cents: number;
  top_referrals: Array<{
    referred_tenant_id: number;
    slug: string;
    commission_cents: number;
    joined_at: string;
  }>;
}

export interface ReferralRow {
  id: number;
  referred_tenant_id: number;
  slug: string;
  commission_pct: number;
  commission_cents: number;
  status: string;
  joined_at: string;
  monthly_revenue_cents: number;
}

export interface WithdrawalRow {
  id: number;
  amount_cents: number;
  method: string | null;
  status: string;
  note: string | null;
  requested_at: string;
  processed_at: string | null;
}

/**
 * Record a referral link at signup time. Silently no-ops when:
 *   - referrerCode is blank / malformed
 *   - the code does not resolve to any tenant
 *   - the new tenant already has a referrer (UNIQUE on referred_tenant_id)
 *   - the referrer would be referring themselves
 *
 * Returns { ok: true } if the link row was inserted, { ok: false } otherwise.
 * Callers should treat this as advisory — a failed referral never blocks
 * the signup itself.
 */
export async function recordReferral(
  referrerCode: string,
  newTenantId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const code = (referrerCode || '').trim().toLowerCase();
  if (code.length < 4 || code.length > 16) return { ok: false, reason: 'bad_code_length' };

  try {
    const rows = await query<{ id: number }>(
      `SELECT id FROM tenant WHERE aff_code = $1 LIMIT 1`,
      [code],
    );
    if (rows.length === 0) return { ok: false, reason: 'unknown_code' };

    const referrerId = rows[0].id;
    if (referrerId === newTenantId) return { ok: false, reason: 'self_referral' };

    const ins = await query<{ id: number }>(
      `INSERT INTO reseller_referral
         (referrer_tenant_id, referred_tenant_id, commission_pct, status)
       VALUES ($1, $2, 10, 'active')
       ON CONFLICT (referred_tenant_id) DO NOTHING
       RETURNING id`,
      [referrerId, newTenantId],
    );
    if (ins.length === 0) return { ok: false, reason: 'already_referred' };

    logger.info(
      { referrerId, newTenantId, code },
      'affiliate:referral:recorded',
    );
    return { ok: true };
  } catch (err: any) {
    logger.warn({ err: err.message, code, newTenantId }, 'affiliate:referral:error');
    return { ok: false, reason: 'error' };
  }
}

/**
 * Aggregate stats for the admin /affiliate page. tenantId is the
 * *referrer* (always req.resellerAdmin.tenantId).
 */
export async function getAffiliateStats(tenantId: number): Promise<AffiliateStats> {
  const t = await query<{ aff_code: string | null }>(
    `SELECT aff_code FROM tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const aff_code = t[0]?.aff_code ?? null;

  const agg = await query<{
    referred_count: string;
    active_count: string;
    total_commission_cents: string;
  }>(
    `SELECT COUNT(*)::TEXT                                 AS referred_count,
            COUNT(*) FILTER (WHERE status='active')::TEXT  AS active_count,
            COALESCE(SUM(commission_cents),0)::TEXT        AS total_commission_cents
       FROM reseller_referral
      WHERE referrer_tenant_id = $1`,
    [tenantId],
  );

  const withdrawals = await query<{
    pending_cents: string;
    paid_cents: string;
  }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status='pending'),0)::TEXT AS pending_cents,
            COALESCE(SUM(amount_cents) FILTER (WHERE status='paid'),0)::TEXT    AS paid_cents
       FROM referral_withdrawal
      WHERE referrer_tenant_id = $1`,
    [tenantId],
  );

  const top = await query<{
    referred_tenant_id: number;
    slug: string;
    commission_cents: string;
    joined_at: string;
  }>(
    `SELECT r.referred_tenant_id,
            t.slug,
            r.commission_cents::TEXT AS commission_cents,
            r.joined_at
       FROM reseller_referral r
       JOIN tenant t ON t.id = r.referred_tenant_id
      WHERE r.referrer_tenant_id = $1
      ORDER BY r.commission_cents DESC, r.joined_at DESC
      LIMIT 10`,
    [tenantId],
  );

  const total = Number(agg[0]?.total_commission_cents ?? 0);
  const pending = Number(withdrawals[0]?.pending_cents ?? 0);
  const paid = Number(withdrawals[0]?.paid_cents ?? 0);

  return {
    aff_code,
    referred_count: Number(agg[0]?.referred_count ?? 0),
    active_referred_count: Number(agg[0]?.active_count ?? 0),
    total_commission_cents: total,
    pending_withdrawal_cents: pending,
    paid_withdrawal_cents: paid,
    available_balance_cents: Math.max(0, total - pending - paid),
    top_referrals: top.map((r) => ({
      referred_tenant_id: r.referred_tenant_id,
      slug: r.slug,
      commission_cents: Number(r.commission_cents),
      joined_at: r.joined_at,
    })),
  };
}

/**
 * Paginated list of referred tenants with monthly revenue snapshot.
 */
export async function listReferrals(
  tenantId: number,
  limit = 50,
  offset = 0,
): Promise<{ data: ReferralRow[]; total: number }> {
  const totalRows = await query<{ c: string }>(
    `SELECT COUNT(*)::TEXT AS c FROM reseller_referral WHERE referrer_tenant_id = $1`,
    [tenantId],
  );
  const data = await query<any>(
    `SELECT r.id,
            r.referred_tenant_id,
            t.slug,
            r.commission_pct,
            r.commission_cents::TEXT AS commission_cents,
            r.status,
            r.joined_at,
            COALESCE((
              SELECT SUM(o.amount_cents)
                FROM orders o
               WHERE o.tenant_id = r.referred_tenant_id
                 AND o.status = 'paid'
                 AND o.paid_at > NOW() - INTERVAL '30 days'
            ), 0)::TEXT AS monthly_revenue_cents
       FROM reseller_referral r
       JOIN tenant t ON t.id = r.referred_tenant_id
      WHERE r.referrer_tenant_id = $1
      ORDER BY r.joined_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return {
    total: Number(totalRows[0]?.c ?? 0),
    data: data.map((r) => ({
      id: r.id,
      referred_tenant_id: r.referred_tenant_id,
      slug: r.slug,
      commission_pct: r.commission_pct,
      commission_cents: Number(r.commission_cents),
      status: r.status,
      joined_at: r.joined_at,
      monthly_revenue_cents: Number(r.monthly_revenue_cents),
    })),
  };
}

/**
 * File a payout request. Validates the requested amount against
 * available_balance_cents (which already factors in pending + paid).
 */
export async function requestWithdrawal(
  tenantId: number,
  amountCents: number,
  method: string,
  accountInfo: string,
): Promise<{ ok: boolean; id?: number; reason?: string }> {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (amountCents > 10_000_000_00) {
    return { ok: false, reason: 'amount_too_large' };
  }
  const m = (method || '').toLowerCase();
  if (!['alipay', 'usdt', 'wholesale_credit', 'bank'].includes(m)) {
    return { ok: false, reason: 'invalid_method' };
  }
  if (!accountInfo || accountInfo.length < 2 || accountInfo.length > 256) {
    return { ok: false, reason: 'invalid_account' };
  }

  const stats = await getAffiliateStats(tenantId);
  if (amountCents > stats.available_balance_cents) {
    return { ok: false, reason: 'insufficient_balance' };
  }

  const ins = await query<{ id: number }>(
    `INSERT INTO referral_withdrawal
       (referrer_tenant_id, amount_cents, method, account_info, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [tenantId, amountCents, m, accountInfo],
  );
  logger.info(
    { tenantId, amountCents, method: m, withdrawalId: ins[0]?.id },
    'affiliate:withdrawal:filed',
  );
  return { ok: true, id: ins[0]?.id };
}

export async function listWithdrawals(
  tenantId: number,
  limit = 50,
  offset = 0,
): Promise<WithdrawalRow[]> {
  const rows = await query<any>(
    `SELECT id, amount_cents::TEXT AS amount_cents, method, status, note,
            requested_at, processed_at
       FROM referral_withdrawal
      WHERE referrer_tenant_id = $1
      ORDER BY requested_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map((r) => ({
    id: r.id,
    amount_cents: Number(r.amount_cents),
    method: r.method,
    status: r.status,
    note: r.note,
    requested_at: r.requested_at,
    processed_at: r.processed_at,
  }));
}
