import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { FinanceSiteUsage } from '../sites/service.js';

/**
 * 经营汇总口径的单一实现（F2 第一刀：零行为变化的口径抽取）。
 *
 * 把原先内联在 finance/routes.ts GET /api/finance/summary handler 里的三段逻辑
 * （成本率读取、逐站成本/毛利判定、合计）提炼为纯函数，供 routes 与
 * finance/report scheduler 共用同一口径，绝不各自重复实现导致口径漂移。
 *
 * 口径（与 routes.ts 注释一致，全部真实数据、非估算）：
 *  - 营收 revenue = 各站引擎记账的用户消费流水（对客价，actual_cost）。
 *  - 成本 cost：成本率覆盖优先（cost=revenue×ratio，costSource='ratio'）；
 *    否则用引擎真实上游账户成本（accountCost，costSource='engine'）；均无则 null。
 *  - 毛利 profit = revenue − cost；cost 为 null 时 profit 也为 null。
 *  🔴 USD:RMB 1:1（本行业无汇率），金额单位 USD（adapter costUnit）。
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
  recharge: number | null;
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
 * 与 routes.ts 原 usage.map 逻辑逐字节等价。
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
}

/**
 * 合计：营收/请求/token 累加全部站点；成本/毛利只累加「有成本口径」的站点
 * （cost!==null）。与 routes.ts 原 totals 逻辑逐字节等价。
 * recharge 是现金到账口径（RMB，1:1 于 USD），由调用方传入（报告不混入，传 null）。
 */
export function summaryTotals(
  rows: FinanceSummaryRow[],
  rechargePeriod: number | null,
): FinanceSummaryTotals {
  const costed = rows.filter((r) => r.cost !== null);
  return {
    requests: rows.reduce((a, r) => a + r.requests, 0),
    tokens: rows.reduce((a, r) => a + r.tokens, 0),
    revenue: rows.reduce((a, r) => a + r.revenue, 0),
    cost: costed.reduce((a, r) => a + (r.cost as number), 0),
    profit: costed.reduce((a, r) => a + (r.profit as number), 0),
    costedRevenue: costed.reduce((a, r) => a + r.revenue, 0),
    recharge: rechargePeriod,
  };
}
