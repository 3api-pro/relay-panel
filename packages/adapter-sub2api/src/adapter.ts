import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineAdapter,
  EngineAdminClient,
  EngineCapabilities,
  GroupRecord,
  GroupSpec,
  HealthReport,
  InstanceInfo,
  SiteBranding,
  SiteUserRecord,
  UsageSummary,
  ModelUsageStat,
  CustomerUsageStat,
  CustomerRanking,
  AccountUsageStat,
  RechargeSummary,
} from '@relay-panel/adapter-core';
import { Sub2apiHttp, type PaginatedData } from './http.js';
import { ensureCompliance, loginAdmin } from './auth.js';

/**
 * 概念映射（sub2api 语义与 adapter-core 抽象的对应）：
 * - adapter-core 的 Channel（上游接入）→ sub2api 的 account（上游凭证）+ group 挂载
 *   （sub2api 自己的 "channel" 是计费/展示概念，不在此映射内，经 raw 透传可用）
 * - adapter-core 的 Group → sub2api 的 group（含倍率 rate_multiplier）
 */

interface S2ARawAccount {
  id: number;
  name: string;
  platform: string;
  type: string;
  status: string;
  priority?: number;
  group_ids?: number[];
  credentials?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

interface S2ARawGroup {
  id: number;
  name: string;
  description?: string;
  rate_multiplier: number;
  platform?: string;
}

interface S2ARawUser {
  id: number;
  email?: string;
  username?: string;
  role: string;
  balance?: number;
  status: string;
}

const PROTOCOL_TO_PLATFORM: Record<ChannelSpec['protocol'], string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-responses': 'openai',
  gemini: 'gemini',
};

function accountToChannelRecord(a: S2ARawAccount): ChannelRecord {
  return {
    id: String(a.id),
    name: a.name,
    enabled: a.status === 'active',
    protocol: (a.platform === 'openai' ? 'openai' : a.platform) as ChannelRecord['protocol'],
    baseUrl: typeof a.credentials?.base_url === 'string' ? (a.credentials.base_url as string) : '',
    apiKey: '<redacted>',
    models: [],
    groups: (a.group_ids ?? []).map(String),
    ...(a.priority !== undefined ? { priority: a.priority } : {}),
    raw: { type: a.type, extra: a.extra ?? {} },
  };
}

export class Sub2apiAdapter implements EngineAdapter {
  readonly engine = 'sub2api' as const;
  readonly dbDirect = false;

  async capabilities(_inst: InstanceInfo): Promise<EngineCapabilities> {
    return {
      userAccessTokens: true, // >= 0.1.158
      multiGroupKeys: false, // 二开特性，官方版无
      anthropicNative: true,
      subscriptionBilling: true,
    };
  }

  async health(inst: InstanceInfo): Promise<HealthReport> {
    const started = Date.now();
    try {
      const res = await fetch(`${inst.baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
      return { ok: res.ok, httpOk: res.ok, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, httpOk: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async connect(inst: InstanceInfo, credentials: CredentialStore): Promise<EngineAdminClient> {
    const cred = await credentials.resolve(inst.credentialRef);
    let auth: { kind: 'api-key'; key: string } | { kind: 'bearer'; token: string };
    if (cred.kind === 'admin-token') {
      // 长期 admin-api-key（推荐的生产凭据），直接用，不触碰站点状态。
      auth = { kind: 'api-key', key: cred.secret };
    } else if (cred.kind === 'admin-password') {
      // 非破坏性：登录换 JWT 直接做 bearer，**不** regenerate 站点的 admin-api-key
      // （regenerate 会作废既有 key，重复 connect 自相踩踏）。
      // 需要长期 key 时用独立的一次性引导（bootstrapAdminApiKey），不在 connect 里做。
      if (!cred.adminEmail) throw new Error('admin-password credential requires adminEmail');
      const token = await loginAdmin(inst.baseUrl, cred.adminEmail, cred.secret);
      const http0 = new Sub2apiHttp(inst.baseUrl, { kind: 'bearer', token });
      await ensureCompliance(http0);
      auth = { kind: 'bearer', token };
    } else {
      throw new Error(`unsupported credential kind for sub2api: ${cred.kind}`);
    }
    return new Sub2apiAdminClient(inst, new Sub2apiHttp(inst.baseUrl, auth));
  }
}

export class Sub2apiAdminClient implements EngineAdminClient {
  constructor(
    readonly inst: InstanceInfo,
    private readonly http: Sub2apiHttp,
  ) {}

  channels = {
    list: async (): Promise<ChannelRecord[]> => {
      const accounts = await this.http.listAll<S2ARawAccount>('/api/v1/admin/accounts');
      return accounts.map(accountToChannelRecord);
    },

    create: async (spec: ChannelSpec): Promise<ChannelRecord> => {
      const groupIds = (spec.groups ?? []).map(Number).filter((n) => Number.isFinite(n));
      const body = {
        name: spec.name,
        platform: PROTOCOL_TO_PLATFORM[spec.protocol],
        type: (spec.raw?.type as string) ?? 'apikey',
        credentials: { api_key: spec.apiKey, base_url: spec.baseUrl },
        priority: spec.priority ?? 0,
        group_ids: groupIds,
        // openai 相对上游默认探测 /v1/responses；中转上游大多不支持，显式关闭（7/16 事故教训）
        extra: {
          ...(spec.protocol === 'openai' ? { openai_responses_supported: false } : {}),
          ...(spec.modelMapping ? { model_mapping: spec.modelMapping } : {}),
          ...((spec.raw?.extra as Record<string, unknown>) ?? {}),
        },
      };
      const created = await this.http.post<S2ARawAccount>('/api/v1/admin/accounts', body);
      // create 响应不回显 group_ids（服务端已持久化，实测确认）——回读拿权威记录
      const fresh = await this.http.get<S2ARawAccount>(`/api/v1/admin/accounts/${created.id}`);
      return accountToChannelRecord(fresh);
    },

    update: async (
      id: string,
      patch: Partial<ChannelSpec> & { enabled?: boolean },
    ): Promise<ChannelRecord> => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.priority !== undefined) body.priority = patch.priority;
      if (patch.groups !== undefined) body.group_ids = patch.groups.map(Number);
      if (patch.enabled !== undefined) body.status = patch.enabled ? 'active' : 'inactive';
      if (patch.apiKey !== undefined || patch.baseUrl !== undefined) {
        // sub2api PUT accounts 带 credentials 必须全量（部分更新会清 base_url —— 7/15 事故教训）
        if (patch.apiKey === undefined || patch.baseUrl === undefined) {
          throw new Error('sub2api requires full credentials on update: pass both apiKey and baseUrl');
        }
        body.credentials = { api_key: patch.apiKey, base_url: patch.baseUrl };
      }
      const updated = await this.http.put<S2ARawAccount>(`/api/v1/admin/accounts/${id}`, body);
      return accountToChannelRecord(updated);
    },

    remove: async (id: string): Promise<void> => {
      await this.http.delete(`/api/v1/admin/accounts/${id}`);
    },

    test: async (id: string, model?: string): Promise<ChannelTestResult> => {
      const started = Date.now();
      try {
        await this.http.post(`/api/v1/admin/accounts/${id}/test`, {
          model_id: model ?? '',
          mode: 'simple',
        });
        return { ok: true, latencyMs: Date.now() - started, ...(model ? { model } : {}) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  groups = {
    list: async (): Promise<GroupRecord[]> => {
      const groups = await this.http.listAll<S2ARawGroup>('/api/v1/admin/groups');
      return groups.map((g) => ({
        id: String(g.id),
        name: g.name,
        ratio: g.rate_multiplier,
        ...(g.description ? { description: g.description } : {}),
        raw: { platform: g.platform },
      }));
    },

    create: async (spec: GroupSpec): Promise<GroupRecord> => {
      const created = await this.http.post<S2ARawGroup>('/api/v1/admin/groups', {
        name: spec.name,
        description: spec.description ?? '',
        rate_multiplier: spec.ratio,
        ...(spec.raw ?? {}),
      });
      return { id: String(created.id), name: created.name, ratio: created.rate_multiplier };
    },

    update: async (id: string, patch: Partial<GroupSpec>): Promise<GroupRecord> => {
      const body: Record<string, unknown> = { ...(patch.raw ?? {}) };
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.description !== undefined) body.description = patch.description;
      if (patch.ratio !== undefined) body.rate_multiplier = patch.ratio;
      const updated = await this.http.put<S2ARawGroup>(`/api/v1/admin/groups/${id}`, body);
      return { id: String(updated.id), name: updated.name, ratio: updated.rate_multiplier };
    },
  };

  users = {
    list: async (query?: { search?: string; page?: number }): Promise<SiteUserRecord[]> => {
      const params = new URLSearchParams();
      if (query?.search) params.set('search', query.search);
      params.set('page', String(query?.page ?? 1));
      params.set('page_size', '100');
      const data = await this.http.get<PaginatedData<S2ARawUser>>(
        `/api/v1/admin/users?${params.toString()}`,
      );
      return data.items.map((u) => ({
        id: String(u.id),
        role: u.role === 'admin' ? 'admin' : 'user',
        status: u.status === 'active' ? 'active' : 'disabled',
        ...(u.email ? { email: u.email } : {}),
        ...(u.username ? { username: u.username } : {}),
        ...(u.balance !== undefined ? { balance: Number(u.balance) } : {}),
      }));
    },

    setStatus: async (id: string, status: 'active' | 'disabled'): Promise<void> => {
      await this.http.put(`/api/v1/admin/users/${id}`, { status });
    },
  };

  settings = {
    getBranding: async (): Promise<SiteBranding> => {
      const all = await this.http.get<Record<string, unknown>>('/api/v1/admin/settings');
      return {
        siteName: typeof all.site_name === 'string' ? all.site_name : '',
        ...(typeof all.site_logo === 'string' && all.site_logo ? { logoUrl: all.site_logo } : {}),
      };
    },

    // ⚠️ PUT /admin/settings 是整体替换（缺省字段以零值写回），必须读-合并-全量写回。
    // GET 不回显秘密（只回 *_configured 布尔），PUT 空秘密字段=保留旧值 —— 该往返是安全的（与官方前端同模式）。
    setBranding: async (branding: Partial<SiteBranding>): Promise<void> => {
      const all = await this.http.get<Record<string, unknown>>('/api/v1/admin/settings');
      if (branding.siteName !== undefined) all.site_name = branding.siteName;
      if (branding.logoUrl !== undefined) all.site_logo = branding.logoUrl;
      await this.http.put('/api/v1/admin/settings', all);
    },

    getRaw: async (key: string): Promise<string | null> => {
      const all = await this.http.get<Record<string, unknown>>('/api/v1/admin/settings');
      const v = all[key];
      return v === undefined || v === null ? null : String(v);
    },

    setRaw: async (key: string, value: string): Promise<void> => {
      const all = await this.http.get<Record<string, unknown>>('/api/v1/admin/settings');
      all[key] = value;
      await this.http.put('/api/v1/admin/settings', all);
    },
  };

  stats = {
    usage: async (from: Date, to: Date): Promise<UsageSummary> => {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const s = await this.http.get<{
        total_requests: number;
        total_input_tokens: number;
        total_output_tokens: number;
        /** 标准计费（1 倍标价，参考口径，非真实营收） */
        total_cost: number;
        /** 实际扣费=客户钱包真实扣走（含分组倍率）=消费流水=真实营收口径 */
        total_actual_cost?: number;
        /** 上游账户实际成本（真实 COGS）；sub2api 在 usage/stats 直接给出 */
        total_account_cost?: number;
        by_model?: unknown;
      }>(
        `/api/v1/admin/usage/stats?start_date=${fmt(from)}&end_date=${fmt(to)}&timezone=Asia/Shanghai`,
      );
      return {
        from,
        to,
        requests: s.total_requests ?? 0,
        promptTokens: s.total_input_tokens ?? 0,
        completionTokens: s.total_output_tokens ?? 0,
        costUnit: 'USD',
        // 🔴 营收口径=实际扣费(actual_cost，客户真付)，非标准计费(total_cost，仅 1 倍标价参考)。
        cost: s.total_actual_cost ?? s.total_cost ?? 0,
        ...(typeof s.total_account_cost === 'number' ? { accountCost: s.total_account_cost } : {}),
      };
    },

    // 经营下钻。🔴 revenue=actual_cost(实际扣费/客户真付)，cost=account_cost(上游账户成本)。
    modelBreakdown: async (from: Date, to: Date): Promise<ModelUsageStat[]> => {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const d = await this.http.get<{
        models?: {
          model: string;
          requests: number;
          total_tokens: number;
          cost: number;
          actual_cost: number;
          account_cost: number;
        }[];
      }>(`/api/v1/admin/dashboard/models?start_date=${fmt(from)}&end_date=${fmt(to)}&timezone=Asia/Shanghai`);
      return (d.models ?? []).map((m) => ({
        model: m.model,
        requests: m.requests ?? 0,
        tokens: m.total_tokens ?? 0,
        revenue: m.actual_cost ?? 0,
        actualCost: m.actual_cost ?? 0,
        cost: m.account_cost ?? 0,
      }));
    },

    customerBreakdown: async (from: Date, to: Date, limit = 50): Promise<CustomerUsageStat[]> => {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const capped = Math.min(Math.max(1, Math.floor(limit)), 200);
      const d = await this.http.get<{
        users?: {
          user_id: number;
          email: string;
          requests: number;
          total_tokens: number;
          cost: number;
          actual_cost: number;
          account_cost: number;
        }[];
      }>(
        `/api/v1/admin/dashboard/user-breakdown?start_date=${fmt(from)}&end_date=${fmt(to)}&limit=${capped}&timezone=Asia/Shanghai`,
      );
      return (d.users ?? []).map((u) => ({
        userId: u.user_id,
        email: u.email ?? '',
        requests: u.requests ?? 0,
        tokens: u.total_tokens ?? 0,
        revenue: u.actual_cost ?? 0,
        actualCost: u.actual_cost ?? 0,
        cost: u.account_cost ?? 0,
      }));
    },

    customerRanking: async (from: Date, to: Date, limit = 50): Promise<CustomerRanking> => {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const capped = Math.min(Math.max(1, Math.floor(limit)), 50); // 引擎硬上限 50
      const d = await this.http.get<{
        ranking?: { user_id: number; email: string; actual_cost: number; requests: number; tokens: number }[];
        total_actual_cost?: number;
        total_requests?: number;
        total_tokens?: number;
      }>(
        `/api/v1/admin/dashboard/users-ranking?start_date=${fmt(from)}&end_date=${fmt(to)}&limit=${capped}&timezone=Asia/Shanghai`,
      );
      return {
        items: (d.ranking ?? []).map((r) => ({
          userId: r.user_id,
          email: r.email ?? '',
          actualCost: r.actual_cost ?? 0,
          requests: r.requests ?? 0,
          tokens: r.tokens ?? 0,
        })),
        totalActualCost: d.total_actual_cost ?? 0,
        totalRequests: d.total_requests ?? 0,
        totalTokens: d.total_tokens ?? 0,
      };
    },

    // 🔴 端点是 /accounts/:id/stats（不是 /usage，后者是配额窗口探针）；只吃 days，终点为今天。
    // revenue=total_user_cost(用户口径=实际扣费，与其它维度同口径)，cost=total_cost(账号口径成本)。
    accountStats: async (accountId: string, days: number): Promise<AccountUsageStat> => {
      const d = Math.min(Math.max(1, Math.floor(days)), 90);
      const res = await this.http.get<{
        summary?: {
          total_cost?: number;
          total_user_cost?: number;
          total_standard_cost?: number;
          total_requests?: number;
          total_tokens?: number;
          avg_daily_cost?: number;
          days?: number;
        };
      }>(`/api/v1/admin/accounts/${accountId}/stats?days=${d}`);
      const s = res.summary ?? {};
      return {
        requests: s.total_requests ?? 0,
        tokens: s.total_tokens ?? 0,
        revenue: s.total_user_cost ?? 0,
        cost: s.total_cost ?? 0,
        avgDailyCost: s.avg_daily_cost ?? 0,
        days: s.days ?? d,
      };
    },

    // 充值(现金到账)：源 /admin/payment/dashboard?days=N（今日+每日走势）。金额=站点结算货币(RMB)，非营收。
    rechargeSummary: async (days: number): Promise<RechargeSummary> => {
      const d = Math.min(Math.max(1, Math.floor(days)), 366);
      const r = await this.http.get<{
        today_amount?: number;
        today_count?: number;
        daily_series?: { date: string; amount: number; count: number }[];
      }>(`/api/v1/admin/payment/dashboard?days=${d}`);
      return {
        todayAmount: r.today_amount ?? 0,
        todayCount: r.today_count ?? 0,
        daily: (r.daily_series ?? []).map((x) => ({
          date: x.date,
          amount: x.amount ?? 0,
          count: x.count ?? 0,
        })),
      };
    },
  };
}
