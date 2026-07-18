import type { ChannelSpec, EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { JobEngine } from '../jobs/engine.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { SitesService } from '../sites/service.js';
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

export type BatchAction =
  | { kind: 'announcement'; announcement: string }
  | { kind: 'branding'; siteName?: string; logoUrl?: string; announcement?: string }
  | { kind: 'channel.create'; channel: ChannelSpec }
  | { kind: 'channel.toggle'; channelName: string; enabled: boolean }
  | { kind: 'grant'; templateKey: string; channelName?: string; byo?: { baseUrl: string; apiKey: string }; groupIds?: string[]; priority?: number };

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
        const channels = await this.sites.listChannels(ctx, slug);
        const matches = channels.filter((c) => c.name === action.channelName);
        if (matches.length === 0) throw new ApiError(404, `未找到名为「${action.channelName}」的渠道`);
        for (const c of matches) {
          await this.sites.updateChannel(ctx, slug, c.id, { enabled: action.enabled });
        }
        return `${matches.length} 个渠道已${action.enabled ? '启用' : '停用'}`;
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
