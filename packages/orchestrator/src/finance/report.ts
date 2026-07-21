import type { FinanceSummaryRow, FinanceSummaryTotals } from './summary.js';

/**
 * 日报/周报的纯函数层（无任何 IO，供单测直测）：
 *  - dueReports：北京日历日 / ISO 周键的「应发档」判定（幂等，仿 billing/sweep.ts dueReminders 的
 *    「state!==目标周期串」自愈语义——错过 sendHour 时刻也能在当期内补发一次，不重发）。
 *  - evaluateThresholds：毛利率偏低 / 成本环比暴涨判定；先剔除 ok===false 降级站（口径铁律）。
 *  - renderDailyReport / renderWeeklyReport：中文纯文本报告（每站营收/成本/毛利/毛利率/请求 + 合计，
 *    周报附环比）；金额显式标 USD；root 全站汇总，不含任何上游供应商名/加价倍率/成本×倍数。
 *
 * 🔴 USD:RMB 1:1（本行业无汇率）；金额单位 USD。
 */

// ---- 存储 key（与 finance_cost_ratios 一样是 app_settings 的独立行）----
/** 用户可编辑的报告配置（收件人/阈值/开关）；PUT 只碰这一行 */
export const FINANCE_REPORT_SETTINGS_KEY = 'finance_report';
/** 发送标记（已发的日报覆盖日 / 周报覆盖周键）；scheduler 只碰这一行，与配置拆开防盲覆盖互踩 */
export const FINANCE_REPORT_STATE_KEY = 'finance_report_state';

// ---- 默认阈值 / 发送时刻 ----
/** 毛利率低于此值（0..1）→ margin_low 告警。默认 20% */
export const DEFAULT_MARGIN_LOW_PCT = 0.2;
/** 当期成本 / 上期成本 高于此倍数 → cost_spike 告警。默认 1.5× */
export const DEFAULT_COST_SPIKE_FACTOR = 1.5;
/** 报告发送时刻（北京时间小时，0..23）：达此点后发「已完整过完的上一日/上一周」报告 */
export const REPORT_SEND_HOUR = 9;

const DAY_MS = 86_400_000;
const BJ_OFFSET_MS = 8 * 3_600_000;

export type ReportKind = 'daily' | 'weekly';

/** 报告发送标记（幂等台账）：已发的日报覆盖日 / 周报覆盖 ISO 周键 */
export interface FinanceReportState {
  daily?: string;
  weekly?: string;
}

/** dueReports 需要的运行时开关 + 发送时刻（sendHour 便于单测注入，生产取 REPORT_SEND_HOUR） */
export interface DueReportsConfig {
  daily: boolean;
  weekly: boolean;
  sendHour: number;
}

/** 用户可编辑的报告配置（app_settings['finance_report']） */
export interface FinanceReportConfig {
  recipients: string[];
  /** 毛利率阈值（0..1） */
  marginLowPct: number;
  /** 成本环比倍数（>=1） */
  costSpikeFactor: number;
  daily: boolean;
  weekly: boolean;
}

// ---------------------------------------------------------------------------
// 北京时区 / ISO 周 工具（全部由 epoch ms 推算，与运行环境本地时区无关）
// ---------------------------------------------------------------------------

/** epoch ms → 北京日历日 'YYYY-MM-DD' */
function bjDateStr(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 减 delta 天 → 'YYYY-MM-DD' */
function shiftDateStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** 当前 ISO 周的周一 00:00（北京）对应的真实 epoch ms */
function currentWeekMondayMs(nowMs: number): number {
  const bj = new Date(nowMs + BJ_OFFSET_MS);
  const dow = (bj.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  const mondayBjMidnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - dow);
  return mondayBjMidnight - BJ_OFFSET_MS;
}

/** epoch ms 所在 ISO 周键 'YYYY-Www'（北京口径，Thursday 决定归属年，跨年稳定） */
function isoWeekKey(ms: number): string {
  const bj = new Date(ms + BJ_OFFSET_MS);
  const date = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 移到本周周四
  const isoYear = date.getUTCFullYear();
  const week1Thu = new Date(Date.UTC(isoYear, 0, 4));
  const w1DayNum = (week1Thu.getUTCDay() + 6) % 7;
  week1Thu.setUTCDate(week1Thu.getUTCDate() - w1DayNum + 3);
  const week = 1 + Math.round((date.getTime() - week1Thu.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 应发窗口
// ---------------------------------------------------------------------------

export interface DailyWindow {
  /** 覆盖日（= 状态串）YYYY-MM-DD */
  target: string;
  from: string;
  to: string;
  /** 环比：上一等长区间（前一天） */
  prevFrom: string;
  prevTo: string;
}

/**
 * 日报应发窗口：达当日 sendHour → 覆盖「昨日」；未达 → 覆盖「前日」（上一个应发窗口，供补发）。
 * 报告只覆盖已完整过完的北京日历日，避免当日未结算窗口。
 */
export function dailyReportWindow(nowMs: number, sendHour: number): DailyWindow {
  const bj = new Date(nowMs + BJ_OFFSET_MS);
  const hour = bj.getUTCHours();
  const offset = hour >= sendHour ? -1 : -2;
  const target = shiftDateStr(bjDateStr(nowMs), offset);
  return { target, from: target, to: target, prevFrom: shiftDateStr(target, -1), prevTo: shiftDateStr(target, -1) };
}

export interface WeeklyWindow {
  /** 覆盖周键（= 状态串）YYYY-Www */
  targetKey: string;
  from: string;
  to: string;
  /** 环比：上一等长区间（前一周） */
  prevFrom: string;
  prevTo: string;
}

/**
 * 周报应发窗口：达本周周一 sendHour → 覆盖「上一整周」；未达 → 覆盖「上上周」（上一个应发窗口，供补发）。
 * 报告只覆盖已完整过完的 ISO 周。
 */
export function weeklyReportWindow(nowMs: number, sendHour: number): WeeklyWindow {
  const mondayMs = currentWeekMondayMs(nowMs);
  const sendMoment = mondayMs + sendHour * 3_600_000;
  const targetMondayMs = nowMs >= sendMoment ? mondayMs - 7 * DAY_MS : mondayMs - 14 * DAY_MS;
  const from = bjDateStr(targetMondayMs);
  const to = bjDateStr(targetMondayMs + 6 * DAY_MS);
  const prevFrom = bjDateStr(targetMondayMs - 7 * DAY_MS);
  const prevTo = bjDateStr(targetMondayMs - 1 * DAY_MS);
  // 周四决定 ISO 周年归属，键从周四取最稳
  const targetKey = isoWeekKey(targetMondayMs + 3 * DAY_MS);
  return { targetKey, from, to, prevFrom, prevTo };
}

/**
 * 应发档判定：state 里目标周期串与当前应发目标不一致即应发（仿 billing dueReminders 幂等语义）。
 * 达 sendHour 后覆盖上一完整周期；错过时刻也能在当期内补发一次（自愈），发过即不重发。
 */
export function dueReports(nowMs: number, state: FinanceReportState, cfg: DueReportsConfig): ReportKind[] {
  const out: ReportKind[] = [];
  if (cfg.daily && state.daily !== dailyReportWindow(nowMs, cfg.sendHour).target) out.push('daily');
  if (cfg.weekly && state.weekly !== weeklyReportWindow(nowMs, cfg.sendHour).targetKey) out.push('weekly');
  return out;
}

// ---------------------------------------------------------------------------
// 阈值判定
// ---------------------------------------------------------------------------

export interface MarginLowHit {
  slug: string;
  label: string;
  revenue: number;
  cost: number;
  profit: number;
  /** 毛利率（profit/revenue） */
  margin: number;
}

export interface CostSpikeHit {
  slug: string;
  label: string;
  curCost: number;
  prevCost: number;
  /** 当期/上期 成本倍数 */
  factor: number;
}

export interface ThresholdHits {
  marginLow: MarginLowHit[];
  costSpike: CostSpikeHit[];
}

/**
 * 阈值判定：
 *  - 先剔除 ok===false 降级站（口径铁律，探测失败不误报）。
 *  - margin_low：cost!==null 且 revenue>0 且 毛利率(profit/revenue) < marginLowPct。
 *  - cost_spike：上期同站 ok 且 prev.cost>0 且 cur.cost/prev.cost > costSpikeFactor（金额 USD）。
 */
export function evaluateThresholds(
  curRows: FinanceSummaryRow[],
  prevRows: FinanceSummaryRow[],
  cfg: { marginLowPct: number; costSpikeFactor: number },
): ThresholdHits {
  const prevBySlug = new Map<string, FinanceSummaryRow>();
  for (const p of prevRows) if (p.ok !== false) prevBySlug.set(p.slug, p);

  const marginLow: MarginLowHit[] = [];
  const costSpike: CostSpikeHit[] = [];

  for (const r of curRows) {
    if (r.ok === false) continue; // 剔除降级站
    if (r.cost === null || r.profit === null) continue; // 无成本口径不判定

    if (r.revenue > 0) {
      const margin = r.profit / r.revenue;
      if (margin < cfg.marginLowPct) {
        marginLow.push({ slug: r.slug, label: r.label, revenue: r.revenue, cost: r.cost, profit: r.profit, margin });
      }
    }

    const prev = prevBySlug.get(r.slug);
    if (prev && prev.cost !== null && prev.cost > 0) {
      const factor = r.cost / prev.cost;
      if (factor > cfg.costSpikeFactor) {
        costSpike.push({ slug: r.slug, label: r.label, curCost: r.cost, prevCost: prev.cost, factor });
      }
    }
  }

  return { marginLow, costSpike };
}

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

/** USD 金额格式：|n|<1 保 4 位（次分级成本可见），否则 2 位；非有限值 → — */
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2);
}

/** 毛利率百分比（1 位）；营收<=0 → — */
function fmtMargin(revenue: number, profit: number | null): string {
  if (profit === null || revenue <= 0) return '—';
  return `${((profit / revenue) * 100).toFixed(1)}%`;
}

/** 环比百分比（当前 vs 上期）；上期<=0 → — */
function fmtDelta(cur: number, prev: number): string {
  if (!Number.isFinite(prev) || prev <= 0) return '—';
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

const FOOTER = '—— 本邮件由 relay-panel 自动发送，请勿直接回复。';

/** 逐站明细行（营收/成本/毛利/毛利率/请求）；降级站单列标注 */
function renderSiteLines(rows: FinanceSummaryRow[]): string[] {
  if (rows.length === 0) return ['（本区间无站点数据）'];
  const lines: string[] = [];
  for (const r of rows) {
    if (r.ok === false) {
      lines.push(`- ${r.label}：数据不可用（探测降级，未计入合计）`);
      continue;
    }
    lines.push(
      `- ${r.label}：营收 ${fmtUsd(r.revenue)} USD | 成本 ${fmtUsd(r.cost)} USD | ` +
        `毛利 ${fmtUsd(r.profit)} USD | 毛利率 ${fmtMargin(r.revenue, r.profit)} | 请求 ${r.requests}`,
    );
  }
  return lines;
}

/**
 * 合计块（营收/成本/毛利/毛利率）；totals 已剔除降级站。
 * 🔴 毛利率分母用 costedRevenue（有成本口径站点的营收）而非 revenue：
 * revenue 含「营收有、成本无」的站点，拿它当分母会把毛利率稀释低估（假报亏损红线）。
 * 未全覆盖（costedRevenue<revenue）时另由 costCaveatNote 追加提示，镜像 /finance 页 allCosted 口径。
 */
function renderTotalsLines(totals: FinanceSummaryTotals): string[] {
  return [
    `营收合计: ${fmtUsd(totals.revenue)} USD`,
    `成本合计: ${fmtUsd(totals.cost)} USD`,
    `毛利合计: ${fmtUsd(totals.profit)} USD`,
    `毛利率: ${fmtMargin(totals.costedRevenue, totals.profit)}`,
  ];
}

/**
 * 成本口径缺口提示（镜像 /finance 页 !allCosted 的保护信号）：
 * 有「在线（ok!==false）但无成本口径（cost===null）」的站点时，其营收计入营收合计却未计入
 * 成本/毛利/毛利率——追加一行说明未计入的营收额与毛利率分母，避免读者手算「营收合计−成本合计≠毛利合计」时困惑。
 */
function costCaveatNote(rows: FinanceSummaryRow[], totals: FinanceSummaryTotals): string[] {
  const uncosted = rows.filter((r) => r.ok !== false && r.cost === null);
  if (uncosted.length === 0) return [];
  const uncostedRevenue = totals.revenue - totals.costedRevenue;
  return [
    '',
    `⚠ ${uncosted.length} 个站点引擎未提供账户成本且未配成本率，其营收 ${fmtUsd(uncostedRevenue)} USD ` +
      `未计入毛利/毛利率（毛利率以已计成本营收 ${fmtUsd(totals.costedRevenue)} USD 为分母）。`,
  ];
}

/** 降级站提示（若有）：合计不含这些站 */
function degradedNote(rows: FinanceSummaryRow[]): string[] {
  const degraded = rows.filter((r) => r.ok === false);
  if (degraded.length === 0) return [];
  return ['', `⚠ ${degraded.length} 个站点本次探测降级，其营收/成本未计入合计。`];
}

/**
 * 日报（覆盖单个北京日历日）。root 全站经营汇总，纯文本。
 */
export function renderDailyReport(
  from: string,
  _to: string,
  rows: FinanceSummaryRow[],
  totals: FinanceSummaryTotals,
): { subject: string; text: string } {
  const subject = `[relay-panel 日报] ${from} 经营汇总`;
  const lines = [
    `relay-panel 经营日报 · ${from}（北京时间）`,
    '',
    '各站明细（金额单位 USD）：',
    ...renderSiteLines(rows),
    '',
    '合计：',
    ...renderTotalsLines(totals),
    `请求合计: ${totals.requests}`,
    ...costCaveatNote(rows, totals),
    ...degradedNote(rows),
    '',
    FOOTER,
  ];
  return { subject, text: lines.join('\n') };
}

/**
 * 周报（覆盖一个 ISO 周，含区间合计 + 与上一周环比）。root 全站经营汇总，纯文本。
 */
export function renderWeeklyReport(
  from: string,
  to: string,
  rows: FinanceSummaryRow[],
  totals: FinanceSummaryTotals,
  prevTotals?: FinanceSummaryTotals,
): { subject: string; text: string } {
  const subject = `[relay-panel 周报] ${from} ~ ${to} 经营汇总`;
  const lines = [
    `relay-panel 经营周报 · ${from} ~ ${to}（北京时间）`,
    '',
    '各站明细（金额单位 USD）：',
    ...renderSiteLines(rows),
    '',
    '合计：',
    ...renderTotalsLines(totals),
    `请求合计: ${totals.requests}`,
  ];
  if (prevTotals !== undefined) {
    lines.push(
      '',
      '环比上一周（金额单位 USD）：',
      `营收: ${fmtUsd(totals.revenue)} vs ${fmtUsd(prevTotals.revenue)}（${fmtDelta(totals.revenue, prevTotals.revenue)}）`,
      `成本: ${fmtUsd(totals.cost)} vs ${fmtUsd(prevTotals.cost)}（${fmtDelta(totals.cost, prevTotals.cost)}）`,
      `毛利: ${fmtUsd(totals.profit)} vs ${fmtUsd(prevTotals.profit)}（${fmtDelta(totals.profit, prevTotals.profit)}）`,
    );
  }
  lines.push(...costCaveatNote(rows, totals), ...degradedNote(rows), '', FOOTER);
  return { subject, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 配置解析（app_settings['finance_report'] 原始值 → 规整配置，容错回落默认）
// ---------------------------------------------------------------------------

/** 报告配置的默认值（未配置时用） */
export function defaultReportConfig(): FinanceReportConfig {
  return {
    recipients: [],
    marginLowPct: DEFAULT_MARGIN_LOW_PCT,
    costSpikeFactor: DEFAULT_COST_SPIKE_FACTOR,
    daily: true,
    weekly: true,
  };
}

/** 把 app_settings 存的原始 JSON 规整成 FinanceReportConfig（非法字段回落默认，绝不抛） */
export function parseReportConfig(raw: unknown): FinanceReportConfig {
  const def = defaultReportConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
  const o = raw as Record<string, unknown>;
  const recipients = Array.isArray(o.recipients)
    ? o.recipients.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : def.recipients;
  const marginLowPct =
    typeof o.marginLowPct === 'number' && Number.isFinite(o.marginLowPct) && o.marginLowPct >= 0 && o.marginLowPct <= 1
      ? o.marginLowPct
      : def.marginLowPct;
  const costSpikeFactor =
    typeof o.costSpikeFactor === 'number' && Number.isFinite(o.costSpikeFactor) && o.costSpikeFactor >= 1
      ? o.costSpikeFactor
      : def.costSpikeFactor;
  return {
    recipients,
    marginLowPct,
    costSpikeFactor,
    daily: typeof o.daily === 'boolean' ? o.daily : def.daily,
    weekly: typeof o.weekly === 'boolean' ? o.weekly : def.weekly,
  };
}

/** 把发送标记原始 JSON 规整成 FinanceReportState（容错回落空） */
export function parseReportState(raw: unknown): FinanceReportState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const state: FinanceReportState = {};
  if (typeof o.daily === 'string') state.daily = o.daily;
  if (typeof o.weekly === 'string') state.weekly = o.weekly;
  return state;
}
