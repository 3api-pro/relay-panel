import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { billingQuotes, paymentOrders, plans, subscriptions } from '../src/db/schema.js';
import { fromPgTimestamp, toPgTimestamp } from '../src/auth/sessions.js';
import { applyDueChanges, cancelFreeDowngrade, consumeQuoteLocked, fulfillQuoteLocked, quoteChange, scheduleFreeDowngrade } from '../src/billing/changes.js';
import { withBillingTransaction } from '../src/billing/transaction.js';
import { quotaFor, subscribeOperator } from '../src/billing/service.js';
import { PaymentsService } from '../src/billing/payments/service.js';
import { makeTestConfig, makeTestDb, seedOperator } from './helpers.js';
import type { Db } from '../src/db/client.js';

vi.setConfig({ testTimeout: 30_000 });
describe('subscription changes (embedded PostgreSQL)', () => {
  let db: Db; let owner: number;
  const day = 86_400_000;
  beforeEach(async () => { db = await makeTestDb(); owner = await seedOperator(db, { role: 'operator' }); });
  afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
  async function seed(planKey = 'pro', days = 15) {
    const price = planKey === 'pro' ? 29 : 99;
    return (await db.orm.insert(subscriptions).values({ operatorId: owner, planKey, monthlyPrice: price,
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() + days * day)) }).returning())[0]!;
  }
  async function pay(quote: Awaited<ReturnType<typeof quoteChange>>, orderNo = 'payment') {
    await db.orm.insert(paymentOrders).values({ orderNo, operatorId: owner, planKey: quote.planKey,
      months: quote.months, amount: quote.amount, providerKey: 'alipay', status: 'paid', fulfillmentVersion: 1, billingQuote: quote });
    await new PaymentsService({ db, config: makeTestConfig() }).confirmOrder(orderNo);
  }
  it('half a 30-day term charges half the price difference and never extends the expiry', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const before = await seed();
    const quote = await quoteChange(db, owner, 'scale', 12);
    expect(quote).toMatchObject({ kind: 'upgrade', amount: 35, months: 0 });
    await pay(quote);
    expect((await db.orm.select().from(subscriptions))[0]).toMatchObject({ planKey: 'scale', monthlyPrice: 99, currentPeriodEnd: before.currentPeriodEnd });
    await new PaymentsService({ db, config: makeTestConfig() }).confirmOrder('payment');
    expect((await db.orm.select().from(subscriptions))[0]!.currentPeriodEnd).toBe(before.currentPeriodEnd);
  });
  it('prorates the entire prepaid remaining term, with cents rounded up', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    await seed('pro', 45.001);
    expect((await quoteChange(db, owner, 'scale', 1)).amount).toBe(105.01);
  });
  it('paid downgrade preserves the current plan and quota until the boundary, then activates once', async () => {
    const before = await seed('scale');
    const quote = await quoteChange(db, owner, 'pro', 2);
    expect(quote).toMatchObject({ kind: 'downgrade', amount: 58, effectiveAt: before.currentPeriodEnd });
    await pay(quote);
    expect((await db.orm.select().from(subscriptions))[0]!.planKey).toBe('scale');
    const change = (await db.orm.select().from(subscriptions))[0]!.pendingChange!;
    const effective = toPgTimestamp(new Date(Date.now() - 1000));
    await db.orm.update(subscriptions).set({ currentPeriodEnd: effective, pendingChange: { ...change, effectiveAt: effective } }).where(eq(subscriptions.id, before.id));
    expect(await quotaFor(db, { operatorId: owner, role: 'operator' }, 3)).toBe(5);
    const after = (await db.orm.select().from(subscriptions))[0]!;
    expect(after).toMatchObject({ planKey: 'pro', monthlyPrice: 29, pendingChange: null });
    expect(fromPgTimestamp(after.currentPeriodEnd).getTime()).toBe(fromPgTimestamp(effective).getTime() + 60 * day);
    await applyDueChanges(db);
    expect((await db.orm.select().from(subscriptions))[0]!.currentPeriodEnd).toBe(after.currentPeriodEnd);
  });
  it('free downgrade is cancelable before expiry and takes effect without extending old grace', async () => {
    const before = await seed();
    await scheduleFreeDowngrade(db, owner, (await quoteChange(db, owner, 'free', 1)).id);
    await cancelFreeDowngrade(db, owner);
    expect((await db.orm.select().from(subscriptions))[0]!.pendingChange).toBeNull();
    await scheduleFreeDowngrade(db, owner, (await quoteChange(db, owner, 'free', 1)).id);
    const change = (await db.orm.select().from(subscriptions))[0]!.pendingChange!;
    const effective = toPgTimestamp(new Date(Date.now() - 1000));
    await db.orm.update(subscriptions).set({ pendingChange: { ...change, effectiveAt: effective }, currentPeriodEnd: effective }).where(eq(subscriptions.id, before.id));
    expect(await quotaFor(db, { operatorId: owner, role: 'operator' }, 3)).toBe(1);
    expect((await db.orm.select().from(subscriptions))[0]!.status).toBe('cancelled');
  });
  it('stale upgrade payment stays paid for review and cannot overwrite renewed rights', async () => {
    await seed(); const quote = await quoteChange(db, owner, 'scale', 1);
    const renewed = await subscribeOperator(db, { operatorId: owner, planKey: 'pro', months: 1 });
    await expect(pay(quote)).rejects.toMatchObject({ statusCode: 503 });
    expect((await db.orm.select().from(paymentOrders))[0]).toMatchObject({ status: 'paid', reconciliationError: 'subscription_changed_requires_review' });
    expect((await db.orm.select().from(subscriptions))[0]).toMatchObject({ planKey: 'pro', currentPeriodEnd: renewed.currentPeriodEnd });
  });
  it('two same-plan renewals stack, including a quote paid after the expiry worker ran', async () => {
    const before = await seed();
    const first = await quoteChange(db, owner, 'pro', 1); const second = await quoteChange(db, owner, 'pro', 2);
    await Promise.all([pay(first, 'a'), pay(second, 'b')]);
    expect(fromPgTimestamp((await db.orm.select().from(subscriptions))[0]!.currentPeriodEnd).getTime()).toBe(fromPgTimestamp(before.currentPeriodEnd).getTime() + 90 * day);
    const late = await quoteChange(db, owner, 'pro', 1);
    await db.orm.update(subscriptions).set({ status: 'expired', currentPeriodEnd: toPgTimestamp(new Date(Date.now() - day)) });
    await pay(late, 'late');
    expect((await db.orm.select().from(subscriptions))[0]!.status).toBe('active');
  });
  it('two first-purchase orders for the same plan preserve both purchased periods', async () => {
    const first = await quoteChange(db, owner, 'pro', 1);
    const second = await quoteChange(db, owner, 'pro', 2);
    const before = Date.now();
    await Promise.all([pay(first, 'purchase-a'), pay(second, 'purchase-b')]);
    const rows = await db.orm.select().from(subscriptions);
    expect(rows).toHaveLength(1);
    expect(fromPgTimestamp(rows[0]!.currentPeriodEnd).getTime()).toBeGreaterThanOrEqual(before + 90 * day);
    expect((await db.orm.select().from(paymentOrders)).every(order => order.status === 'completed')).toBe(true);
  });
  it('quotes are owner-scoped, single use and expire; unused expired previews do not change rights', async () => {
    await seed(); const quote = await quoteChange(db, owner, 'scale', 1);
    const other = await seedOperator(db);
    await expect(withBillingTransaction(db, other, tx => consumeQuoteLocked(tx, other, quote.id))).rejects.toMatchObject({ statusCode: 409 });
    await withBillingTransaction(db, owner, tx => consumeQuoteLocked(tx, owner, quote.id));
    await expect(withBillingTransaction(db, owner, tx => consumeQuoteLocked(tx, owner, quote.id))).rejects.toMatchObject({ statusCode: 409 });
    const expired = await quoteChange(db, owner, 'scale', 1);
    await db.orm.update(billingQuotes).set({ expiresAt: toPgTimestamp(new Date(Date.now() - 1000)) }).where(eq(billingQuotes.id, expired.id));
    await expect(withBillingTransaction(db, owner, tx => consumeQuoteLocked(tx, owner, expired.id))).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.orm.select().from(subscriptions))[0]!.planKey).toBe('pro');
  });
  it('catalog price changes do not reprice an existing subscription; manual switch and overlapping downgrade reject', async () => {
    await seed();
    await db.orm.update(plans).set({ priceMonthly: 49 }).where(eq(plans.key, 'pro'));
    expect((await quoteChange(db, owner, 'pro', 2)).amount).toBe(58);
    await expect(subscribeOperator(db, { operatorId: owner, planKey: 'scale', months: 1 })).rejects.toMatchObject({ statusCode: 409 });
    const quote = await quoteChange(db, owner, 'free', 1);
    await withBillingTransaction(db, owner, tx => fulfillQuoteLocked(tx, owner, quote, null));
    await expect(quoteChange(db, owner, 'scale', 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
