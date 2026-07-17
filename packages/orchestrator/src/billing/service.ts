import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { plans, sites, subscriptions, type PlanRow, type SubscriptionRow } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';

/**
 * 计费/配额服务（规格 §9）。
 * 配额语义：root/viewer 不受限（Infinity）；operator 取当前有效订阅套餐的
 * site_quota，无有效订阅回落 free 档。G1 provision 前调用 quotaFor + activeSites。
 */

export const FREE_PLAN_KEY = 'free';

/** quotaFor 只需要 ctx 的这两个字段（SessionCtx 结构化子集） */
export interface QuotaCtx {
  operatorId: number;
  role: string;
}

export async function planByKey(db: Db, key: string): Promise<PlanRow | null> {
  const rows = await db.orm.select().from(plans).where(eq(plans.key, key)).limit(1);
  return rows[0] ?? null;
}

/** 当前有效订阅：status=active 且未过期；多条时取最晚到期的一条 */
export async function activeSubscription(db: Db, operatorId: number): Promise<SubscriptionRow | null> {
  const nowPg = toPgTimestamp(new Date());
  const rows = await db.orm
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.operatorId, operatorId),
        eq(subscriptions.status, 'active'),
        gt(subscriptions.currentPeriodEnd, nowPg),
      ),
    )
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 站点配额：root/viewer=Infinity；operator=有效订阅套餐的 site_quota，
 * 否则 free 档（种子必有；万一被删按 0 从严）。
 */
export async function quotaFor(db: Db, ctx: QuotaCtx): Promise<number> {
  if (ctx.role === 'root' || ctx.role === 'viewer') return Infinity;
  const sub = await activeSubscription(db, ctx.operatorId);
  if (sub) {
    const plan = await planByKey(db, sub.planKey);
    if (plan) return plan.siteQuota;
  }
  const free = await planByKey(db, FREE_PLAN_KEY);
  return free ? free.siteQuota : 0;
}

/** 计入配额的站点数（destroyed 不占额） */
export async function activeSites(db: Db, operatorId: number): Promise<number> {
  const rows = await db.orm
    .select({ n: sql<number>`count(*)::int` })
    .from(sites)
    .where(and(eq(sites.operatorId, operatorId), ne(sites.status, 'destroyed')));
  return rows[0]?.n ?? 0;
}

export interface SubscribeInput {
  operatorId: number;
  planKey: string;
  /** 月数语义 = +30*months 天 */
  months: number;
}

/**
 * 开通/顺延订阅：已有有效订阅 → 在现到期日上顺延并切换套餐；
 * 否则新建一条（历史上过期未标记的 active 行先收敛为 expired，保持台账干净）。
 */
export async function subscribeOperator(db: Db, input: SubscribeInput): Promise<SubscriptionRow> {
  const now = new Date();
  const nowPg = toPgTimestamp(now);
  const extendMs = input.months * 30 * 86_400_000;

  const existing = await activeSubscription(db, input.operatorId);
  if (existing) {
    const base = fromPgTimestamp(existing.currentPeriodEnd);
    const rows = await db.orm
      .update(subscriptions)
      .set({
        planKey: input.planKey,
        currentPeriodEnd: toPgTimestamp(new Date(base.getTime() + extendMs)),
        updatedAt: nowPg,
      })
      .where(eq(subscriptions.id, existing.id))
      .returning();
    return rows[0]!;
  }

  await db.orm
    .update(subscriptions)
    .set({ status: 'expired', updatedAt: nowPg })
    .where(and(eq(subscriptions.operatorId, input.operatorId), eq(subscriptions.status, 'active')));

  const rows = await db.orm
    .insert(subscriptions)
    .values({
      operatorId: input.operatorId,
      planKey: input.planKey,
      currentPeriodEnd: toPgTimestamp(new Date(now.getTime() + extendMs)),
    })
    .returning();
  return rows[0]!;
}

/** 取消订阅（幂等：已取消的再取消不报错） */
export async function cancelSubscription(db: Db, id: number): Promise<SubscriptionRow> {
  const rows = await db.orm
    .update(subscriptions)
    .set({ status: 'cancelled', updatedAt: toPgTimestamp(new Date()) })
    .where(eq(subscriptions.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new ApiError(404, '订阅不存在');
  return row;
}

export interface CheckoutOperator {
  id: number;
  email: string;
}

/**
 * 支付渠道扩展位：createCheckout 缺省=不支持自助支付，只能 root 手工开通。
 * Stripe/易支付等第三方渠道按此接口另行实现并在装配处替换。
 */
export interface PaymentProvider {
  readonly name: string;
  createCheckout?(operator: CheckoutOperator, plan: PlanRow): Promise<{ url: string }>;
}

/** 默认渠道：无自助支付，root 在后台手工开通/顺延 */
export class ManualProvider implements PaymentProvider {
  readonly name = 'manual';
}
