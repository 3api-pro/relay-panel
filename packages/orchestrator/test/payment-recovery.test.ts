import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentOrders, subscriptions } from '../src/db/schema.js';
import { fromPgTimestamp, toPgTimestamp } from '../src/auth/sessions.js';
import { PaymentsService } from '../src/billing/payments/service.js';
import { subscribeOperator } from '../src/billing/service.js';
import { makeTestConfig, makeTestDb, seedOperator } from './helpers.js';
import type { Db } from '../src/db/client.js';

vi.setConfig({ testTimeout: 30_000 });
describe('payment fulfillment recovery (embedded PostgreSQL)', () => {
  let db: Db;
  let owner: number;
  let service: PaymentsService;
  beforeEach(async () => {
    db = await makeTestDb(); owner = await seedOperator(db, { role: 'operator' });
    service = new PaymentsService({ db, config: makeTestConfig() });
  });
  afterEach(async () => { await db.close(); });
  async function paid(orderNo: string, months = 1, version = 1): Promise<void> {
    await db.orm.insert(paymentOrders).values({ orderNo, operatorId: owner, planKey: 'pro', months,
      amount: months * 29, providerKey: 'alipay', status: 'paid', fulfillmentVersion: version });
  }
  it('completion-write failure rolls back subscription and audit, then restart retries exactly once', async () => {
    await paid('crash-order');
    await db.exec(`CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'completed' THEN RAISE EXCEPTION 'injected disk failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER payment_crash BEFORE UPDATE ON payment_orders FOR EACH ROW EXECUTE FUNCTION fail_completion();`);
    await expect(service.confirmOrder('crash-order')).rejects.toMatchObject({ statusCode: 503 });
    expect(await db.orm.select().from(subscriptions)).toHaveLength(0);
    expect((await db.orm.select().from(paymentOrders))[0]).toMatchObject({ status: 'paid', reconciliationError: 'fulfillment_retry_required' });
    await db.exec('DROP TRIGGER payment_crash ON payment_orders');
    const restarted = new PaymentsService({ db, config: makeTestConfig() });
    await Promise.all([restarted.confirmOrder('crash-order'), service.confirmOrder('crash-order')]);
    expect(await db.orm.select().from(subscriptions)).toHaveLength(1);
    const expiry = (await db.orm.select().from(subscriptions))[0]!.currentPeriodEnd;
    await restarted.confirmOrder('crash-order');
    expect((await db.orm.select().from(subscriptions))[0]!.currentPeriodEnd).toBe(expiry);
    expect((await db.orm.select().from(paymentOrders))[0]!.status).toBe('completed');
  });
  it('two paid orders and a simultaneous manual renewal preserve all purchased time', async () => {
    const base = Date.now() + 10 * 86_400_000;
    await db.orm.insert(subscriptions).values({ operatorId: owner, planKey: 'pro', currentPeriodEnd: toPgTimestamp(new Date(base)) });
    await paid('renew-a', 1); await paid('renew-b', 2);
    await Promise.all([service.confirmOrder('renew-a'), service.confirmOrder('renew-b'),
      subscribeOperator(db, { operatorId: owner, planKey: 'pro', months: 1 })]);
    const rows = await db.orm.select().from(subscriptions).where(eq(subscriptions.operatorId, owner));
    expect(rows).toHaveLength(1);
    expect(fromPgTimestamp(rows[0]!.currentPeriodEnd).getTime()).toBe(base + 120 * 86_400_000);
  });
  it('ambiguous legacy paid orders remain visible for review without granting again', async () => {
    await paid('legacy', 1, 0);
    await service.confirmOrder('legacy');
    expect(await db.orm.select().from(subscriptions)).toHaveLength(0);
    expect((await db.orm.select().from(paymentOrders))[0]).toMatchObject({ status: 'paid', reconciliationError: 'legacy_paid_requires_review' });
  });
  it('recovery is owner-scoped and the bounded worker processes confirmed payments without browser polling', async () => {
    await paid('recover-owner');
    await expect(service.retryOrder({ operatorId: owner + 1, email: 'other@example.com', role: 'operator' }, 'recover-owner'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await service.reconcile(1)).toEqual({ checked: 1, failed: 0 });
    expect((await db.orm.select().from(paymentOrders))[0]!.status).toBe('completed');
  });
});
