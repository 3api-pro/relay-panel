import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { appSettings } from '../db/schema.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { SitesService, type SitesServiceDeps, type FinanceSiteUsage } from '../sites/service.js';

/**
 * 经营概览路由：跨站营收/成本/毛利汇总。
 *
 * 口径（诚实标注，全部真实数据、非估算）：
 *  - 营收 revenue = 各站引擎记账的用户消费流水（对客价），真实（经 sub2api usage/stats）。
 *  - 成本 cost 默认 = 引擎记账的「上游账户实际成本」total_account_cost（真实 COGS，costSource='engine'）。
 *  - 毛利 profit = revenue − cost；毛利率 = profit / revenue。
 *
 * 成本率覆盖（可选）：root 可在 app_settings['finance_cost_ratios'] 为某站配置成本率，
 *   一旦配置则 cost = revenue × 成本率（costSource='ratio'），用于引擎未给账户成本、
 *   或运营方想以固定比例口径核算的场景。未配置即用引擎真实账户成本。
 *   引擎也未给账户成本且无成本率时 cost/profit 返回 null（前端显示「—」）。
 */

const COST_RATIOS_KEY = 'finance_cost_ratios';

/** 区间最大跨度（天），护栏：避免一次拉过多按天走势 */
const MAX_RANGE_DAYS = 92;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 北京(Asia/Shanghai)当前日历日 YYYY-MM-DD */
function beijingTodayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 校验（含真实日历日校验），非法抛 400 */
function parseDateStr(s: string, label: string): string {
  if (!DATE_RE.test(s)) throw new ApiError(400, `${label} 格式应为 YYYY-MM-DD`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ApiError(400, `${label} 不是合法日期`);
  }
  return s;
}

/** 日期串加 delta 天 */
function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** 枚举 [from, to] 闭区间内的日期串（升序） */
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i <= MAX_RANGE_DAYS && cur <= to; i++) {
    out.push(cur);
    cur = addDaysStr(cur, 1);
  }
  return out;
}

/** PUT body：设置/清除单站成本率（ratio ∈ [0,1]，null=清除） */
const costRatioBody = z.object({
  slug: z.string().min(1),
  ratio: z.number().min(0).max(1).nullable(),
});

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

/** app_settings['finance_cost_ratios'] → { [slug]: number }（容错：非法结构回落空表） */
async function readCostRatios(deps: SitesServiceDeps): Promise<Record<string, number>> {
  const row = await deps.db.orm
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, COST_RATIOS_KEY))
    .limit(1);
  const raw = row[0]?.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out[k] = n;
  }
  return out;
}

export type CostSource = 'engine' | 'ratio' | null;

export interface FinanceSummaryRow {
  slug: string;
  label: string;
  ok: boolean;
  requests: number;
  tokens: number;
  revenue: number;
  /** 成本率覆盖值（0..1）；未配置为 null */
  costRatio: number | null;
  /** 成本来源：engine=引擎真实账户成本；ratio=成本率覆盖；null=均无 */
  costSource: CostSource;
  /** 成本（真实账户成本或成本率覆盖算得）；均无为 null */
  cost: number | null;
  /** revenue − cost；cost 为 null 时 null */
  profit: number | null;
  error?: string;
}

export interface FinanceBreakdownRow {
  key: string;
  label: string;
  /** 次级标签（客户/渠道维度显示站点名） */
  sublabel?: string;
  revenue: number;
  cost: number;
  profit: number;
  /** 毛利率；营收为 0 时 null */
  margin: number | null;
  /** 亏本：营收 > 0 且成本 > 营收 */
  loss: boolean;
  requests: number;
  tokens: number;
}

function breakdownRow(
  key: string,
  label: string,
  sublabel: string | undefined,
  revenue: number,
  cost: number,
  requests: number,
  tokens: number,
): FinanceBreakdownRow {
  const profit = revenue - cost;
  return {
    key,
    label,
    ...(sublabel !== undefined ? { sublabel } : {}),
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? profit / revenue : null,
    loss: revenue > 0 && cost > revenue,
    requests,
    tokens,
  };
}

function breakdownTotals(rows: FinanceBreakdownRow[]): {
  revenue: number;
  cost: number;
  profit: number;
  requests: number;
  tokens: number;
} {
  return rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.revenue,
      cost: a.cost + r.cost,
      profit: a.profit + r.profit,
      requests: a.requests + r.requests,
      tokens: a.tokens + r.tokens,
    }),
    { revenue: 0, cost: 0, profit: 0, requests: 0, tokens: 0 },
  );
}

export function registerFinanceRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const service = new SitesService(deps);

  // ---- 汇总（含按天走势）----
  // 区间用 from/to（北京日历日 YYYY-MM-DD，闭区间）。缺省=近 7 天（含今日）。
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/finance/summary', async (req) => {
    const ctx = requireCtx(req);
    const today = beijingTodayStr();
    const to = req.query.to ? parseDateStr(req.query.to, 'to') : today;
    const from = req.query.from ? parseDateStr(req.query.from, 'from') : addDaysStr(to, -6);
    if (from > to) throw new ApiError(400, 'from 不能晚于 to');
    const dates = enumerateDates(from, to);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new ApiError(400, `日期区间不能超过 ${MAX_RANGE_DAYS} 天`);
    }

    const [usage, perSiteDaily, recharge] = await Promise.all([
      service.financeUsage(ctx, from, to),
      service.financeTrend(ctx, from, to),
      service.financeRecharge(ctx, from, to),
    ]);
    const ratios = await readCostRatios(deps);

    const rows: FinanceSummaryRow[] = usage.map((u) => {
      const ratio = u.slug in ratios ? (ratios[u.slug] as number) : null;
      // 成本率覆盖优先；否则用引擎真实账户成本；都没有则 null
      let cost: number | null;
      let costSource: CostSource;
      if (ratio !== null) {
        cost = u.revenue * ratio;
        costSource = 'ratio';
      } else if (u.accountCost !== null) {
        cost = u.accountCost;
        costSource = 'engine';
      } else {
        cost = null;
        costSource = null;
      }
      const profit = cost === null ? null : u.revenue - cost;
      return {
        slug: u.slug,
        label: u.label,
        ok: u.ok,
        requests: u.requests,
        tokens: u.tokens,
        revenue: u.revenue,
        costRatio: ratio,
        costSource,
        cost,
        profit,
        ...(u.error !== undefined ? { error: u.error } : {}),
      };
    });

    const costUnit = usage.find((u) => u.ok)?.costUnit ?? 'USD';
    // 成本/毛利合计只累加「有成本口径」的站点；是否所有站都有成本一并返回给前端提示
    const costed = rows.filter((r) => r.cost !== null);
    const allCosted = rows.length > 0 && costed.length === rows.length;
    const totals = {
      requests: rows.reduce((a, r) => a + r.requests, 0),
      tokens: rows.reduce((a, r) => a + r.tokens, 0),
      revenue: rows.reduce((a, r) => a + r.revenue, 0),
      cost: costed.reduce((a, r) => a + (r.cost as number), 0),
      profit: costed.reduce((a, r) => a + (r.profit as number), 0),
      // 充值(现金到账)区间合计；全站取不到时 null（不同口径，与营收并列展示）
      recharge: recharge.ok ? recharge.periodAmount : null,
    };

    // 走势：跨站按日期汇总每日精确营收 + 每日精确成本（成本率覆盖优先，否则引擎当日账户成本）。
    // 营收/成本/毛利/请求每日均为真实值（非分摊），区间合计与表格/卡片一致。
    const dateAgg = new Map<string, { revenue: number; cost: number; requests: number; tokens: number }>();
    for (const date of dates) dateAgg.set(date, { revenue: 0, cost: 0, requests: 0, tokens: 0 });
    for (const site of perSiteDaily) {
      const ratio = site.slug in ratios ? (ratios[site.slug] as number) : null;
      for (const p of site.daily) {
        const agg = dateAgg.get(p.date);
        if (!agg) continue;
        agg.revenue += p.revenue;
        agg.requests += p.requests;
        agg.tokens += p.tokens;
        const c = ratio !== null ? p.revenue * ratio : p.accountCost;
        if (c !== null) agg.cost += c;
      }
    }
    // 每日走势/明细：逐日 充值·消耗(营收)·成本·毛利·请求·token 全含（充值折进每日，不再单列今日充值）
    const trend = dates.map((date) => {
      const a = dateAgg.get(date) as { revenue: number; cost: number; requests: number; tokens: number };
      const rc = recharge.ok ? recharge.byDate[date] ?? 0 : null;
      return {
        date,
        revenue: a.revenue,
        requests: a.requests,
        tokens: a.tokens,
        cost: a.cost,
        profit: a.revenue - a.cost,
        recharge: rc,
      };
    });

    return { from, to, costUnit, rows, totals, allCosted, trend };
  });

  // ---- 经营下钻（按模型/客户/上游渠道）----
  // model/customer 用 from/to（缺省近7天）；account 用 days(1..90，终点今日) 且仅 root。
  app.get<{ Querystring: { dim?: string; from?: string; to?: string; limit?: string; days?: string } }>(
    '/api/finance/breakdown',
    async (req) => {
      const ctx = requireCtx(req);
      const dim = req.query.dim ?? 'model';
      if (dim !== 'model' && dim !== 'customer' && dim !== 'account') {
        throw new ApiError(400, 'dim 须为 model / customer / account');
      }

      // 上游渠道维度：仅 root（会暴露上游账户结构与成本），只吃 days
      if (dim === 'account') {
        requireRoot(ctx);
        const daysRaw = req.query.days;
        const days = daysRaw === undefined ? 7 : Number(daysRaw);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          throw new ApiError(400, '参数 days 须为 1-90 的整数');
        }
        const raw = await service.financeAccountBreakdown(ctx, days);
        const rows = raw
          .map((r) => breakdownRow(`${r.siteSlug}:${r.accountId}`, r.accountName, r.siteLabel, r.revenue, r.cost, r.requests, r.tokens))
          .sort((a, b) => b.profit - a.profit);
        return { dim, days, rows, totals: breakdownTotals(rows) };
      }

      // model / customer：from/to 闭区间（缺省近 7 天）
      const today = beijingTodayStr();
      const to = req.query.to ? parseDateStr(req.query.to, 'to') : today;
      const from = req.query.from ? parseDateStr(req.query.from, 'from') : addDaysStr(to, -6);
      if (from > to) throw new ApiError(400, 'from 不能晚于 to');
      if (enumerateDates(from, to).length > MAX_RANGE_DAYS) {
        throw new ApiError(400, `日期区间不能超过 ${MAX_RANGE_DAYS} 天`);
      }

      if (dim === 'model') {
        const raw = await service.financeModelBreakdown(ctx, from, to);
        const rows = raw
          .map((m) => breakdownRow(m.model, m.model, undefined, m.revenue, m.cost, m.requests, m.tokens))
          .sort((a, b) => b.profit - a.profit);
        return { dim, from, to, rows, totals: breakdownTotals(rows) };
      }

      // customer：不跨站合并；集中度分母用全站营收合计（summary 口径）
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, '参数 limit 须为 1-200 的整数');
      }
      const [rawCustomers, siteUsage] = await Promise.all([
        service.financeCustomerBreakdown(ctx, from, to, Math.max(limit, 3)),
        service.financeUsage(ctx, from, to),
      ]);
      const rows = rawCustomers
        .map((r) => breakdownRow(`${r.siteSlug}:${r.userId}`, r.email || `#${r.userId}`, r.siteLabel, r.revenue, r.cost, r.requests, r.tokens))
        .sort((a, b) => b.revenue - a.revenue);
      const grandRevenue = siteUsage.reduce((a, u) => a + u.revenue, 0);
      // 🔴 有站点探测降级(revenue 漏计) 或 分母<=0 时不给集中度，避免分子分母异源算出 >100%
      const anyDegraded = siteUsage.some((u) => !u.ok);
      const top3 = rows.slice(0, 3).reduce((a, r) => a + r.revenue, 0);
      const concentration = {
        top3Share: grandRevenue > 0 && !anyDegraded ? Math.min(1, top3 / grandRevenue) : null,
        count: rows.length,
      };
      return { dim, from, to, rows: rows.slice(0, limit), totals: breakdownTotals(rows), concentration };
    },
  );

  // ---- 成本率读写（仅 root）----
  app.get('/api/finance/cost-ratios', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return { ratios: await readCostRatios(deps) };
  });

  app.put('/api/finance/cost-ratios', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = costRatioBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
    const { slug, ratio } = parsed.data;

    const current = await readCostRatios(deps);
    if (ratio === null) delete current[slug];
    else current[slug] = ratio;

    const now = toPgTimestamp(new Date());
    await deps.db.orm
      .insert(appSettings)
      .values({ key: COST_RATIOS_KEY, value: current, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: current, updatedAt: now } });

    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'finance.cost_ratio.set',
      payload: { slug, ratio },
      ok: true,
    });

    return { ratios: current };
  });
}
