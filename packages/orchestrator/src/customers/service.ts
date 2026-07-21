import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import type {
  CredentialStore,
  EngineAdapter,
  EngineKind,
  InstanceInfo,
  SiteCustomerRecord,
} from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { appSettings, customerSnapshots, sites, type SiteRow } from '../db/schema.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import { redactText } from '../jobs/engine.js';

/**
 * 客户 CRM 核心（F4）：纯函数（分层 / 骤降 / 流失判定）+ 跨站客户采集。
 * 供 routes.ts（呈现）与 snapshot.ts（每日快照 + 可选流失告警）复用，纯函数可单测。
 *
 * 口径铁律：
 *  - balance = 客户预付余额（对客钱包负债，站点结算货币口径），与上游 channel 余额严格区分；
 *  - period_cost 语义 = 累计净消耗代理 = totalRecharged - balance - frozenBalance（近似，受退款/调额影响）；
 *  - 跨站【默认不合并】：同一人在两站按 (siteSlug:userId) 逐行，负债会重复计（UI 注明）；
 *  - ok=false 降级站（无 listAll 的 newapi / 连不上）从聚合剔除，绝不误报流失。
 *  - 🔴 纯只读分析：绝不写回引擎、绝不改客户额度/砍余额。
 */

// ---------------------------------------------------------------------------
// 配置（存 app_settings['customer_crm_config']，root 可 PUT 编辑）
// ---------------------------------------------------------------------------

export const CRM_CONFIG_KEY = 'customer_crm_config';

export type CustomerTier = 'big' | 'mid' | 'small';

export interface CrmConfig {
  /** 大 R 门槛：累计充值 ≥ 此值（USD）判大客户。默认 100 */
  tierBigUsd: number;
  /** 中 R 门槛：累计充值 ≥ 此值（USD，且 < 大 R）判中客户。默认 20 */
  tierMidUsd: number;
  /** 流失·无活跃阈值：距最近活跃 ≥ 此天数判可能流失。默认 14 */
  churnInactiveDays: number;
  /** 骤降窗口天数：近 N 日 vs 前 N 日日均消费对比窗口。默认 7 */
  dropWindowDays: number;
  /** 骤降幅度阈值：日均消费降幅 ≥ 此比例（0..1）判骤降。默认 0.6（降 60%） */
  dropThresholdPct: number;
  /** 骤降信号最小快照天数：历史 < 此值不出骤降信号（冷启动）。默认 3 */
  minSnapshotDays: number;
  /** 是否开启流失告警（默认 false=零告警；true 时 snapshot 循环按站开 customer_churn 告警） */
  churnAlertsEnabled: boolean;
}

export const DEFAULT_CRM_CONFIG: CrmConfig = {
  tierBigUsd: 100,
  tierMidUsd: 20,
  churnInactiveDays: 14,
  dropWindowDays: 7,
  dropThresholdPct: 0.6,
  minSnapshotDays: 3,
  churnAlertsEnabled: false,
};

/** 容错解析 app_settings['customer_crm_config']：非法/越界字段各自回落默认 + 区间收敛护栏 */
export function parseCrmConfig(raw: unknown): CrmConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  const cfg: CrmConfig = {
    tierBigUsd: num(o.tierBigUsd, DEFAULT_CRM_CONFIG.tierBigUsd, 0, 1_000_000_000),
    tierMidUsd: num(o.tierMidUsd, DEFAULT_CRM_CONFIG.tierMidUsd, 0, 1_000_000_000),
    churnInactiveDays: Math.floor(num(o.churnInactiveDays, DEFAULT_CRM_CONFIG.churnInactiveDays, 1, 3650)),
    dropWindowDays: Math.floor(num(o.dropWindowDays, DEFAULT_CRM_CONFIG.dropWindowDays, 1, 90)),
    dropThresholdPct: num(o.dropThresholdPct, DEFAULT_CRM_CONFIG.dropThresholdPct, 0, 1),
    minSnapshotDays: Math.floor(num(o.minSnapshotDays, DEFAULT_CRM_CONFIG.minSnapshotDays, 2, 90)),
    churnAlertsEnabled: o.churnAlertsEnabled === true,
  };
  // 大 R 门槛不得低于中 R 门槛（配错时把大 R 抬到中 R，保证 tierOf 单调）
  if (cfg.tierBigUsd < cfg.tierMidUsd) cfg.tierBigUsd = cfg.tierMidUsd;
  return cfg;
}

/** 读 app_settings['customer_crm_config']（容错回落默认） */
export async function readCrmConfig(db: Db): Promise<CrmConfig> {
  const rows = await db.orm
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, CRM_CONFIG_KEY))
    .limit(1);
  return parseCrmConfig(rows[0]?.value);
}

/** PUT 补丁：每字段可缺省或显式 undefined（=不改），兼容 exactOptionalPropertyTypes 下的 zod 输出 */
export type CrmConfigPatch = { [K in keyof CrmConfig]?: CrmConfig[K] | undefined };

/** 合并现值写回（PUT 只覆盖显式传入字段，undefined=不改），校验后 upsert（仅 customer_crm_config 一个 key） */
export async function writeCrmConfig(db: Db, patch: CrmConfigPatch): Promise<CrmConfig> {
  const current = await readCrmConfig(db);
  const merged: Record<string, unknown> = { ...current };
  for (const k of Object.keys(patch) as (keyof CrmConfig)[]) {
    const v = patch[k];
    if (v !== undefined) merged[k] = v;
  }
  const next = parseCrmConfig(merged);
  const now = toPgTimestamp(new Date());
  const valueJson = next as unknown as Record<string, unknown>;
  await db.orm
    .insert(appSettings)
    .values({ key: CRM_CONFIG_KEY, value: valueJson, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: valueJson, updatedAt: now } });
  return next;
}

// ---------------------------------------------------------------------------
// 纯函数：分层 / 骤降 / 流失（供单测直接驱动）
// ---------------------------------------------------------------------------

/** 分层：累计充值(USD) → 大/中/小 R（≥big=big；≥mid=mid；否则 small） */
export function tierOf(totalRechargedUsd: number, cfg: CrmConfig): CustomerTier {
  const v = Number.isFinite(totalRechargedUsd) ? totalRechargedUsd : 0;
  if (v >= cfg.tierBigUsd) return 'big';
  if (v >= cfg.tierMidUsd) return 'mid';
  return 'small';
}

/** 快照点（骤降算法只关心 period_cost 累计净消耗；按 captured_date 升序传入） */
export interface SnapshotPoint {
  capturedDate: string;
  periodCost: number;
}

export interface DropResult {
  /** 近窗口日均消费（USD，估算） */
  dailySpendRecent: number;
  /** 前窗口日均消费（USD，估算） */
  dailySpendPrior: number;
  /** 降幅比例 (prior-recent)/prior；prior<=0 时 0 */
  dropPct: number;
  /** 是否判骤降（enoughHistory 且 prior>0 且降幅达阈值） */
  dropFlag: boolean;
  /** 历史是否足够出骤降信号（快照数 ≥ minSnapshotDays 且两窗口各 ≥1 个相邻差值） */
  enoughHistory: boolean;
}

/**
 * 骤降侦测（纯函数）：用相邻快照的 period_cost 差值算每日消耗，比较近窗口 vs 前窗口日均。
 *  - 相邻差值 delta[i]=max(0, cost[i]-cost[i-1])（充值中性：total_recharged 与 balance 同增，净不变；
 *    退款/调额可能致负，clamp 到 0 作消费估算）。
 *  - 近窗口=末端最多 dropWindowDays 个（但不超过一半）差值；前窗口=其紧邻更早的最多 dropWindowDays 个。
 *  - 历史 < minSnapshotDays（快照数）或任一窗口空 → enoughHistory=false，绝不出骤降信号（冷启动）。
 */
export function detectDrop(snapshotsAsc: SnapshotPoint[], cfg: CrmConfig): DropResult {
  const empty: DropResult = { dailySpendRecent: 0, dailySpendPrior: 0, dropPct: 0, dropFlag: false, enoughHistory: false };
  const n = snapshotsAsc.length;
  if (n < 2) return empty;

  const deltas: number[] = [];
  for (let i = 1; i < n; i++) {
    deltas.push(Math.max(0, snapshotsAsc[i]!.periodCost - snapshotsAsc[i - 1]!.periodCost));
  }
  const m = deltas.length;
  const W = cfg.dropWindowDays;
  // 近窗口取末端，长度不超过 W 且不超过总差值的一半（留出前窗口对比空间）
  const recentLen = Math.min(W, Math.ceil(m / 2));
  const recent = deltas.slice(m - recentLen);
  // 前窗口=紧邻近窗口更早的最多 W 个
  const priorEnd = m - recentLen;
  const prior = deltas.slice(Math.max(0, priorEnd - W), priorEnd);

  const avg = (a: number[]): number => (a.length > 0 ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const dailySpendRecent = avg(recent);
  const dailySpendPrior = avg(prior);
  const enoughHistory = n >= cfg.minSnapshotDays && recent.length >= 1 && prior.length >= 1;
  const dropPct = dailySpendPrior > 0 ? (dailySpendPrior - dailySpendRecent) / dailySpendPrior : 0;
  const dropFlag = enoughHistory && dailySpendPrior > 0 && dropPct >= cfg.dropThresholdPct;
  return { dailySpendRecent, dailySpendPrior, dropPct, dropFlag, enoughHistory };
}

export type ChurnReason = 'inactive' | 'spend_drop';

export interface ChurnResult {
  churnRisk: boolean;
  reasons: ChurnReason[];
}

/**
 * 流失判定（纯函数）：无活跃 ≥ churnInactiveDays（取 lastActiveAt/lastUsedAt 较晚者）或消费骤降。
 *  - 活跃时间双源取 max（活跃=登录/请求；lastUsed=key 最后使用），避免误报；两者皆缺=不判无活跃。
 *  - 骤降只在 enoughHistory 时才作为流失理由（冷启动不误报）。
 */
export function churnAssess(
  row: Pick<SiteCustomerRecord, 'lastActiveAt' | 'lastUsedAt'>,
  drop: DropResult,
  cfg: CrmConfig,
  nowMs: number = Date.now(),
): ChurnResult {
  const reasons: ChurnReason[] = [];

  const parseMs = (s?: string): number | null => {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  const lastActive = Math.max(parseMs(row.lastActiveAt) ?? -Infinity, parseMs(row.lastUsedAt) ?? -Infinity);
  if (Number.isFinite(lastActive)) {
    const inactiveDays = (nowMs - lastActive) / 86_400_000;
    if (inactiveDays >= cfg.churnInactiveDays) reasons.push('inactive');
  }

  if (drop.enoughHistory && drop.dropFlag) reasons.push('spend_drop');

  return { churnRisk: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// 跨站客户采集
// ---------------------------------------------------------------------------

export interface CrmDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
}

/** 采集到的单个客户（附站点标识；跨站不合并，key=siteSlug:userId） */
export interface LiveCustomer extends SiteCustomerRecord {
  siteSlug: string;
  siteLabel: string;
  /** 跨站不合并的唯一键 */
  key: string;
}

/** 降级站（无 listAll 引擎 / 连不上）——从聚合剔除，UI 提示 */
export interface DegradedSite {
  siteSlug: string;
  siteLabel: string;
  reason: string;
}

export interface CollectResult {
  customers: LiveCustomer[];
  degradedSites: DegradedSite[];
  /** 参与采集的站数（ok 站） */
  okSiteCount: number;
}

function instOf(site: SiteRow): InstanceInfo {
  return {
    siteSlug: site.slug,
    engine: site.engine as EngineKind,
    version: site.version,
    baseUrl: site.baseUrl,
    dataDir: site.dataDir,
    composeProject: site.composeProject,
    credentialRef: site.credentialRef,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 跨站采集所有可见站（status!=destroyed）的客户。逐站顺序连接 adapter 调 users.listAll：
 *  - adapter 无 listAll（如 newapi）或 connect/listAll 抛错 → 标 degraded 并从聚合剔除（不误报流失）；
 *  - 仅统计客户（role!=admin，站点管理员非客户，剔除避免污染分层/负债）。
 * 跨站不合并：key=siteSlug:userId。credstore 自建（照 alerts/engine.ts、risk/service.ts 模式），零耦合 sites/service.ts。
 */
export async function collectLiveCustomers(
  deps: CrmDeps,
  credstore?: CredentialStore,
): Promise<CollectResult> {
  const store = credstore ?? makeCredentialStoreV2(deps.db, deps.config);
  const rows = await deps.db.orm.select().from(sites).where(ne(sites.status, 'destroyed'));

  const customers: LiveCustomer[] = [];
  const degradedSites: DegradedSite[] = [];
  let okSiteCount = 0;

  for (const site of rows) {
    const siteRef = { siteSlug: site.slug, siteLabel: site.label };
    const adapter = deps.adapters[site.engine as EngineKind];
    if (!adapter) {
      degradedSites.push({ ...siteRef, reason: 'no-adapter' });
      continue;
    }
    let records: SiteCustomerRecord[];
    try {
      const client = await adapter.connect(instOf(site), store);
      const listAll = client.users.listAll;
      if (!listAll) {
        // 引擎不支持全量客户拉取（newapi）——剔除，不误报
        degradedSites.push({ ...siteRef, reason: 'unsupported' });
        continue;
      }
      records = await listAll({ includeSubscriptions: true });
    } catch (err) {
      console.warn(`[crm] 站点 ${site.slug} 客户采集失败:`, redactText(errText(err)));
      degradedSites.push({ ...siteRef, reason: 'unreachable' });
      continue;
    }
    okSiteCount += 1;
    for (const r of records) {
      if (r.role === 'admin') continue; // 站点管理员非客户
      customers.push({ ...r, siteSlug: site.slug, siteLabel: site.label, key: `${site.slug}:${r.userId}` });
    }
  }

  return { customers, degradedSites, okSiteCount };
}

// ---------------------------------------------------------------------------
// 快照历史（供 routes 呈现与 snapshot 循环流失告警复用）
// ---------------------------------------------------------------------------

/** 北京(Asia/Shanghai)当前日历日 YYYY-MM-DD */
export function beijingTodayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 日期串加 delta 天 */
export function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * 拉指定站自 sinceDate（含）起的快照历史，按 (siteSlug:userId) 分组、captured_date 升序。
 * captured_date 为 'YYYY-MM-DD' 字符串，字典序即时间序；容忍缺失日（非连续），按实际相邻快照差算。
 */
export async function loadSnapshotHistory(
  db: Db,
  siteSlugs: string[],
  sinceDate: string,
): Promise<Map<string, SnapshotPoint[]>> {
  const map = new Map<string, SnapshotPoint[]>();
  if (siteSlugs.length === 0) return map;
  const rows = await db.orm
    .select({
      siteSlug: customerSnapshots.siteSlug,
      userId: customerSnapshots.userId,
      capturedDate: customerSnapshots.capturedDate,
      periodCost: customerSnapshots.periodCost,
    })
    .from(customerSnapshots)
    .where(and(inArray(customerSnapshots.siteSlug, siteSlugs), gte(customerSnapshots.capturedDate, sinceDate)))
    .orderBy(customerSnapshots.capturedDate);
  for (const r of rows) {
    const key = `${r.siteSlug}:${r.userId}`;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push({ capturedDate: r.capturedDate, periodCost: r.periodCost });
  }
  return map;
}

/** 快照时点累计净消耗代理 = totalRecharged - balance - frozenBalance（缺省按 0） */
export function periodCostOf(c: Pick<SiteCustomerRecord, 'balance' | 'frozenBalance' | 'totalRecharged'>): number {
  return (c.totalRecharged ?? 0) - (c.balance ?? 0) - (c.frozenBalance ?? 0);
}
