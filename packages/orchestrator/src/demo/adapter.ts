import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineAdapter,
  EngineAdminClient,
  EngineCapabilities,
  EngineKind,
  GroupRecord,
  GroupSpec,
  HealthReport,
  InstanceInfo,
  SiteBranding,
  SiteUserRecord,
  UsageSummary,
} from '@relay-panel/adapter-core';
import {
  demoBranding,
  demoChannels,
  demoGroups,
  demoUsage,
  demoUsers,
} from './data.js';

/**
 * 演示模式引擎 adapter（安全第一）：
 *  - health() 恒 ok，低延迟随机 8-40ms；
 *  - connect() 不做任何认证/网络，直接返回读罐装数据的 admin client；
 *  - channels/groups/users/settings 按 site slug 确定性生成（见 data.ts），apiKey 恒 '<redacted>'；
 *  - stats.usage 按天生成平滑起伏曲线。
 *
 * 绝不发任何真实外部请求、绝不解析真实凭据（connect 忽略 CredentialStore）。
 * 写操作只落进程内内存 overlay（pglite:memory 重启即净），不触达任何真实引擎。
 */

interface SiteState {
  channels: ChannelRecord[];
  groups: GroupRecord[];
  users: SiteUserRecord[];
  branding: SiteBranding;
  rawSettings: Map<string, string>;
  nextId: number;
}

export class DemoAdapter implements EngineAdapter {
  readonly engine: EngineKind;
  readonly dbDirect = false;
  /** 进程内可变 overlay：首次访问某 slug 时用确定性罐装数据惰性物化，之后读写都走它 */
  private readonly states = new Map<string, SiteState>();

  constructor(engine: EngineKind = 'sub2api') {
    this.engine = engine;
  }

  private stateFor(inst: InstanceInfo): SiteState {
    const slug = inst.siteSlug;
    let s = this.states.get(slug);
    if (!s) {
      const channels = demoChannels(slug);
      const groups = demoGroups(slug);
      const users = demoUsers(slug);
      s = {
        channels,
        groups,
        users,
        branding: demoBranding(slug, siteLabelOf(inst)),
        rawSettings: new Map(),
        nextId: Math.max(channels.length, groups.length, users.length) + 1,
      };
      this.states.set(slug, s);
    }
    return s;
  }

  async capabilities(_inst: InstanceInfo): Promise<EngineCapabilities> {
    return {
      userAccessTokens: true,
      multiGroupKeys: true,
      anthropicNative: this.engine === 'sub2api',
      subscriptionBilling: this.engine === 'sub2api',
    };
  }

  async health(inst: InstanceInfo): Promise<HealthReport> {
    // 低延迟随机 8-40ms，纯展示
    const latencyMs = 8 + Math.floor(Math.random() * 33);
    return { ok: true, httpOk: true, dbOk: true, latencyMs, version: inst.version };
  }

  /** 演示模式忽略凭据：不解析、不网络，直接返回罐装 client */
  async connect(inst: InstanceInfo, _credentials: CredentialStore): Promise<EngineAdminClient> {
    const state = this.stateFor(inst);
    const slug = inst.siteSlug;

    return {
      inst,
      channels: {
        list: async (): Promise<ChannelRecord[]> => state.channels.map((c) => ({ ...c })),
        create: async (spec: ChannelSpec): Promise<ChannelRecord> => {
          const rec: ChannelRecord = {
            ...spec,
            apiKey: '<redacted>' as const,
            id: String(state.nextId++),
            enabled: true,
          };
          state.channels.push(rec);
          return { ...rec };
        },
        update: async (
          id: string,
          patch: Partial<ChannelSpec> & { enabled?: boolean },
        ): Promise<ChannelRecord> => {
          const rec = state.channels.find((c) => c.id === id);
          if (!rec) throw new Error(`channel not found: ${id}`);
          Object.assign(rec, patch, { apiKey: '<redacted>' as const });
          return { ...rec };
        },
        remove: async (id: string): Promise<void> => {
          const idx = state.channels.findIndex((c) => c.id === id);
          if (idx < 0) throw new Error(`channel not found: ${id}`);
          state.channels.splice(idx, 1);
        },
        test: async (id: string, model?: string): Promise<ChannelTestResult> => {
          const rec = state.channels.find((c) => c.id === id);
          if (!rec) return { ok: false, error: `channel not found: ${id}` };
          return {
            ok: true,
            latencyMs: 12 + Math.floor(Math.random() * 40),
            ...(model !== undefined ? { model } : {}),
          };
        },
      },
      groups: {
        list: async (): Promise<GroupRecord[]> => state.groups.map((g) => ({ ...g })),
        create: async (spec: GroupSpec): Promise<GroupRecord> => {
          const rec: GroupRecord = { ...spec, id: String(state.nextId++) };
          state.groups.push(rec);
          return { ...rec };
        },
        update: async (id: string, patch: Partial<GroupSpec>): Promise<GroupRecord> => {
          const rec = state.groups.find((g) => g.id === id);
          if (!rec) throw new Error(`group not found: ${id}`);
          Object.assign(rec, patch);
          return { ...rec };
        },
      },
      users: {
        list: async (query?: { search?: string; page?: number }): Promise<SiteUserRecord[]> => {
          const all = state.users.map((u) => ({ ...u }));
          const q = query?.search?.toLowerCase();
          if (!q) return all;
          return all.filter(
            (u) => u.email?.toLowerCase().includes(q) || u.username?.toLowerCase().includes(q),
          );
        },
        setStatus: async (id: string, status: 'active' | 'disabled'): Promise<void> => {
          const u = state.users.find((x) => x.id === id);
          if (!u) throw new Error(`user not found: ${id}`);
          u.status = status;
        },
      },
      settings: {
        getBranding: async (): Promise<SiteBranding> => ({ ...state.branding }),
        setBranding: async (branding: Partial<SiteBranding>): Promise<void> => {
          Object.assign(state.branding, branding);
        },
        getRaw: async (key: string): Promise<string | null> => state.rawSettings.get(key) ?? null,
        setRaw: async (key: string, value: string): Promise<void> => {
          state.rawSettings.set(key, value);
        },
      },
      stats: {
        usage: async (from: Date, to: Date): Promise<UsageSummary> => demoUsage(slug, from, to),
      },
    };
  }
}

/** InstanceInfo 无 label 字段，用 slug 兜底；实际 siteName 由 seed 的 site.label 决定，此处仅默认展示名 */
function siteLabelOf(inst: InstanceInfo): string {
  return inst.siteSlug;
}
