import { eq } from 'drizzle-orm';
import type { ChannelRecord, ChannelSpec, EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { channelTemplates } from '../db/schema.js';
import type { JobEngine } from '../jobs/engine.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { SitesService, type SiteMeta } from '../sites/service.js';
import { applyGrant } from '../marketplace/grant.js';
import type { GrantInput } from '../marketplace/types.js';
import type { MeteringGateway } from '../server.js';

/**
 * 批量操作服务（panel 核心价值：改一次生效 N 个站）。
 * 一律复用 SitesService / applyGrant 的单站写路径 —— 因此每个站自动继承
 * requireWrite + canAccessSite(404) + readonly 保险丝(403) + 审计。
 * 纪律：任一站失败不影响其它站，返回逐站结果（整体永远 200，partial 是常态）。
 */

export interface BatchServiceDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  lifecycles: Record<EngineKind, EngineLifecycle>;
  jobs: JobEngine;
  gateway: MeteringGateway | null;
}

export interface BatchItemResult {
  slug: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

/**
 * 干跑预览的变更标记：
 * - noop     值未变（相同）—— 真执行不产生任何改动
 * - conflict 同名冲突（如已存在同名渠道，仍会再建一个）
 * - blocked  整站只读（真执行会被 403 拒绝）—— 见 BatchPreviewResult.blocked
 * - miss     按名未匹配到任何渠道 —— 真执行会 404 未命中
 * - skip     不适用（如外部接管站不支持生命周期操作）
 */
export type PreviewFlag = 'noop' | 'conflict' | 'blocked' | 'miss' | 'skip';

/** 单条“将会发生什么”的结构化描述（apiKey 绝不出现在 from/to；轮换只标 field=apiKey） */
export interface PreviewItem {
  /** 变更类别，同 action.kind（announcement / channel.update / lifecycle …） */
  kind: string;
  /** 变更对象：字段名 / 渠道名 / 模板落地渠道名 / 生命周期动作 */
  target: string;
  /** 字段级 diff 的字段名（branding/渠道更新/生命周期用） */
  field?: string;
  /** 当前值（脱敏；渠道 apiKey 永不进此字段） */
  from?: string;
  /** 提议值（脱敏；渠道 apiKey 永不进此字段） */
  to?: string;
  flag?: PreviewFlag;
}

/** 逐站预览结果：沿用逐站结构（slug/ok/error），dryRun 追加 preview 数组与整站 blocked 标记 */
export interface BatchPreviewResult {
  slug: string;
  /** 预览是否成功计算（站不可达 / 读失败为 false，携 error） */
  ok: boolean;
  /** 整站只读：真执行该动作会 403（预览照常计算） */
  blocked?: boolean;
  preview?: PreviewItem[];
  error?: string;
}

export interface ChannelPatch {
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  priority?: number;
  weight?: number;
  enabled?: boolean;
}

export type BatchAction =
  | { kind: 'announcement'; announcement: string }
  | { kind: 'branding'; siteName?: string; logoUrl?: string; announcement?: string }
  | { kind: 'channel.create'; channel: ChannelSpec }
  | { kind: 'channel.toggle'; channelName: string; enabled: boolean }
  | { kind: 'channel.update'; channelName: string; patch: ChannelPatch }
  | { kind: 'channel.delete'; channelName: string }
  | { kind: 'grant'; templateKey: string; channelName?: string; byo?: { baseUrl: string; apiKey: string }; groupIds?: string[]; priority?: number }
  | { kind: 'lifecycle'; op: 'upgrade' | 'start' | 'stop'; toVersion?: string };

/** 单站并发上限：避免同时打太多引擎 admin API */
const CONCURRENCY = 5;

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * 该动作在只读站上真执行是否会被 403 拒绝。
 * 引擎写面（公告/品牌/渠道/市场授权）经 SitesService.adapterWrite / applyGrant 的 readonly 保险丝拦截；
 * 生命周期（升级/启停）走 job 入队路径，不受 readonly 约束 —— 故预览也据实不标 blocked，避免“说A做B”。
 */
function actionBlockedByReadonly(kind: BatchAction['kind']): boolean {
  return kind !== 'lifecycle';
}

/** 字段级 diff：值相同标 noop */
function diffItem(kind: string, target: string, field: string, from: string, to: string): PreviewItem {
  return { kind, target, field, from, to, ...(from === to ? { flag: 'noop' as const } : {}) };
}

export class BatchService {
  private readonly sites: SitesService;

  constructor(private readonly deps: BatchServiceDeps) {
    // SitesService 构造会 registerHandler(Map.set 幂等)，与 registerSitesRoutes 共存无害
    this.sites = new SitesService({
      config: deps.config,
      db: deps.db,
      adapters: deps.adapters,
      lifecycles: deps.lifecycles,
      jobs: deps.jobs,
    });
  }

  /** 逐站执行 action；每站独立 try，失败落 error 字段不抛。返回逐站结果 */
  async run(ctx: SessionCtx, slugs: string[], action: BatchAction): Promise<BatchItemResult[]> {
    // 去重保序
    const seen = new Set<string>();
    const targets = slugs.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
    if (targets.length === 0) throw new ApiError(400, '未选择任何站点');

    return mapPool(targets, CONCURRENCY, async (slug) => {
      try {
        const detail = await this.applyOne(ctx, slug, action);
        return { slug, ok: true, ...(detail !== undefined ? { detail } : {}) };
      } catch (err) {
        // ApiError 的中文消息直接透给用户；其它兜底
        const error = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        return { slug, ok: false, error };
      }
    });
  }

  /**
   * 干跑预览（dryRun）：零引擎写、零 DB 写、不建任务、不落审计 —— 纯读操作，逐站算“将会发生什么”。
   * 并发池 / slug 去重 / 部分失败与 run 一致；站不可达该站落 error 条目，不拖垮其它站。
   */
  async preview(ctx: SessionCtx, slugs: string[], action: BatchAction): Promise<BatchPreviewResult[]> {
    const seen = new Set<string>();
    const targets = slugs.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
    if (targets.length === 0) throw new ApiError(400, '未选择任何站点');

    return mapPool(targets, CONCURRENCY, async (slug) => {
      try {
        // 先取元信息（DB only，404 隔离他人站）；再据实计算变更预览
        const meta = await this.sites.getSiteMeta(ctx, slug);
        const blocked = meta.readonly && actionBlockedByReadonly(action.kind);
        const preview = await this.computePreview(ctx, slug, meta, action);
        return { slug, ok: true, ...(blocked ? { blocked: true } : {}), preview };
      } catch (err) {
        const error = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        return { slug, ok: false, error };
      }
    });
  }

  /**
   * 按名匹配渠道（不抛）：返回全量列表 + 命中项。执行路径与预览路径共用同一匹配语义，
   * 避免“预览命中 A、执行动了 B”的漂移。listChannels 已对 apiKey 强制脱敏。
   */
  private async matchChannels(
    ctx: SessionCtx,
    slug: string,
    name: string,
  ): Promise<{ channels: ChannelRecord[]; matches: ChannelRecord[] }> {
    const channels = await this.sites.listChannels(ctx, slug);
    const matches = channels.filter((c) => c.name === name);
    return { channels, matches };
  }

  /** 按名取渠道（0 个即抛 404，供 toggle/update/delete 执行路径共用） */
  private async channelsByName(ctx: SessionCtx, slug: string, name: string) {
    const { matches } = await this.matchChannels(ctx, slug, name);
    if (matches.length === 0) throw new ApiError(404, `未找到名为「${name}」的渠道`);
    return matches;
  }

  /**
   * 跨站渠道矩阵：行=渠道名，列=站，格=enabled/disabled/absent。
   * 站群漂移可见性核心（谁有/缺某渠道、某 key 还在哪启用着）。
   * 逐站读独立 try，单站不可达只标该站列缺失，不拖垮整表。
   */
  async channelMatrix(ctx: SessionCtx): Promise<{
    sites: Array<{ slug: string; label: string; ok: boolean }>;
    channels: Array<{ name: string; protocol: string; presence: Record<string, 'enabled' | 'disabled' | 'absent'> }>;
  }> {
    const views = await this.sites.listSites(ctx);
    const active = views.filter((s) => s.status !== 'destroyed');
    const perSite = await mapPool(active, CONCURRENCY, async (s) => {
      try {
        const channels = await this.sites.listChannels(ctx, s.slug);
        return { slug: s.slug, ok: true, channels };
      } catch {
        return { slug: s.slug, ok: false, channels: [] as Awaited<ReturnType<SitesService['listChannels']>> };
      }
    });

    const nameKey = (name: string, protocol: string): string => `${name} ${protocol}`;
    const rows = new Map<string, { name: string; protocol: string; presence: Record<string, 'enabled' | 'disabled' | 'absent'> }>();
    const siteMeta = active.map((s, i) => ({ slug: s.slug, label: s.label, ok: perSite[i]!.ok }));

    for (const site of perSite) {
      for (const c of site.channels) {
        const k = nameKey(c.name, c.protocol);
        let row = rows.get(k);
        if (!row) {
          row = { name: c.name, protocol: c.protocol, presence: {} };
          for (const m of siteMeta) row.presence[m.slug] = 'absent';
          rows.set(k, row);
        }
        row.presence[site.slug] = c.enabled ? 'enabled' : 'disabled';
      }
    }
    const channels = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { sites: siteMeta, channels };
  }

  /**
   * 逐站计算“将会发生什么”。读取路径与真实执行贴近（同一 matchChannels / getBranding / 模板加载），
   * 避免预览与执行漂移。渠道 apiKey 绝不出现在 from/to（轮换仅以 field=apiKey 标注）。
   */
  private async computePreview(
    ctx: SessionCtx,
    slug: string,
    meta: SiteMeta,
    action: BatchAction,
  ): Promise<PreviewItem[]> {
    switch (action.kind) {
      case 'announcement': {
        const cur = await this.sites.getBranding(ctx, slug);
        return [diffItem('announcement', 'announcement', 'announcement', cur.announcement ?? '', action.announcement)];
      }
      case 'branding': {
        const cur = await this.sites.getBranding(ctx, slug);
        const items: PreviewItem[] = [];
        if (action.siteName !== undefined)
          items.push(diffItem('branding', 'branding', 'siteName', cur.siteName ?? '', action.siteName));
        if (action.logoUrl !== undefined)
          items.push(diffItem('branding', 'branding', 'logoUrl', cur.logoUrl ?? '', action.logoUrl));
        if (action.announcement !== undefined)
          items.push(diffItem('branding', 'branding', 'announcement', cur.announcement ?? '', action.announcement));
        return items;
      }
      case 'channel.create': {
        const { channels } = await this.matchChannels(ctx, slug, action.channel.name);
        const exists = channels.some((c) => c.name === action.channel.name);
        return [
          {
            kind: 'channel.create',
            target: action.channel.name,
            field: 'create',
            to: `${action.channel.protocol} · ${action.channel.models.join(', ')}`,
            ...(exists ? { flag: 'conflict' as const } : {}),
          },
        ];
      }
      case 'channel.toggle': {
        const { matches } = await this.matchChannels(ctx, slug, action.channelName);
        if (matches.length === 0) return [{ kind: 'channel.toggle', target: action.channelName, flag: 'miss' }];
        const to = action.enabled ? 'enabled' : 'disabled';
        return matches.map((c) =>
          diffItem('channel.toggle', action.channelName, 'enabled', c.enabled ? 'enabled' : 'disabled', to),
        );
      }
      case 'channel.update': {
        const { matches } = await this.matchChannels(ctx, slug, action.channelName);
        if (matches.length === 0) return [{ kind: 'channel.update', target: action.channelName, flag: 'miss' }];
        const p = action.patch;
        const items: PreviewItem[] = [];
        for (const c of matches) {
          if (p.baseUrl !== undefined)
            items.push(diffItem('channel.update', action.channelName, 'baseUrl', c.baseUrl, p.baseUrl));
          if (p.apiKey !== undefined)
            // 绝不回显任何 key（现值已脱敏、新值不落响应）—— 仅以 field=apiKey 标注“将轮换”
            items.push({ kind: 'channel.update', target: action.channelName, field: 'apiKey' });
          if (p.models !== undefined)
            items.push(diffItem('channel.update', action.channelName, 'models', c.models.join(', '), p.models.join(', ')));
          if (p.priority !== undefined)
            items.push(diffItem('channel.update', action.channelName, 'priority', String(c.priority ?? ''), String(p.priority)));
          if (p.weight !== undefined)
            items.push(diffItem('channel.update', action.channelName, 'weight', String(c.weight ?? ''), String(p.weight)));
          if (p.enabled !== undefined)
            items.push(diffItem('channel.update', action.channelName, 'enabled', c.enabled ? 'enabled' : 'disabled', p.enabled ? 'enabled' : 'disabled'));
        }
        return items;
      }
      case 'channel.delete': {
        const { matches } = await this.matchChannels(ctx, slug, action.channelName);
        if (matches.length === 0) return [{ kind: 'channel.delete', target: action.channelName, flag: 'miss' }];
        return matches.map((c) => ({
          kind: 'channel.delete',
          target: action.channelName,
          field: 'delete',
          from: `${c.protocol} · ${c.models.join(', ')}`,
        }));
      }
      case 'grant': {
        // 模板校验与执行路径一致（存在/启用/source 与入参匹配）；readonly 由 blocked 标记表达
        const rows = await this.deps.db.orm
          .select()
          .from(channelTemplates)
          .where(eq(channelTemplates.key, action.templateKey))
          .limit(1);
        const tpl = rows[0];
        if (!tpl) throw new ApiError(404, '模板不存在');
        if (!tpl.enabled) throw new ApiError(400, '模板已停用');
        if (tpl.source === 'byo' && !action.byo) throw new ApiError(400, 'byo 模板需提供自带上游的 baseUrl 与 apiKey');
        if (tpl.source === 'managed' && action.byo)
          throw new ApiError(400, 'managed 模板由计量网关签发接入参数，不接受自带上游参数');
        // 与执行路径(applyGrant)一致：managed 模板未配计量网关，预览也报同样的 400，避免"预览说能建、执行 400"
        if (tpl.source === 'managed' && this.deps.gateway === null) throw new ApiError(400, '计量网关未配置');
        const name = action.channelName ?? tpl.title;
        const { channels } = await this.matchChannels(ctx, slug, name);
        const exists = channels.some((c) => c.name === name);
        return [
          {
            kind: 'grant',
            target: name,
            field: 'create',
            to: `${tpl.protocol} · ${tpl.models.join(', ')}`,
            ...(exists ? { flag: 'conflict' as const } : {}),
          },
        ];
      }
      case 'lifecycle': {
        const target = action.op;
        // 外部接管站与已销毁站：生命周期不适用，标 skip（真执行 400）
        if (meta.managed !== 'compose' || meta.status === 'destroyed')
          return [{ kind: 'lifecycle', target, flag: 'skip' }];
        if (action.op === 'upgrade') {
          if (!action.toVersion) throw new ApiError(400, '升级需要指定目标版本');
          return [diffItem('lifecycle', target, 'version', meta.version, action.toVersion)];
        }
        const to = action.op === 'start' ? 'active' : 'stopped';
        return [diffItem('lifecycle', target, 'status', meta.status, to)];
      }
    }
  }

  private async applyOne(ctx: SessionCtx, slug: string, action: BatchAction): Promise<string | undefined> {
    switch (action.kind) {
      case 'announcement':
        await this.sites.setBranding(ctx, slug, { announcement: action.announcement });
        return undefined;
      case 'branding': {
        const patch: Record<string, string> = {};
        if (action.siteName !== undefined) patch.siteName = action.siteName;
        if (action.logoUrl !== undefined) patch.logoUrl = action.logoUrl;
        if (action.announcement !== undefined) patch.announcement = action.announcement;
        await this.sites.setBranding(ctx, slug, patch);
        return undefined;
      }
      case 'channel.create': {
        const rec = await this.sites.createChannel(ctx, slug, action.channel);
        return `渠道已创建 (id=${rec.id})`;
      }
      case 'channel.toggle': {
        const matches = await this.channelsByName(ctx, slug, action.channelName);
        for (const c of matches) {
          await this.sites.updateChannel(ctx, slug, c.id, { enabled: action.enabled });
        }
        return `${matches.length} 个渠道已${action.enabled ? '启用' : '停用'}`;
      }
      case 'channel.update': {
        const matches = await this.channelsByName(ctx, slug, action.channelName);
        for (const c of matches) {
          await this.sites.updateChannel(ctx, slug, c.id, action.patch);
        }
        return `${matches.length} 个渠道已更新`;
      }
      case 'channel.delete': {
        const matches = await this.channelsByName(ctx, slug, action.channelName);
        for (const c of matches) {
          await this.sites.deleteChannel(ctx, slug, c.id);
        }
        return `${matches.length} 个渠道已删除`;
      }
      case 'lifecycle': {
        if (action.op === 'upgrade') {
          if (!action.toVersion) throw new ApiError(400, '升级需要指定目标版本');
          const { jobId } = await this.sites.upgradeSite(ctx, slug, action.toVersion);
          return `升级任务已入队 (jobId=${jobId})`;
        }
        if (action.op === 'start') {
          const { jobId } = await this.sites.startSite(ctx, slug);
          return `启动任务已入队 (jobId=${jobId})`;
        }
        const { jobId } = await this.sites.stopSite(ctx, slug);
        return `停止任务已入队 (jobId=${jobId})`;
      }
      case 'grant': {
        const input: GrantInput = {
          siteSlug: slug,
          templateKey: action.templateKey,
          ...(action.channelName !== undefined ? { channelName: action.channelName } : {}),
          ...(action.byo !== undefined ? { byo: action.byo } : {}),
          ...(action.groupIds !== undefined ? { groupIds: action.groupIds } : {}),
          ...(action.priority !== undefined ? { priority: action.priority } : {}),
        };
        const grant = await applyGrant(
          { config: this.deps.config, db: this.deps.db, adapters: this.deps.adapters, gateway: this.deps.gateway },
          ctx,
          input,
        );
        return `渠道已注入 (engineChannelId=${grant.engineChannelId})`;
      }
    }
  }
}
