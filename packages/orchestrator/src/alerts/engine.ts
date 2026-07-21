import { and, eq, isNull, ne } from 'drizzle-orm';
import type {
  ChannelBalance,
  ChannelRecord,
  EngineAdapter,
  EngineAdminClient,
  EngineKind,
  InstanceInfo,
} from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { alerts, sites, type AlertRow, type JobRow, type SiteRow } from '../db/schema.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import { redactText, type JobEngine } from '../jobs/engine.js';
import { evaluateChannelLowBalance } from '../upstream/service.js';
import type { Notifier } from './notify.js';

/**
 * 告警引擎（规格 §8）：监控循环 + 四类规则（site_down/job_failed/channel_disabled/low_balance）。
 * 探测直调 adapter（不走站点快照缓存）；内部状态（健康 streak、渠道基线、轮计数）
 * 全部在闭包内存——进程重启即清零：streak 重新累计、渠道基线重建（首轮不告警）。
 * open 去重语义：同 (kind, site_id) 最多一条 open，重复触发只刷 last_seen_at/detail、不重复通知。
 */

export type AlertKind =
  | 'site_down'
  | 'job_failed'
  | 'channel_disabled'
  | 'low_balance'
  | 'margin_low'
  | 'cost_spike'
  | 'spend_spike'
  | 'quota_breach'
  | 'customer_churn'
  | 'channel_low_balance';
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** 通知事件里携带的站点摘要——只给 slug/label，绝不带凭据/端口拓扑之外的运维细节 */
export interface AlertSiteRef {
  slug: string;
  label: string;
}

export interface MonitorDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  notifier: Notifier;
  /** 传入则由 startMonitor 挂载 onFinish 出 job_failed 告警（成功不出、失败不自动 resolve） */
  jobs?: JobEngine;
}

export interface Monitor {
  stop(): void;
  /** 单轮探测；测试可同步驱动（与 interval 并发时内部防重入，不 sleep） */
  tick(): Promise<void>;
}

/** site_down 连续失败阈值 */
const SITE_DOWN_STREAK = 3;
/** channels.list 巡检周期（每 N 轮一次，第 1 轮即首查建基线） */
const CHANNEL_ROUND_EVERY = 5;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 通知失败绝不反噬监控循环/路由（WebhookNotifier 自身不抛，此处双保险） */
async function fireSafe(
  notifier: Notifier,
  event: { type: 'open' | 'resolve'; alert: AlertRow; site?: AlertSiteRef },
): Promise<void> {
  try {
    await notifier.fire({
      type: event.type,
      alert: event.alert,
      ...(event.site !== undefined ? { site: event.site } : {}),
    });
  } catch (err) {
    console.warn('[alerts] 通知回调失败:', redactText(errText(err)));
  }
}

/** 查同 (kind, siteId) 的 open 告警（siteId null 用 IS NULL 匹配） */
export async function findOpenAlert(
  db: Db,
  kind: AlertKind,
  siteId: number | null,
): Promise<AlertRow | undefined> {
  const rows = await db.orm
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.kind, kind),
        eq(alerts.status, 'open'),
        siteId === null ? isNull(alerts.siteId) : eq(alerts.siteId, siteId),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface OpenAlertInput {
  kind: AlertKind;
  siteId: number | null;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  site?: AlertSiteRef;
}

/**
 * 开告警（带去重）：已有同 (kind, siteId) 的 open → 只更新 last_seen_at/detail、不重复通知；
 * 否则插入新行并 fire open 事件。detail 入库前过 redactText（detail 常来自上游错误文本）。
 */
export async function openAlert(db: Db, notifier: Notifier, input: OpenAlertInput): Promise<AlertRow> {
  const now = toPgTimestamp(new Date());
  const detail = input.detail !== undefined ? redactText(input.detail) : undefined;

  const existing = await findOpenAlert(db, input.kind, input.siteId);
  if (existing) {
    const updated = (
      await db.orm
        .update(alerts)
        .set({ lastSeenAt: now, ...(detail !== undefined ? { detail } : {}) })
        .where(and(eq(alerts.id, existing.id), eq(alerts.status, 'open')))
        .returning()
    )[0];
    return updated ?? existing;
  }

  const inserted = (
    await db.orm
      .insert(alerts)
      .values({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        status: 'open',
        firstSeenAt: now,
        lastSeenAt: now,
        ...(input.siteId !== null ? { siteId: input.siteId } : {}),
        ...(detail !== undefined ? { detail } : {}),
      })
      .returning()
  )[0]!;
  await fireSafe(notifier, {
    type: 'open',
    alert: inserted,
    ...(input.site !== undefined ? { site: input.site } : {}),
  });
  return inserted;
}

/**
 * 解决告警（引擎自动恢复与路由手动 resolve 共用）：只对仍是 open 的行生效，
 * 成功后 fire resolve 事件；已被并发处理时返回 null 且不通知。
 */
export async function resolveAlert(
  db: Db,
  notifier: Notifier,
  alert: Pick<AlertRow, 'id'>,
  site?: AlertSiteRef,
): Promise<AlertRow | null> {
  const now = toPgTimestamp(new Date());
  const updated = (
    await db.orm
      .update(alerts)
      .set({ status: 'resolved', resolvedAt: now, lastSeenAt: now })
      .where(and(eq(alerts.id, alert.id), eq(alerts.status, 'open')))
      .returning()
  )[0];
  if (!updated) return null;
  await fireSafe(notifier, {
    type: 'resolve',
    alert: updated,
    ...(site !== undefined ? { site } : {}),
  });
  return updated;
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

/**
 * 启动监控。intervalMs > 0 时起轮询定时器（unref，不阻止进程退出）；
 * intervalMs <= 0 时不起定时器，tick 只能手动驱动（测试/关闭巡检场景）——
 * 但只要传入 deps.jobs，job_failed 告警始终生效（onFinish 与轮询相互独立）。
 */
export function startMonitor(deps: MonitorDeps, intervalMs: number): Monitor {
  const { config, db, notifier } = deps;
  const credentials = makeCredentialStoreV2(db, config);

  // ---- 闭包内存状态 ----
  /** siteId → 连续健康检查失败次数 */
  const healthStreak = new Map<number, number>();
  /** siteId → 上一次渠道巡检快照（channelId → {name, enabled}）；无快照=尚未建基线 */
  const channelBaseline = new Map<number, Map<string, { name: string; enabled: boolean }>>();
  /** siteId → 已进入告警的 enabled→disabled 渠道（channelId → name） */
  const flaggedDisabled = new Map<number, Map<string, string>>();
  let round = 0;
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function siteRefById(siteId: number): Promise<AlertSiteRef | undefined> {
    const rows = await db.orm
      .select({ slug: sites.slug, label: sites.label })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    return rows[0];
  }

  // ---- job_failed：由 JobEngine 终态回调触发；不自动 resolve ----
  async function handleJobFinish(job: JobRow): Promise<void> {
    if (job.status !== 'failed') return;
    const site = job.siteId !== null ? await siteRefById(job.siteId) : undefined;
    await openAlert(db, notifier, {
      kind: 'job_failed',
      siteId: job.siteId,
      severity: 'warning',
      title: `${job.kind} 任务失败`,
      detail: `站点 ${job.slug}${job.error ? `: ${job.error}` : ''}`,
      ...(site !== undefined ? { site } : {}),
    });
  }
  if (deps.jobs) {
    deps.jobs.onFinish = handleJobFinish;
  }

  // ---- channel_disabled：对比上轮 enabled 集合，只告"转变"；首轮建基线不告警 ----
  async function checkChannelDisabled(site: SiteRow, siteRef: AlertSiteRef, channels: ChannelRecord[]): Promise<void> {
    const prev = channelBaseline.get(site.id);
    const nowMap = new Map(channels.map((c) => [c.id, { name: c.name, enabled: c.enabled }]));
    channelBaseline.set(site.id, nowMap);
    if (!prev) return;

    const flagged = flaggedDisabled.get(site.id) ?? new Map<string, string>();
    for (const [id, cur] of nowMap) {
      const before = prev.get(id);
      if (before?.enabled === true && !cur.enabled) flagged.set(id, cur.name);
    }
    // 恢复 enabled 或渠道已删除 → 摘除
    for (const id of [...flagged.keys()]) {
      const cur = nowMap.get(id);
      if (!cur || cur.enabled) flagged.delete(id);
    }
    flaggedDisabled.set(site.id, flagged);

    if (flagged.size > 0) {
      await openAlert(db, notifier, {
        kind: 'channel_disabled',
        siteId: site.id,
        severity: 'warning',
        title: '渠道被禁用',
        detail: `渠道被禁用: ${[...flagged.values()].join(', ')}`,
        site: siteRef,
      });
    } else {
      const open = await findOpenAlert(db, 'channel_disabled', site.id);
      if (open) await resolveAlert(db, notifier, open, siteRef);
    }
  }

  // ---- low_balance：best-effort 读 channel raw 的 balance/quota number 字段，读不到就跳过 ----
  async function checkLowBalance(site: SiteRow, siteRef: AlertSiteRef, channels: ChannelRecord[]): Promise<void> {
    const low: string[] = [];
    for (const c of channels) {
      const raw = c.raw;
      if (raw === undefined) continue;
      const value =
        typeof raw['balance'] === 'number'
          ? raw['balance']
          : typeof raw['quota'] === 'number'
            ? raw['quota']
            : null;
      if (value !== null && value < config.balanceThreshold) low.push(`${c.name}(${value})`);
    }
    if (low.length > 0) {
      await openAlert(db, notifier, {
        kind: 'low_balance',
        siteId: site.id,
        severity: 'warning',
        title: '渠道余额不足',
        detail: `低于阈值 ${config.balanceThreshold}: ${low.join(', ')}`,
        site: siteRef,
      });
    } else {
      const open = await findOpenAlert(db, 'low_balance', site.id);
      if (open) await resolveAlert(db, notifier, open, siteRef);
    }
  }

  // ---- channel_low_balance（F5）：仅对 kind='quota'(apikey/bedrock 真实额度) remaining<阈值命中；
  //      window/none(OAuth/号池零覆盖) 永不误报。引擎无 channelBalances 能力即跳过。默认阈值 0 时本函数不被调用。 ----
  async function checkChannelLowBalance(
    site: SiteRow,
    siteRef: AlertSiteRef,
    client: EngineAdminClient,
  ): Promise<void> {
    const fn = client.stats.channelBalances;
    if (!fn) return; // 引擎不支持余额口径（newapi）：跳过
    let balances: ChannelBalance[];
    try {
      balances = await fn();
    } catch (err) {
      console.warn(`[alerts] 站点 ${site.slug} 渠道额度巡检失败:`, redactText(errText(err)));
      return;
    }
    const low = evaluateChannelLowBalance(balances, config.channelBalanceThreshold);
    if (low.length > 0) {
      const detail = low
        .map((b) => `${b.name}(${((b.quotaLimit ?? 0) - (b.quotaUsed ?? 0)).toFixed(2)} USD)`)
        .join(', ');
      await openAlert(db, notifier, {
        kind: 'channel_low_balance',
        siteId: site.id,
        severity: 'warning',
        title: '渠道额度不足',
        detail: `低于阈值 ${config.channelBalanceThreshold} USD: ${detail}`,
        site: siteRef,
      });
    } else {
      const open = await findOpenAlert(db, 'channel_low_balance', site.id);
      if (open) await resolveAlert(db, notifier, open, siteRef);
    }
  }

  async function probeSite(site: SiteRow, channelRound: boolean): Promise<void> {
    const adapter = deps.adapters[site.engine as EngineKind];
    if (!adapter) return;
    const inst = instOf(site);
    const siteRef: AlertSiteRef = { slug: site.slug, label: site.label };

    // ---- site_down：直调 health（不走快照缓存），连续 3 次 fail 才 open ----
    let healthy = false;
    let detail: string | undefined;
    try {
      const report = await adapter.health(inst);
      healthy = report.ok;
      if (!report.ok && report.detail !== undefined) detail = report.detail;
    } catch (err) {
      healthy = false;
      detail = errText(err);
    }

    if (!healthy) {
      const streak = (healthStreak.get(site.id) ?? 0) + 1;
      healthStreak.set(site.id, streak);
      if (streak >= SITE_DOWN_STREAK) {
        await openAlert(db, notifier, {
          kind: 'site_down',
          siteId: site.id,
          severity: 'critical',
          title: '站点不可达',
          detail: `连续 ${streak} 次健康检查失败${detail !== undefined ? `: ${detail}` : ''}`,
          site: siteRef,
        });
      }
    } else {
      healthStreak.set(site.id, 0);
      const open = await findOpenAlert(db, 'site_down', site.id);
      if (open) await resolveAlert(db, notifier, open, siteRef);
    }

    if (!channelRound) return;
    // 站点不可达时跳过渠道巡检（必然失败，避免噪音；不动已建基线）
    if (!healthy) return;

    let channels: ChannelRecord[];
    let client: EngineAdminClient;
    try {
      client = await adapter.connect(inst, credentials);
      channels = await client.channels.list();
    } catch (err) {
      console.warn(`[alerts] 站点 ${site.slug} 渠道巡检失败:`, redactText(errText(err)));
      return;
    }

    await checkChannelDisabled(site, siteRef, channels);
    if (config.balanceThreshold > 0) await checkLowBalance(site, siteRef, channels);
    // F5：渠道额度不足（复用已构造的 client；默认阈值 0 时不触发，主循环行为零变化）
    if (config.channelBalanceThreshold > 0) await checkChannelLowBalance(site, siteRef, client);
  }

  async function tick(): Promise<void> {
    if (ticking) return; // interval 与手动 tick 并发时只跑一轮
    ticking = true;
    try {
      round++;
      const channelRound = (round - 1) % CHANNEL_ROUND_EVERY === 0;
      const rows = await db.orm.select().from(sites).where(ne(sites.status, 'destroyed'));
      const liveIds = new Set(rows.map((r) => r.id));
      for (const site of rows) {
        try {
          await probeSite(site, channelRound);
        } catch (err) {
          // 单站探测失败不拖垮整轮
          console.warn(`[alerts] 巡检站点 ${site.slug} 异常:`, redactText(errText(err)));
        }
      }
      // 已销毁的站清理内存状态，避免 Map 无限增长
      for (const id of [...healthStreak.keys()]) if (!liveIds.has(id)) healthStreak.delete(id);
      for (const id of [...channelBaseline.keys()]) if (!liveIds.has(id)) channelBaseline.delete(id);
      for (const id of [...flaggedDisabled.keys()]) if (!liveIds.has(id)) flaggedDisabled.delete(id);
    } finally {
      ticking = false;
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void tick().catch((err) => {
        console.warn('[alerts] 巡检轮询失败:', redactText(errText(err)));
      });
    }, intervalMs);
    timer.unref(); // 空闲时不阻止进程退出
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
