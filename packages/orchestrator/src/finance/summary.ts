import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { FinanceSiteUsage, FinanceSiteDaily, FinanceRecharge } from '../sites/service.js';
import type { CurrencyAmounts } from '@relay-panel/adapter-core';

/**
 * 页面与报告共用的汇总口径：消费记账不等于现金收入，账户成本不等于供应商账单核销。
 * 成本率覆盖优先（估算），其次为引擎账户记账；未知成本保留 null。
 * 失败站点不计入合计；毛利仅覆盖已知成本的站点；不同记账单位不可直接合计。
 */

/** app_settings 里成本率覆盖表的存放 key（routes.ts 的成本率读写端点写同一行） */
export const COST_RATIOS_KEY = 'finance_cost_ratios';

/** 成本来源：engine=引擎真实账户成本；ratio=成本率覆盖；null=均无 */
export type CostSource = 'engine' | 'ratio' | null;

export interface FinanceSummaryRow {
  slug: string;
  label: string;
  ok: boolean;
  requests: number;
  tokens: number;
  revenue: number;
  costUnit?: string;
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

export interface FinanceSummaryTotals {
  costUnit: string;
  coverage: FinanceCoverage;
  requests: number;
  tokens: number;
  revenue: number;
  /** 仅累加「有成本口径」（cost!==null）的站点 */
  cost: number;
  profit: number;
  /**
   * 「有成本口径」（cost!==null）站点的营收合计——毛利率的正确分母。
   * revenue 含「营收有、成本无」的站点，直接拿 revenue 当分母会把毛利率稀释低估
   * （报告口径 bug）。用 costedRevenue 作分母保证 costedRevenue−cost=profit 算术自洽。
   * costedRevenue < revenue 即存在未计成本的站点（需在报告里给出提示）。
   */
  costedRevenue: number;
  /** 充值(现金到账)区间合计；不同口径，调用方传入（无则 null） */
  recharge: CurrencyAmounts | null;
}

export interface FinanceCoverage {
  expectedSites: number;
  availableSites: number;
  costedSites: number;
  estimatedSites: number;
}

/** app_settings['finance_cost_ratios'] → { [slug]: number }（容错：非法结构回落空表） */
export async function readCostRatios(db: Db): Promise<Record<string, number>> {
  const row = await db.orm
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

/**
 * 逐站用量 → 汇总行（成本率覆盖 > 引擎账户成本 > null 三分支 + 毛利）。
 * 不为读取失败的站点计算估算成本。
 */
export function resolveSummaryRows(
  usage: FinanceSiteUsage[],
  ratios: Record<string, number>,
): FinanceSummaryRow[] {
  return usage.map((u) => {
    const ratio = u.slug in ratios ? (ratios[u.slug] as number) : null;
    // 成本率覆盖优先；否则用引擎真实账户成本；都没有则 null
    let cost: number | null;
    let costSource: CostSource;
    if (!u.ok) {
      cost = null;
      costSource = null;
    } else if (ratio !== null) {
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
      costUnit: u.costUnit,
      costRatio: ratio,
      costSource,
      cost,
      profit,
      ...(u.error !== undefined ? { error: u.error } : {}),
    };
  });
}

/**
 * 合计：消费/请求/token 累加成功读取的站点；成本/毛利只累加「有成本口径」的站点
 * （cost!==null），并返回覆盖范围。
 * recharge 是现金到账口径并按实际支付币种拆分，由调用方传入（报告不混入，传 null）。
 */
export function summaryTotals(
  rows: FinanceSummaryRow[],
  rechargePeriod: CurrencyAmounts | null,
): FinanceSummaryTotals {
  const available = rows.filter((r) => r.ok);
  const units = [...new Set(available.map((r) => r.costUnit ?? 'USD'))];
  if (units.length > 1) throw new Error('站点记账单位不同，无法直接合计；请按单位分别核对');
  const costed = available.filter((r) => r.cost !== null);
  return {
    costUnit: units[0] ?? 'USD',
    coverage: {
      expectedSites: rows.length,
      availableSites: available.length,
      costedSites: costed.length,
      estimatedSites: costed.filter((r) => r.costSource === 'ratio').length,
    },
    requests: available.reduce((a, r) => a + r.requests, 0),
    tokens: available.reduce((a, r) => a + r.tokens, 0),
    revenue: available.reduce((a, r) => a + r.revenue, 0),
    cost: costed.reduce((a, r) => a + (r.cost as number), 0),
    profit: costed.reduce((a, r) => a + (r.profit as number), 0),
    costedRevenue: costed.reduce((a, r) => a + r.revenue, 0),
    recharge: rechargePeriod,
  };
}

/** 每日与区间使用相同的成本口径；没有成本的营收不进入毛利。 */
export function summaryTrend(dates: string[], sites: FinanceSiteDaily[], ratios: Record<string, number>, recharge: FinanceRecharge) {
  return dates.map((date) => {
    const rows = resolveSummaryRows(sites.map((site) => ({
      slug: site.slug,
      label: site.label,
      ...(site.daily.find((point) => point.date === date) ?? {
        ok: false, costUnit: 'USD', requests: 0, tokens: 0, revenue: 0, accountCost: null,
      }),
    })), ratios);
    const totals = summaryTotals(rows, recharge.ok ? recharge.byDate[date] ?? {} : null);
    return {
      ...totals,
      date,
      revenue: totals.coverage.availableSites ? totals.revenue : null,
      requests: totals.coverage.availableSites ? totals.requests : null,
      tokens: totals.coverage.availableSites ? totals.tokens : null,
      cost: totals.coverage.costedSites ? totals.cost : null,
      profit: totals.coverage.costedSites ? totals.profit : null,
      rechargeCoverage: recharge.coverage,
    };
  });
}
