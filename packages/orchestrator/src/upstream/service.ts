import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { SiteChannelBalanceRow } from '../sites/service.js';

/**
 * 上游渠道"余额/可用度"域逻辑（F5，口径风险最高，纯只读）。
 *
 * 🔴 铁律：引擎【从不】提供上游钱包真实余额。本模块只把能拿到的最接近口径诚实分类呈现：
 *  - quota（apikey/bedrock 管理员手配上限）→ 有真实可用额度 remaining=limit-used，可算「还能撑几天」；
 *  - window（Anthropic OAuth/号池）→ 仅 5h 窗口成本闸 windowCostLimit(非余额)，daysLeft 恒 null，绝不编造；
 *  - none（零覆盖）→ 无任何额度信号，只呈现账号口径日均消耗估算。
 *
 * 纯函数模块（不碰 client/DB 之外的引擎），供 routes（呈现）、alerts 引擎（低余额告警）、单测共用。
 * 🔴 绝不 import alerts（保持 alerts→upstream 单向依赖，天然无环）。
 * 金额单位 USD（本行业 USD:RMB 1:1，无汇率）。
 */

/** 充值外链在 app_settings 里的存放 key（用户可编辑设置类；F5 只读呈现+外链+手工记账，无引擎写） */
export const RECHARGE_LINKS_KEY = 'channel_recharge_links';

/** 低余额判定/剩余额度计算所需的最小结构（ChannelBalance 与 SiteChannelBalanceRow 均满足） */
export interface BalanceLike {
  kind: 'quota' | 'window' | 'none';
  quotaLimit?: number;
  quotaUsed?: number;
}

/**
 * 剩余可用额度：仅 kind='quota' 有意义（limit-used，USD）；window/none 恒 null（无真实余额口径）。
 * 🔴 window(号池窗口闸)/none(零覆盖) 绝不返回数字，避免被误当余额。
 */
export function classifyRemaining(row: BalanceLike): number | null {
  if (row.kind !== 'quota') return null;
  return (row.quotaLimit ?? 0) - (row.quotaUsed ?? 0);
}

/**
 * 「还能撑几天」：仅在 remaining 非 null（即 quota 型）且 avgDailyCost>0 时才算，否则 null。
 * 🔴 号池/OAuth（remaining=null）绝不编造撑几天，windowCostLimit/avgDailyCost 都不得用于伪造。
 */
export function computeDaysLeft(remaining: number | null, avgDailyCost: number | undefined): number | null {
  if (remaining === null) return null;
  if (avgDailyCost === undefined || !(avgDailyCost > 0)) return null;
  return remaining / avgDailyCost;
}

/**
 * 低余额命中（纯函数，告警引擎 + /balances 高亮共用）：仅对 kind='quota' 且 remaining<threshold 命中；
 * 🔴 window/none 永不命中（零覆盖不误报）。threshold<=0 一律不命中（阈值语义：>0 才启用）。
 * 泛型保留输入行完整信息（调用方需读 name 等）。
 */
export function evaluateChannelLowBalance<T extends BalanceLike>(rows: T[], thresholdUsd: number): T[] {
  if (!(thresholdUsd > 0)) return [];
  return rows.filter((r) => {
    if (r.kind !== 'quota') return false;
    const remaining = classifyRemaining(r);
    return remaining !== null && remaining < thresholdUsd;
  });
}

/** 覆盖度汇总：多少渠道有真实额度 / 仅估算(窗口) / 零覆盖 / 降级站数 */
export interface UpstreamCoverage {
  withQuota: number;
  windowOnly: number;
  zeroCoverage: number;
  degradedSites: number;
}

/** 单渠道对客视图（与 web/api/types.ts 的 ChannelBalanceView 同构） */
export interface ChannelBalanceView {
  id: string;
  name: string;
  accountType: string;
  enabled: boolean;
  kind: 'quota' | 'window' | 'none';
  /** 覆盖度：exact=有真实额度；estimate=仅窗口估算；none=零覆盖/站点降级 */
  coverage: 'exact' | 'estimate' | 'none';
  quotaLimit?: number;
  quotaUsed?: number;
  /** 剩余可用额度(USD)，仅 quota 型有 */
  remaining?: number;
  windowCostLimit?: number;
  /** 账号口径日均消耗(USD)，供 window/none 呈现估算参考 */
  avgDailyCost?: number;
  /** 还能撑几天：仅 quota 且 avgDailyCost>0 才有；window/none 恒 null（不编造） */
  daysLeft: number | null;
  /** 低余额红标：仅 quota 型可 true */
  low: boolean;
  siteSlug: string;
  siteLabel: string;
  siteOk: boolean;
}

export interface BalanceOverview {
  coverage: UpstreamCoverage;
  rows: ChannelBalanceView[];
}

/**
 * 装配每渠道对客视图 + 覆盖度汇总 + 低余额标记。
 * 🔴 window/零覆盖行强制 coverage='estimate'|'none'，只显 avgDailyCost/windowCostLimit，绝不给余额数(remaining/daysLeft)。
 * 站点降级 marker 行（siteOk=false）计入 coverage.degradedSites，不计入 withQuota/windowOnly/zeroCoverage。
 */
export function buildBalanceOverview(rows: SiteChannelBalanceRow[], thresholdUsd: number): BalanceOverview {
  const coverage: UpstreamCoverage = { withQuota: 0, windowOnly: 0, zeroCoverage: 0, degradedSites: 0 };
  const degradedSlugs = new Set<string>();
  const views: ChannelBalanceView[] = [];

  for (const r of rows) {
    if (!r.siteOk) {
      // 站点连不上 marker：不产出真渠道行，只登记降级站
      degradedSlugs.add(r.siteSlug);
      views.push({
        id: r.id,
        name: r.name,
        accountType: r.accountType,
        enabled: r.enabled,
        kind: 'none',
        coverage: 'none',
        daysLeft: null,
        low: false,
        siteSlug: r.siteSlug,
        siteLabel: r.siteLabel,
        siteOk: false,
      });
      continue;
    }

    if (r.kind === 'quota') {
      coverage.withQuota += 1;
      const remaining = classifyRemaining(r);
      const daysLeft = computeDaysLeft(remaining, r.avgDailyCost);
      const low = remaining !== null && thresholdUsd > 0 && remaining < thresholdUsd;
      views.push({
        id: r.id,
        name: r.name,
        accountType: r.accountType,
        enabled: r.enabled,
        kind: 'quota',
        coverage: 'exact',
        ...(r.quotaLimit !== undefined ? { quotaLimit: r.quotaLimit } : {}),
        ...(r.quotaUsed !== undefined ? { quotaUsed: r.quotaUsed } : {}),
        ...(remaining !== null ? { remaining } : {}),
        ...(r.avgDailyCost !== undefined ? { avgDailyCost: r.avgDailyCost } : {}),
        daysLeft,
        low,
        siteSlug: r.siteSlug,
        siteLabel: r.siteLabel,
        siteOk: true,
      });
    } else if (r.kind === 'window') {
      coverage.windowOnly += 1;
      // 🔴 强制 estimate，只呈现窗口闸 + 日均，绝不给余额数/撑几天
      views.push({
        id: r.id,
        name: r.name,
        accountType: r.accountType,
        enabled: r.enabled,
        kind: 'window',
        coverage: 'estimate',
        ...(r.windowCostLimit !== undefined ? { windowCostLimit: r.windowCostLimit } : {}),
        ...(r.avgDailyCost !== undefined ? { avgDailyCost: r.avgDailyCost } : {}),
        daysLeft: null,
        low: false,
        siteSlug: r.siteSlug,
        siteLabel: r.siteLabel,
        siteOk: true,
      });
    } else {
      coverage.zeroCoverage += 1;
      views.push({
        id: r.id,
        name: r.name,
        accountType: r.accountType,
        enabled: r.enabled,
        kind: 'none',
        coverage: 'none',
        ...(r.avgDailyCost !== undefined ? { avgDailyCost: r.avgDailyCost } : {}),
        daysLeft: null,
        low: false,
        siteSlug: r.siteSlug,
        siteLabel: r.siteLabel,
        siteOk: true,
      });
    }
  }

  coverage.degradedSites = degradedSlugs.size;
  return { coverage, rows: views };
}

// ---------------------------------------------------------------------------
// 充值外链（只读呈现 + 外链 + 手工记账；绝不实现 reset-quota/砍余额等不可逆动作）
// ---------------------------------------------------------------------------

export interface RechargeLink {
  label: string;
  url: string;
  note?: string;
}

/** URL 必须为 http/https（其它协议一律拒绝：防 javascript:/file: 等） */
export function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 容错解析 app_settings['channel_recharge_links']：
 * 兼容存为 { links: [...] }（当前写入形态，app_settings.value 是对象口径）或裸数组；
 * 逐项校验 label 非空 + url 必 http/https，非法项丢弃。
 */
export function parseRechargeLinks(raw: unknown): RechargeLink[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { links?: unknown }).links)
      ? ((raw as { links: unknown[] }).links)
      : [];
  const out: RechargeLink[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label : '';
    const url = typeof o.url === 'string' ? o.url : '';
    if (!label || !isHttpUrl(url)) continue;
    out.push({ label, url, ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}) });
  }
  return out;
}

/** 读充值外链（容错回落空数组） */
export async function readRechargeLinks(deps: { db: Db }): Promise<RechargeLink[]> {
  const rows = await deps.db.orm
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, RECHARGE_LINKS_KEY))
    .limit(1);
  return parseRechargeLinks(rows[0]?.value);
}
