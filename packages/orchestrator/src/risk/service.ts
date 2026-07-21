import { and, eq, ne } from 'drizzle-orm';
import type {
  CredentialStore,
  CustomerRankingItem,
  EngineAdapter,
  EngineAdminClient,
  EngineKind,
  InstanceInfo,
  PlatformQuota,
  PlatformQuotaInput,
} from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { appSettings, sites, type SiteRow } from '../db/schema.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import { redactText } from '../jobs/engine.js';
import { findOpenAlert, openAlert, resolveAlert } from '../alerts/engine.js';
import type { Notifier } from '../alerts/notify.js';

/**
 * 风控 / 异常消费告警 + 限额护栏（F3）。
 *
 * 侦测（骤增）：对每个可见站（status!=destroyed，连不上/降级站自动剔除），取两窗口客户消费榜单
 *   （近期=今日 vs 基线=近 N 日均值，via stats.customerRanking，Top-50/站），按 app_settings['risk_rules']
 *   （spikeMultiplier/absFloorUsd/baselineDays）判 spend_spike；单站一条 open（detail 枚举骤增用户去重）。
 *
 * 护栏（限额）：platform-quotas 是 user×platform 粒度且日/周/月窗口，骤增是 user 总额——「哪个平台限多少」
 *   无法从总额安全自动派生，故写回永远 root 显式传 {platform,window,limitUsd}，preview 只做 GET-合并展示。
 *   🔴 默认【仅告警】：config.riskEnforce===false 时 enforceQuota 直接抛（绝不调 setPlatformQuotas）；
 *   true 才 GET→合并（保留未涉及 platform 与同 platform 其它窗口，null≠0）→PUT 全量写回 + openAlert + 审计。
 *
 * 与 alerts/engine.ts 完全解耦：独立 setInterval（unref）+ 重入锁；intervalMs<=0 不起循环。
 * 复用 alerts/engine.ts 已 export 的 openAlert/resolveAlert/findOpenAlert 与 makeCredentialStoreV2。
 */

// ---------------------------------------------------------------------------
// 规则（存 app_settings['risk_rules']，root 可 PUT 编辑）
// ---------------------------------------------------------------------------

export const RISK_RULES_KEY = 'risk_rules';

export interface RiskRules {
  /** 骤增倍率：近期日消费 / 基线日均 ≥ 此值判骤增。默认 3 */
  spikeMultiplier: number;
  /** 绝对下限（USD）：近期消费须 ≥ 此值才告警（滤小额噪音）。默认 10 */
  absFloorUsd: number;
  /** 基线天数：取近 N 日均值作基线。默认 7 */
  baselineDays: number;
}

const DEFAULT_RULES: RiskRules = { spikeMultiplier: 3, absFloorUsd: 10, baselineDays: 7 };

/** 容错解析 app_settings['risk_rules']（非法/越界字段回落默认，且区间收敛护栏） */
export function parseRiskRules(raw: unknown): RiskRules {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    spikeMultiplier: num(o.spikeMultiplier, DEFAULT_RULES.spikeMultiplier, 1, 1000),
    absFloorUsd: num(o.absFloorUsd, DEFAULT_RULES.absFloorUsd, 0, 1_000_000_000),
    baselineDays: Math.floor(num(o.baselineDays, DEFAULT_RULES.baselineDays, 1, 90)),
  };
}

// ---------------------------------------------------------------------------
// 骤增侦测（纯函数，供单测直接驱动）
// ---------------------------------------------------------------------------

export interface SpikeRow {
  userId: number;
  email: string;
  /** 近期窗口消费（USD，actual_cost 口径=真实营收/扣费） */
  recentCost: number;
  /** 基线日均消费（USD）；无历史时 0 */
  baselineDaily: number;
  /** recentCost / baselineDaily；baselineDaily<=0（无历史）时 Infinity */
  ratio: number;
}

/**
 * 纯函数：给定近期窗口榜单 recent 与基线窗口榜单 baseline（均为 actual_cost 口径）+ 规则，算骤增用户。
 *  - baselineDaily = 该用户基线窗口总消费 / baselineDays。
 *  - 判定：recentCost >= absFloorUsd 且 ratio(=recentCost/baselineDaily) >= spikeMultiplier。
 *  - baselineDaily<=0（无历史）：只要 recentCost>=absFloorUsd 即视骤增（ratio=Infinity，新增大额消费者）。
 * 按 recentCost 降序返回。
 */
export function detectSpikes(
  recent: CustomerRankingItem[],
  baseline: CustomerRankingItem[],
  rules: RiskRules,
): SpikeRow[] {
  const baseMap = new Map<number, number>();
  for (const b of baseline) baseMap.set(b.userId, b.actualCost);
  const out: SpikeRow[] = [];
  for (const r of recent) {
    const recentCost = r.actualCost;
    if (recentCost < rules.absFloorUsd) continue; // 过绝对下限才考虑
    const baseTotal = baseMap.get(r.userId) ?? 0;
    const baselineDaily = baseTotal > 0 ? baseTotal / rules.baselineDays : 0;
    const ratio = baselineDaily > 0 ? recentCost / baselineDaily : Infinity;
    if (ratio >= rules.spikeMultiplier) {
      out.push({ userId: r.userId, email: r.email, recentCost, baselineDaily, ratio });
    }
  }
  out.sort((a, b) => b.recentCost - a.recentCost);
  return out;
}

// ---------------------------------------------------------------------------
// 限额合并（GET-合并，纯函数，供单测直接驱动）
// ---------------------------------------------------------------------------

export type QuotaWindow = 'daily' | 'weekly' | 'monthly';

export interface QuotaChange {
  platform: string;
  window: QuotaWindow;
  /** null=不限；0=完全禁用；>0=USD 上限 */
  limitUsd: number | null;
}

/**
 * GET-合并：把 change 叠加到 current 全量限额上，产出 PUT【全量替换】输入。
 * 🔴 必须保留：(a) 未涉及的其它 platform 行（否则被软删）(b) 同 platform 未涉及的其它两窗口 limit。
 * null≠0：各窗口按 current 的 limitUsd（null=不限）原样搬运，绝不把「清空/不限」落成 0=禁用。
 */
export function mergeQuotaInput(current: PlatformQuota[], change: QuotaChange): PlatformQuotaInput[] {
  const byPlatform = new Map<string, PlatformQuotaInput>();
  // 先把现有全部平台搬进来（保留每平台三窗口现值：null=不限 / 0=禁用 / >0=上限 原样）
  for (const p of current) {
    byPlatform.set(p.platform, {
      platform: p.platform,
      dailyLimitUsd: p.daily.limitUsd,
      weeklyLimitUsd: p.weekly.limitUsd,
      monthlyLimitUsd: p.monthly.limitUsd,
    });
  }
  // 目标平台不存在则新建（其余两窗口=不限 null）
  let target = byPlatform.get(change.platform);
  if (!target) {
    target = { platform: change.platform, dailyLimitUsd: null, weeklyLimitUsd: null, monthlyLimitUsd: null };
    byPlatform.set(change.platform, target);
  }
  // 覆盖目标窗口（null=不限/0=禁用/>0=上限）
  if (change.window === 'daily') target.dailyLimitUsd = change.limitUsd;
  else if (change.window === 'weekly') target.weeklyLimitUsd = change.limitUsd;
  else target.monthlyLimitUsd = change.limitUsd;
  return [...byPlatform.values()];
}

// ---------------------------------------------------------------------------
// RiskService
// ---------------------------------------------------------------------------

export interface RiskDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  notifier: Notifier;
}

/** 单站骤增聚合 */
export interface SiteSpikes {
  siteId: number;
  siteSlug: string;
  siteLabel: string;
  spikes: SpikeRow[];
}

/** GET-合并预览（不写回） */
export interface QuotaPreview {
  platform: string;
  window: QuotaWindow;
  /** 当前全量限额（GET 回读） */
  current: PlatformQuota[];
  /** 合并后将写回的全量输入（若 enforce=on 才会实际 PUT） */
  merged: PlatformQuotaInput[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** 北京(Asia/Shanghai)当前日历日 YYYY-MM-DD */
function beijingTodayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 日期串加 delta 天 */
function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * 北京日历日 'YYYY-MM-DD' → 锚该日正午 UTC 的 Date（adapter 的 customerRanking 用 timezone=Asia/Shanghai
 * 解释 start_date/end_date，锚正午保证 toISOString().slice(0,10) 取到该北京日历日）。
 */
function bjDateAnchor(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

/** 金额展示：小额 4 位、其余 2 位 */
function fmtUsd(n: number): string {
  return Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2);
}

export class RiskService {
  private readonly credstore: CredentialStore;

  constructor(private readonly deps: RiskDeps) {
    this.credstore = makeCredentialStoreV2(deps.db, deps.config);
  }

  // ---- 规则读写 ----

  async readRules(): Promise<RiskRules> {
    const rows = await this.deps.db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, RISK_RULES_KEY))
      .limit(1);
    return parseRiskRules(rows[0]?.value);
  }

  /** 合并现值（PUT 只覆盖显式传入的字段，undefined=不改），校验后 upsert（仅 risk_rules 一个 key） */
  async writeRules(patch: Partial<Record<keyof RiskRules, number | undefined>>): Promise<RiskRules> {
    const current = await this.readRules();
    const merged: Record<string, number> = { ...current };
    for (const k of ['spikeMultiplier', 'absFloorUsd', 'baselineDays'] as const) {
      const v = patch[k];
      if (v !== undefined) merged[k] = v;
    }
    const next = parseRiskRules(merged);
    const now = toPgTimestamp(new Date());
    const valueJson = next as unknown as Record<string, unknown>;
    await this.deps.db.orm
      .insert(appSettings)
      .values({ key: RISK_RULES_KEY, value: valueJson, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: valueJson, updatedAt: now } });
    return next;
  }

  // ---- 侦测 ----

  private async liveSites(): Promise<SiteRow[]> {
    return this.deps.db.orm.select().from(sites).where(ne(sites.status, 'destroyed'));
  }

  /** 单站两窗口榜单 → 骤增行（引擎不支持 customerRanking 时返回空） */
  private async scanSite(client: EngineAdminClient, rules: RiskRules): Promise<SpikeRow[]> {
    const customerRanking = client.stats.customerRanking;
    if (!customerRanking) return [];
    const today = beijingTodayStr();
    const recentFrom = bjDateAnchor(today);
    const recentTo = bjDateAnchor(today);
    const baseFrom = bjDateAnchor(addDaysStr(today, -rules.baselineDays));
    const baseTo = bjDateAnchor(addDaysStr(today, -1));
    const [recent, baseline] = await Promise.all([
      customerRanking(recentFrom, recentTo, 50),
      customerRanking(baseFrom, baseTo, 50),
    ]);
    return detectSpikes(recent.items, baseline.items, rules);
  }

  /**
   * 侦测所有站骤增。连不上/降级站在 try/catch 内跳过（剔除，不误报）。
   * opts.openAlerts=true 时：有骤增开一条 spend_spike（detail 枚举骤增用户），无骤增则 resolve 既有 open。
   */
  async scan(opts: { openAlerts?: boolean } = {}): Promise<SiteSpikes[]> {
    const rules = await this.readRules();
    const rows = await this.liveSites();
    const results: SiteSpikes[] = [];
    for (const site of rows) {
      const adapter = this.deps.adapters[site.engine as EngineKind];
      if (!adapter) continue;
      let spikes: SpikeRow[];
      try {
        const client = await adapter.connect(instOf(site), this.credstore);
        spikes = await this.scanSite(client, rules);
      } catch (err) {
        // 站点连不上/降级：剔除该站（不误报），不拖垮他站
        console.warn(`[risk] 站点 ${site.slug} 骤增侦测失败:`, redactText(errText(err)));
        continue;
      }
      if (spikes.length > 0) {
        results.push({ siteId: site.id, siteSlug: site.slug, siteLabel: site.label, spikes });
        if (opts.openAlerts) {
          const list = spikes
            .slice(0, 10)
            .map((s) => {
              const who = s.email || `#${s.userId}`;
              const mult = Number.isFinite(s.ratio) ? `${s.ratio.toFixed(1)}x` : '新增';
              return `${who}(${fmtUsd(s.recentCost)} USD, ${mult})`;
            })
            .join(', ');
          await openAlert(this.deps.db, this.deps.notifier, {
            kind: 'spend_spike',
            siteId: site.id,
            severity: 'warning',
            title: `${site.label} 消费骤增`,
            detail: `${spikes.length} 位客户消费骤增: ${list}`,
            site: { slug: site.slug, label: site.label },
          });
        }
      } else if (opts.openAlerts) {
        const open = await findOpenAlert(this.deps.db, 'spend_spike', site.id);
        if (open) await resolveAlert(this.deps.db, this.deps.notifier, open, { slug: site.slug, label: site.label });
      }
    }
    return results;
  }

  // ---- 护栏（限额）----

  private async requireSite(slug: string): Promise<SiteRow> {
    const rows = await this.deps.db.orm
      .select()
      .from(sites)
      .where(and(eq(sites.slug, slug), ne(sites.status, 'destroyed')))
      .limit(1);
    const site = rows[0];
    if (!site) throw new ApiError(404, '站点不存在');
    return site;
  }

  private async connectSite(site: SiteRow): Promise<EngineAdminClient> {
    const adapter = this.deps.adapters[site.engine as EngineKind];
    if (!adapter) throw new ApiError(400, `没有引擎 ${site.engine} 的 adapter`);
    return adapter.connect(instOf(site), this.credstore);
  }

  /** GET-合并预览（不写回）：拉当前全量限额，算合并后的全量输入供 root 确认 */
  async previewQuota(slug: string, userId: string, change: QuotaChange): Promise<QuotaPreview> {
    const site = await this.requireSite(slug);
    const client = await this.connectSite(site);
    const getQuotas = client.users.getPlatformQuotas;
    if (!getQuotas) throw new ApiError(400, '该站引擎不支持平台限额');
    const current = await getQuotas(userId);
    const merged = mergeQuotaInput(current, change);
    return { platform: change.platform, window: change.window, current, merged };
  }

  /**
   * 写回：🔴 仅 config.riskEnforce===true 才执行（否则抛 403）。GET→合并→PUT 全量写回 + openAlert + 审计。
   * readonly 站（dogfood 保险丝）一律拒绝引擎写。
   */
  async enforceQuota(
    ctx: SessionCtx,
    slug: string,
    userId: string,
    change: QuotaChange,
  ): Promise<{ quotas: PlatformQuota[] }> {
    if (!this.deps.config.riskEnforce) {
      throw new ApiError(403, '仅告警模式：限额写回需 RP_RISK_ENFORCE=on');
    }
    const site = await this.requireSite(slug);
    if (site.readonly) throw new ApiError(403, '该站为只读，拒绝限额写回');
    const client = await this.connectSite(site);
    const getQuotas = client.users.getPlatformQuotas;
    const setQuotas = client.users.setPlatformQuotas;
    if (!getQuotas || !setQuotas) throw new ApiError(400, '该站引擎不支持平台限额');
    // 🔴 全量替换：先 GET 合并（保留未涉及 platform 与同 platform 其它窗口）再写回
    const current = await getQuotas(userId);
    const merged = mergeQuotaInput(current, change);
    const quotas = await setQuotas(userId, merged);

    await openAlert(this.deps.db, this.deps.notifier, {
      kind: 'quota_breach',
      siteId: site.id,
      severity: 'info',
      title: `${site.label} 限额触发`,
      detail: `已对用户 #${userId} 的 ${change.platform} ${change.window} 窗口设限额: ${
        change.limitUsd === null ? '不限' : change.limitUsd === 0 ? '禁用' : `${fmtUsd(change.limitUsd)} USD`
      }`,
      site: { slug: site.slug, label: site.label },
    });
    await writeAudit(this.deps.db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'risk.quota.enforce',
      payload: { slug: site.slug, userId, platform: change.platform, window: change.window, limitUsd: change.limitUsd },
      ok: true,
    });
    return { quotas };
  }
}

// ---------------------------------------------------------------------------
// 后台扫描循环（与 startMonitor 完全解耦）
// ---------------------------------------------------------------------------

export interface RiskScan {
  stop(): void;
  /** 单轮扫描（测试可手动驱动；与 interval 并发时内部防重入，不 sleep） */
  tick(): Promise<void>;
}

/**
 * 启动风控骤增扫描。intervalMs>0 起独立 setInterval（unref）+ 重入锁；intervalMs<=0 不起循环
 * （tick 仅手动驱动，如 POST /api/risk/scan）。每轮 scan({openAlerts:true}) 侦测 + 告警，绝不写回引擎。
 */
export function startRiskScan(deps: RiskDeps, intervalMs: number): RiskScan {
  const service = new RiskService(deps);
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await service.scan({ openAlerts: true });
    } catch (err) {
      console.warn('[risk] 骤增扫描失败:', redactText(errText(err)));
    } finally {
      ticking = false;
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void tick().catch((err) => {
        console.warn('[risk] 骤增扫描轮询失败:', redactText(errText(err)));
      });
    }, intervalMs);
    timer.unref();
  }

  return {
    tick,
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
