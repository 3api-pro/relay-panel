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

const DAY_MS = 86_400_000;

/** quotaFor 只需要 ctx 的这两个字段（SessionCtx 结构化子集） */
export interface QuotaCtx {
  operatorId: number;
  role: string;
}

export async function planByKey(db: Db, key: string): Promise<PlanRow | null> {
  const rows = await db.orm.select().from(plans).where(eq(plans.key, key)).limit(1);
  return rows[0] ?? null;
}

/**
 * 计配额的有效订阅：status=active 且 currentPeriodEnd 仍在 (now - graceDays) 之后
 * ——即「未过期」或「已过期但仍在宽限期内」；多条时取最晚到期的一条。
 * graceDays=0（缺省）退化为严格未过期语义（历史行为），配额调用方按需传入宽限天数。
 */
export async function activeSubscription(
  db: Db,
  operatorId: number,
  graceDays = 0,
): Promise<SubscriptionRow | null> {
  const cutoffPg = toPgTimestamp(new Date(Date.now() - Math.max(0, graceDays) * DAY_MS));
  const rows = await db.orm
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.operatorId, operatorId),
        eq(subscriptions.status, 'active'),
        gt(subscriptions.currentPeriodEnd, cutoffPg),
      ),
    )
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  return rows[0] ?? null;
}

/** 订阅所处阶段：有效 / 宽限期 / 已过期（曾付费失效）/ 无（免费档，从未付费或已取消） */
export type SubscriptionPhase = 'active' | 'grace' | 'expired' | 'none';

export interface SubscriptionState {
  /** 计配额的有效订阅行（active 或 grace 阶段有值，其余为 null） */
  sub: SubscriptionRow | null;
  phase: SubscriptionPhase;
  /** 当前周期到期时间（pg 字符串）；无订阅时 null */
  currentPeriodEnd: string | null;
  /** 宽限期结束时间；仅 active(宽限>0)/grace 阶段有值 */
  graceEndsAt: string | null;
  /** active=距到期天数；grace=距宽限结束天数；expired=0；none=null（向上取整） */
  daysRemaining: number | null;
}

/**
 * 订阅阶段判定（供 API 与前端展示、扫描循环共用）。
 * 优先取最近一条 status=active 的订阅：未到期=active、宽限内=grace、过宽限=expired（尚未被扫描收敛）；
 * 无 active 订阅时若存在 status=expired 历史行=expired（曾付费失效），否则 none（免费档）。
 * cancelled 一律视作 none（用户主动取消，非欠费过期）。
 */
export async function subscriptionState(
  db: Db,
  operatorId: number,
  graceDays = 0,
): Promise<SubscriptionState> {
  const now = Date.now();
  const graceMs = Math.max(0, graceDays) * DAY_MS;

  const activeRows = await db.orm
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.operatorId, operatorId), eq(subscriptions.status, 'active')))
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  const active = activeRows[0];
  if (active) {
    const endMs = fromPgTimestamp(active.currentPeriodEnd).getTime();
    const graceEndMs = endMs + graceMs;
    if (now < endMs) {
      return {
        sub: active,
        phase: 'active',
        currentPeriodEnd: active.currentPeriodEnd,
        graceEndsAt: graceMs > 0 ? toPgTimestamp(new Date(graceEndMs)) : null,
        daysRemaining: Math.ceil((endMs - now) / DAY_MS),
      };
    }
    if (now < graceEndMs) {
      return {
        sub: active,
        phase: 'grace',
        currentPeriodEnd: active.currentPeriodEnd,
        graceEndsAt: toPgTimestamp(new Date(graceEndMs)),
        daysRemaining: Math.ceil((graceEndMs - now) / DAY_MS),
      };
    }
    // active 但已过宽限（扫描循环尚未收敛）：语义等同过期，配额回落
    return {
      sub: null,
      phase: 'expired',
      currentPeriodEnd: active.currentPeriodEnd,
      graceEndsAt: null,
      daysRemaining: 0,
    };
  }

  const expiredRows = await db.orm
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.operatorId, operatorId), eq(subscriptions.status, 'expired')))
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  const expired = expiredRows[0];
  if (expired) {
    return {
      sub: null,
      phase: 'expired',
      currentPeriodEnd: expired.currentPeriodEnd,
      graceEndsAt: null,
      daysRemaining: 0,
    };
  }
  return { sub: null, phase: 'none', currentPeriodEnd: null, graceEndsAt: null, daysRemaining: null };
}

/**
 * 站点配额：root/viewer=Infinity；operator=有效订阅套餐的 site_quota（宽限期内仍按原计划），
 * 否则 free 档（种子必有；万一被删按 0 从严）。graceDays 由调用方（provision 闸/计费 API）传入。
 */
export async function quotaFor(db: Db, ctx: QuotaCtx, graceDays = 0): Promise<number> {
  if (ctx.role === 'root' || ctx.role === 'viewer') return Infinity;
  const sub = await activeSubscription(db, ctx.operatorId, graceDays);
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
 * 开通/顺延订阅：已有 status=active 订阅 → 从 max(now, currentPeriodEnd) 顺延并切换套餐
 * （到期前续费=在原到期日上叠加；过期后续费=从现在起算），并清空 reminders_sent（新周期重新计各档提醒）；
 * 否则新建一条。存在多条 active（异常态）时取最晚到期的一条顺延，其余收敛为 expired 保持每人至多一条 active。
 */
export async function subscribeOperator(db: Db, input: SubscribeInput): Promise<SubscriptionRow> {
  const now = new Date();
  const nowPg = toPgTimestamp(now);
  const extendMs = input.months * 30 * DAY_MS;

  const activeRows = await db.orm
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.operatorId, input.operatorId), eq(subscriptions.status, 'active')))
    .orderBy(desc(subscriptions.currentPeriodEnd));
  const chosen = activeRows[0];

  if (chosen) {
    // 续费基准：max(now, 现到期)——过期未收敛(active 但已过期)的行从现在起算，未到期的顺延
    const base = Math.max(now.getTime(), fromPgTimestamp(chosen.currentPeriodEnd).getTime());
    const rows = await db.orm
      .update(subscriptions)
      .set({
        planKey: input.planKey,
        currentPeriodEnd: toPgTimestamp(new Date(base + extendMs)),
        remindersSent: {},
        updatedAt: nowPg,
      })
      .where(eq(subscriptions.id, chosen.id))
      .returning();
    // 其余多余 active 收敛（正常不该出现，防御性保持台账干净）
    if (activeRows.length > 1) {
      await db.orm
        .update(subscriptions)
        .set({ status: 'expired', updatedAt: nowPg })
        .where(
          and(
            eq(subscriptions.operatorId, input.operatorId),
            eq(subscriptions.status, 'active'),
            ne(subscriptions.id, chosen.id),
          ),
        );
    }
    return rows[0]!;
  }

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
