import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asc, desc, eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { operators, plans, subscriptions, type SubscriptionRow } from '../db/schema.js';
import { writeAudit } from '../audit.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import {
  FREE_PLAN_KEY,
  activeSites,
  activeSubscription,
  cancelSubscription,
  planByKey,
  quotaFor,
  subscribeOperator,
} from './service.js';

/**
 * 计费路由（规格 §9）：套餐/我的订阅/root 手工开通与取消。
 * 认证由 server.ts 全局钩子保证（/api/* 无 session 直接 401），这里只做角色判定。
 */

export interface BillingRoutesDeps {
  config: Config;
  db: Db;
}

const subscribeBody = z.object({
  operatorEmail: z.string().email(),
  planKey: z.string().min(1),
  // 月数语义 = +30*months 天
  months: z.number().int().min(1).max(120),
});

/** zod 校验失败统一 400；文案不回显请求原值 */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ApiError(400, `请求参数无效: ${issues}`);
  }
  return r.data;
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

/** 订阅行对外形状（含操作员邮箱，root 列表/开通响应共用） */
function toApiSubscription(row: SubscriptionRow, operatorEmail?: string): Record<string, unknown> {
  return {
    id: row.id,
    operatorId: row.operatorId,
    ...(operatorEmail !== undefined ? { operatorEmail } : {}),
    planKey: row.planKey,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRoutesDeps): void {
  const { db } = deps;

  // ---- 套餐列表（全员，F4 已有行为保持不变） ----
  app.get('/api/billing/plans', async () => {
    const rows = await db.orm.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.id));
    return {
      plans: rows.map((p) => ({
        key: p.key,
        title: p.title,
        priceMonthly: p.priceMonthly,
        siteQuota: p.siteQuota,
        features: p.features,
      })),
    };
  });

  // ---- 我的订阅（quota null = 不限额，root/viewer） ----
  app.get('/api/billing/subscription', async (req) => {
    const ctx = requireCtx(req);
    const quota = await quotaFor(db, ctx);
    const usedSites = await activeSites(db, ctx.operatorId);
    if (!Number.isFinite(quota)) {
      return { plan: null, periodEnd: null, quota: null, usedSites };
    }
    const sub = await activeSubscription(db, ctx.operatorId);
    const plan = await planByKey(db, sub ? sub.planKey : FREE_PLAN_KEY);
    return {
      plan: plan
        ? { key: plan.key, title: plan.title, priceMonthly: plan.priceMonthly, siteQuota: plan.siteQuota }
        : null,
      periodEnd: sub ? sub.currentPeriodEnd : null,
      quota,
      usedSites,
    };
  });

  // ---- root: 全部订阅 ----
  app.get('/api/billing/subscriptions', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const rows = await db.orm
      .select({ sub: subscriptions, operatorEmail: operators.email })
      .from(subscriptions)
      .innerJoin(operators, eq(subscriptions.operatorId, operators.id))
      .orderBy(desc(subscriptions.id));
    return { subscriptions: rows.map((r) => toApiSubscription(r.sub, r.operatorEmail)) };
  });

  // ---- root: 手工开通/顺延 ----
  app.post('/api/billing/subscriptions', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const body = parseBody(subscribeBody, req.body);

    const op = (await db.orm.select().from(operators).where(eq(operators.email, body.operatorEmail)).limit(1))[0];
    if (!op) throw new ApiError(404, '操作员不存在');
    const plan = await planByKey(db, body.planKey);
    if (!plan || !plan.active) throw new ApiError(404, '套餐不存在');

    const sub = await subscribeOperator(db, { operatorId: op.id, planKey: plan.key, months: body.months });
    // 审计 payload 避开 key* 字段名（redact 会整值抹掉），套餐用 'plan'
    await writeAudit(db, {
      actor: ctx.email,
      action: 'billing.subscribe',
      payload: {
        operatorEmail: body.operatorEmail,
        plan: plan.key,
        months: body.months,
        periodEnd: sub.currentPeriodEnd,
      },
      ok: true,
    });
    return { subscription: toApiSubscription(sub, op.email) };
  });

  // ---- root: 取消订阅 ----
  app.delete<{ Params: { id: string } }>('/api/billing/subscriptions/:id', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, '无效的订阅 id');

    const row = await cancelSubscription(db, id);
    await writeAudit(db, {
      actor: ctx.email,
      action: 'billing.cancel',
      payload: { id: row.id, operatorId: row.operatorId, plan: row.planKey },
      ok: true,
    });
    return { ok: true, subscription: toApiSubscription(row) };
  });
}
