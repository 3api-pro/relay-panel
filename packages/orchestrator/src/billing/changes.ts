import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingQuotes, plans, subscriptions, type SubscriptionRow } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { withBillingTransaction } from './transaction.js';

const MONTH_MS = 30 * 86_400_000;
export interface BillingQuote {
  id: string;
  kind: 'purchase' | 'renewal' | 'upgrade' | 'downgrade';
  planKey: string;
  months: number;
  amount: number;
  monthlyPrice: number;
  effectiveAt: string;
  periodEnd: string;
  expiresAt: string;
  source: { id: number; planKey: string; periodEnd: string; monthlyPrice: number } | null;
}

/** Caller holds the operator lock. No network calls occur in this transaction. */
export async function applyDueChangeLocked(db: Db, operatorId: number): Promise<void> {
  const rows = await db.orm.select().from(subscriptions).where(and(eq(subscriptions.operatorId, operatorId), eq(subscriptions.status, 'active')));
  for (const row of rows) {
    const change = row.pendingChange;
    if (!change || fromPgTimestamp(change.effectiveAt).getTime() > Date.now()) continue;
    const end = toPgTimestamp(new Date(fromPgTimestamp(change.effectiveAt).getTime() + change.months * MONTH_MS));
    await db.orm.update(subscriptions).set({ planKey: change.planKey, monthlyPrice: change.monthlyPrice,
      currentPeriodEnd: end, status: change.months === 0 ? 'cancelled' : 'active', pendingChange: null,
      remindersSent: {}, updatedAt: toPgTimestamp(new Date()),
    }).where(eq(subscriptions.id, row.id));
    await writeAudit(db, { actor: 'system', action: 'billing.change.effective', ok: true,
      payload: { operatorId, subscriptionId: row.id, plan: change.planKey, effectiveAt: change.effectiveAt, orderNo: change.orderNo } });
  }
}

/** Reads and quota gates apply due changes too, even when the periodic worker is disabled. */
export async function applyDueChanges(db: Db, operatorId?: number): Promise<void> {
  const rows = await db.orm.select({ operatorId: subscriptions.operatorId }).from(subscriptions).where(and(
    eq(subscriptions.status, 'active'), sql`${subscriptions.pendingChange} IS NOT NULL`,
    sql`(${subscriptions.pendingChange}->>'effectiveAt')::timestamp <= timezone('UTC', now())`,
    ...(operatorId === undefined ? [] : [eq(subscriptions.operatorId, operatorId)]),
  ));
  for (const id of new Set(rows.map(row => row.operatorId))) {
    await withBillingTransaction(db, id, tx => applyDueChangeLocked(tx, id));
  }
}

async function current(db: Db, operatorId: number): Promise<SubscriptionRow | undefined> {
  const rows = await db.orm.select().from(subscriptions).where(and(eq(subscriptions.operatorId, operatorId),
    eq(subscriptions.status, 'active'))).orderBy(desc(subscriptions.currentPeriodEnd)).limit(2);
  if (rows.length > 1) throw new ApiError(409, '存在重复有效订阅，请先核实权益');
  return rows[0];
}

export async function quoteChange(db: Db, operatorId: number, planKey: string, months: number): Promise<BillingQuote> {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new ApiError(400, '无效的月数');
  return withBillingTransaction(db, operatorId, async tx => {
    await applyDueChangeLocked(tx, operatorId);
    const target = (await tx.orm.select().from(plans).where(eq(plans.key, planKey)))[0];
    if (!target?.active) throw new ApiError(404, '套餐不存在');
    const sub = await current(tx, operatorId);
    if (sub?.pendingChange) throw new ApiError(409, '已有到期变更安排，请先处理现有安排');
    const now = Date.now();
    const live = sub && fromPgTimestamp(sub.currentPeriodEnd).getTime() > now ? sub : undefined;
    const oldPlan = live ? (await tx.orm.select().from(plans).where(eq(plans.key, live.planKey)))[0] : undefined;
    if (live && !oldPlan) throw new ApiError(409, '当前套餐资料缺失，请联系管理员');
    const oldPrice = live?.monthlyPrice ?? oldPlan?.priceMonthly ?? 0;
    const kind = !live ? 'purchase' : live.planKey === planKey ? 'renewal'
      : target.priceMonthly > oldPrice ? 'upgrade' : 'downgrade';
    if (target.priceMonthly <= 0 && kind !== 'downgrade') throw new ApiError(400, '当前无需购买免费套餐');
    const price = kind === 'renewal' ? oldPrice : target.priceMonthly;
    const effective = kind === 'downgrade' ? live!.currentPeriodEnd : toPgTimestamp(new Date(now));
    const base = kind === 'renewal' ? fromPgTimestamp(live!.currentPeriodEnd).getTime()
      : kind === 'downgrade' ? fromPgTimestamp(effective).getTime() : now;
    const amount = kind === 'upgrade'
      ? Math.max(0.01, Math.ceil((Math.round(price * 100) - Math.round(oldPrice * 100)) *
        (fromPgTimestamp(live!.currentPeriodEnd).getTime() - now) / MONTH_MS) / 100)
      : Math.round(price * 100) * months / 100;
    const quote: BillingQuote = { id: randomUUID(), kind, planKey, months: kind === 'upgrade' || price === 0 ? 0 : months,
      amount, monthlyPrice: price, effectiveAt: effective,
      periodEnd: kind === 'upgrade' ? live!.currentPeriodEnd : toPgTimestamp(new Date(base + (price === 0 ? 0 : months) * MONTH_MS)),
      expiresAt: toPgTimestamp(new Date(Math.min(now + 5 * 60_000, live ? fromPgTimestamp(live.currentPeriodEnd).getTime() : Infinity))),
      source: live ? { id: live.id, planKey: live.planKey, periodEnd: live.currentPeriodEnd, monthlyPrice: oldPrice } : null,
    };
    // Bound preview records; orders retain their immutable snapshot independently.
    await tx.orm.delete(billingQuotes).where(and(eq(billingQuotes.operatorId, operatorId), sql`${billingQuotes.expiresAt} < timezone('UTC', now()) - interval '1 day'`));
    await tx.orm.insert(billingQuotes).values({ id: quote.id, operatorId, quote, expiresAt: quote.expiresAt });
    return quote;
  });
}

/** Checkout consumes a preview once under the same owner lock as order creation. */
export async function consumeQuoteLocked(db: Db, operatorId: number, id: string): Promise<BillingQuote> {
  const row = (await db.orm.select().from(billingQuotes).where(and(eq(billingQuotes.id, id), eq(billingQuotes.operatorId, operatorId)))).at(0);
  if (!row || row.usedAt || fromPgTimestamp(row.expiresAt).getTime() <= Date.now()) throw new ApiError(409, '报价已失效，请重新确认金额');
  await validateQuoteLocked(db, operatorId, row.quote);
  await db.orm.update(billingQuotes).set({ usedAt: toPgTimestamp(new Date()) }).where(and(eq(billingQuotes.id, id), isNull(billingQuotes.usedAt)));
  return row.quote;
}

export async function validateQuoteLocked(db: Db, operatorId: number, quote: BillingQuote): Promise<SubscriptionRow | undefined> {
  await applyDueChangeLocked(db, operatorId);
  let sub = await current(db, operatorId);
  if (!sub && quote.kind === 'renewal' && quote.source) {
    sub = (await db.orm.select().from(subscriptions).where(and(eq(subscriptions.id, quote.source.id),
      eq(subscriptions.operatorId, operatorId), eq(subscriptions.status, 'expired'))))[0];
  }
  const live = sub && fromPgTimestamp(sub.currentPeriodEnd).getTime() > Date.now() ? sub : undefined;
  const source = quote.source;
  // Same-plan renewals may stack. Cross-plan changes require the exact quoted term.
  const valid = !sub?.pendingChange && (source
    ? sub?.id === source.id && sub.planKey === source.planKey &&
      (sub.monthlyPrice === null || sub.monthlyPrice === source.monthlyPrice) &&
      (quote.kind === 'renewal' || (live && sub.currentPeriodEnd === source.periodEnd))
    : !live || (live.planKey === quote.planKey && live.monthlyPrice === quote.monthlyPrice));
  if (!valid) throw new ApiError(409, '订阅已变化，付款记录需核实后处理');
  return sub;
}

/** The entitlement and payment completion must commit in one transaction. */
export async function fulfillQuoteLocked(db: Db, operatorId: number, quote: BillingQuote, orderNo: string | null): Promise<SubscriptionRow> {
  const sub = await validateQuoteLocked(db, operatorId, quote);
  const now = Date.now();
  const nowPg = toPgTimestamp(new Date(now));
  if (quote.kind === 'downgrade') {
    const rows = await db.orm.update(subscriptions).set({ pendingChange: { planKey: quote.planKey,
      monthlyPrice: quote.monthlyPrice, months: quote.months, effectiveAt: sub!.currentPeriodEnd, orderNo }, updatedAt: nowPg,
    }).where(eq(subscriptions.id, sub!.id)).returning();
    return rows[0]!;
  }
  const end = quote.kind === 'upgrade' ? sub!.currentPeriodEnd
    : toPgTimestamp(new Date(Math.max(now, sub ? fromPgTimestamp(sub.currentPeriodEnd).getTime() : now) + quote.months * MONTH_MS));
  if (sub) {
    const rows = await db.orm.update(subscriptions).set({ planKey: quote.planKey, monthlyPrice: quote.monthlyPrice,
      currentPeriodEnd: end, status: 'active', pendingChange: null, remindersSent: {}, updatedAt: nowPg,
    }).where(eq(subscriptions.id, sub.id)).returning();
    return rows[0]!;
  }
  return (await db.orm.insert(subscriptions).values({ operatorId, planKey: quote.planKey,
    monthlyPrice: quote.monthlyPrice, currentPeriodEnd: end }).returning())[0]!;
}

export async function scheduleFreeDowngrade(db: Db, operatorId: number, quoteId: string): Promise<void> {
  await withBillingTransaction(db, operatorId, async tx => {
    const quote = await consumeQuoteLocked(tx, operatorId, quoteId);
    if (quote.amount !== 0 || quote.kind !== 'downgrade') throw new ApiError(400, '此变更需要先完成支付');
    await fulfillQuoteLocked(tx, operatorId, quote, null);
    await writeAudit(tx, { actor: 'operator', action: 'billing.change.scheduled', ok: true,
      payload: { operatorId, plan: quote.planKey, effectiveAt: quote.effectiveAt } });
  });
}

export async function cancelFreeDowngrade(db: Db, operatorId: number): Promise<void> {
  await withBillingTransaction(db, operatorId, async tx => {
    await applyDueChangeLocked(tx, operatorId);
    const sub = await current(tx, operatorId);
    if (!sub?.pendingChange) return;
    if (sub.pendingChange.orderNo) throw new ApiError(409, '已付款的到期变更需联系管理员处理');
    await tx.orm.update(subscriptions).set({ pendingChange: null, updatedAt: toPgTimestamp(new Date()) }).where(eq(subscriptions.id, sub.id));
    await writeAudit(tx, { actor: 'operator', action: 'billing.change.cancelled', ok: true, payload: { operatorId, subscriptionId: sub.id } });
  });
}
