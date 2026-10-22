import { and, eq, lt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { authAttempts, authTokens, operators, paymentOrders, sites } from '../db/schema.js';
import { toPgTimestamp } from '../auth/sessions.js';
import type { NotifyEvent } from '../alerts/notify.js';
import { deliverNotifications, queueNotification } from './service.js';

export class TenantNotifier {
  constructor(private db: Db, private config: Config) {}
  async fire(event: NotifyEvent): Promise<void> {
    const alert = event.alert as { id?: number; siteId?: number; title?: string; detail?: string; firstSeenAt?: string; resolvedAt?: string };
    if (!alert.siteId || !alert.id) return;
    const [site] = await this.db.orm.select().from(sites).where(eq(sites.id, alert.siteId));
    if (!site) return;
    await queueNotification(this.db, this.config, { operatorId: site.operatorId, category: 'alerts',
      key: `alert:${alert.id}:${event.type}:${event.type === 'resolve' ? alert.resolvedAt : alert.firstSeenAt}`,
      subject: `${event.type === 'resolve' ? '已恢复' : '站点告警'}：${site.label}`,
      body: `${alert.title ?? '站点状态变化'}\n${alert.detail ?? ''}` });
  }
}

export function startNotificationWorker(db: Db, config: Config): { stop(): Promise<void>; tick(): Promise<void> } {
  let current: Promise<void> | null = null;
  async function run(): Promise<void> {
    const now = toPgTimestamp(new Date());
    await db.orm.delete(authTokens).where(lt(authTokens.expiresAt, now));
    await db.orm.delete(authAttempts).where(lt(authAttempts.expiresAt, now));
    const unpaidEntitlements = await db.orm.select().from(paymentOrders).where(and(eq(paymentOrders.status, 'paid'),
      lt(paymentOrders.paidAt, toPgTimestamp(new Date(Date.now() - 300_000))))).limit(100);
    const roots = await db.orm.select({ id: operators.id }).from(operators).where(and(eq(operators.role, 'root'), eq(operators.status, 'active')));
    for (const order of unpaidEntitlements) {
      for (const id of new Set([order.operatorId, ...roots.map(r => r.id)])) {
        await queueNotification(db, config, { operatorId: id, category: 'billing', key: `fulfillment:${order.id}:${id}`,
          subject: '付款已确认，订阅开通需要处理', body: `订单 ${order.orderNo} 已付款，权益尚未完成。请在订阅与收款中重新核对或联系支持；请勿重复付款。` });
      }
    }
    await deliverNotifications(db, config);
  }
  async function tick(): Promise<void> {
    if (current) return current;
    current = run().catch(() => { console.warn('[notifications] delivery worker will retry'); }).finally(() => { current = null; });
    return current;
  }
  const timer = setInterval(() => void tick(), 15_000); timer.unref();
  return { tick, async stop() { clearInterval(timer); await current; } };
}
