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
  SiteCustomerRecord,
  UsageSummary,
  ModelUsageStat,
  CustomerUsageStat,
  CustomerRanking,
  AccountUsageStat,
  ChannelBalance,
  UpstreamWalletCandidate,
  UpstreamWalletCostCoverage,
  UpstreamWalletMode,
  UpstreamWalletProtocol,
  UpstreamWalletSnapshot,
  UpstreamWalletSnapshotStatus,
  RechargeSummary,
  CurrencyAmounts,
  PlatformQuota,
  PlatformQuotaInput,
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
  /** 服务端探测后的脱敏钱包快照；旧版本没有该字段。 */
  upstream_wallet?: unknown;
  // F5 上游余额/可用度（DTO 顶层，omitempty）：
  //  quota_limit/quota_used 仅 apikey/bedrock 且管理员配置>0 时返回（USD，真实可用额度）；
  //  window_cost_limit 仅 Anthropic OAuth/setup_token 且>0 时返回（USD，5h 窗口成本闸，非余额）。
  quota_limit?: number;
  quota_used?: number;
  window_cost_limit?: number;
}

const UPSTREAM_WALLET_PROBE_BATCH_PATH = '/api/v1/admin/accounts/upstream-wallet-probe/batch';
const UPSTREAM_WALLET_PROBE_BATCH_SIZE = 20;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 只保留 http(s) origin + path：去尾斜杠、query/hash/userinfo，避免把 URL 内嵌凭据带出 adapter。
 * 非法或非 http(s) 地址不是可探测候选，返回 null。
 */
function normalizeUpstreamBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path === '' || path === '/' ? '' : path}`;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 兼容旧版 number 与新版按 ISO 4217 币种拆分的对象。 */
function normalizeCurrencyAmounts(value: unknown): CurrencyAmounts {
  if (typeof value === 'number' && Number.isFinite(value)) return { CNY: value };
  const raw = recordOf(value);
  if (!raw) return {};
  const out: CurrencyAmounts = {};
  for (const [currency, amount] of Object.entries(raw)) {
    if (typeof amount === 'number' && Number.isFinite(amount)) out[currency.toUpperCase()] = amount;
  }
  return out;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** 只接收稳定枚举形态，拒绝把任意上游错误正文带进 Relay。 */
function safeReasonCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function snapshotStatus(value: unknown): UpstreamWalletSnapshotStatus | undefined {
  return value === 'ok' || value === 'unsupported' || value === 'failed' ? value : undefined;
}

function snapshotProtocol(value: unknown): UpstreamWalletProtocol {
  if (value === 'sub2api_v1_usage' || value === 'newapi_billing') return value;
  return 'unknown';
}

function snapshotMode(value: unknown): UpstreamWalletMode | undefined {
  return value === 'unrestricted' || value === 'quota_limited' ? value : undefined;
}

function costCoverage(value: unknown): UpstreamWalletCostCoverage | undefined {
  return value === 'exact' || value === 'partial' || value === 'none' ? value : undefined;
}

/** 宽容读取已知字段、忽略未来新增字段；任何 raw/credentials/错误正文都不会进入结果。 */
function parseUpstreamWalletSnapshot(value: unknown): UpstreamWalletSnapshot | undefined {
  const raw = recordOf(value);
  if (!raw) return undefined;
  const status = snapshotStatus(raw.status);
  if (!status) return undefined;

  const out: UpstreamWalletSnapshot = {
    status,
    protocol: snapshotProtocol(raw.protocol),
  };
  const schemaVersion = nonNegativeInt(raw.schema_version);
  const mode = snapshotMode(raw.mode);
  const balance = finiteNumber(raw.balance);
  const remaining = finiteNumber(raw.remaining);
  const costMonthToDate = finiteNumber(raw.cost_month_to_date);
  const coverage = costCoverage(raw.cost_coverage);
  const stale = raw.stale === true;
  const observedAt = safeTimestamp(raw.probed_at);
  const freshUntil = safeTimestamp(raw.fresh_until);
  const nextProbeAt = safeTimestamp(raw.next_probe_at);
  const failureCount = nonNegativeInt(raw.failure_count);
  const httpStatus = nonNegativeInt(raw.http_status);
  const reasonCode = safeReasonCode(raw.last_error);

  if (schemaVersion !== undefined) out.schemaVersion = schemaVersion;
  if (mode !== undefined) out.mode = mode;
  // quota_limited 只能表达额度 remaining，绝不把额度/订阅上限冒充真实钱包 balance。
  if (balance !== undefined && mode !== 'quota_limited') out.balance = balance;
  if (remaining !== undefined && mode === 'quota_limited') out.remaining = remaining;
  if (costMonthToDate !== undefined) out.costMonthToDate = costMonthToDate;
  if (coverage !== undefined) out.costCoverage = coverage;
  if (stale) out.stale = true;
  if (raw.currency === 'USD') out.currency = 'USD';
  if (raw.unit === 'USD') out.unit = 'USD';
  if (observedAt !== undefined) out.observedAt = observedAt;
  if (freshUntil !== undefined) out.freshUntil = freshUntil;
  if (nextProbeAt !== undefined) out.nextProbeAt = nextProbeAt;
  if (failureCount !== undefined) out.failureCount = failureCount;
  if (httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599) out.httpStatus = httpStatus;
  if (reasonCode !== undefined) out.reasonCode = reasonCode;
  return out;
}

function walletSystem(protocol: UpstreamWalletProtocol): UpstreamWalletCandidate['system'] {
  if (protocol === 'sub2api_v1_usage') return 'sub2api';
  if (protocol === 'newapi_billing') return 'newapi';
  return 'unknown';
}

function inferUpstreamPurposes(parts: unknown[]): NonNullable<UpstreamWalletCandidate['purposes']> {
  const text = parts
    .map((part) => typeof part === 'string' ? part : part == null ? '' : JSON.stringify(part))
    .join(' ')
    .toLowerCase();
  const purposes = new Set<NonNullable<UpstreamWalletCandidate['purposes']>[number]>();
  if (/gpt[-_ ]?image|image2|imagen|dall[-_ ]?e|\bimage\b|生图/.test(text)) purposes.add('image');
  if (/bedrock|aws/.test(text)) purposes.add('aws');
  if (/claude|anthropic|fable|sonnet|opus|haiku/.test(text)) purposes.add('claude');
  if (/gemini/.test(text)) purposes.add('gemini');
  if (!purposes.has('image') && /openai|responses|codex|\bgpt/.test(text)) purposes.add('gpt');
  return [...purposes];
}

function accountToUpstreamWalletCandidate(a: S2ARawAccount): UpstreamWalletCandidate | null {
  if (a.status !== 'active') return null;
  const baseUrl = normalizeUpstreamBaseUrl(a.credentials?.base_url);
  if (!baseUrl) return null;
  // 新 DTO 顶层优先；旧服务端持久化值仍可从 extra.upstream_wallet_probe 回读。
  const topLevel = parseUpstreamWalletSnapshot(a.upstream_wallet);
  const fallback = topLevel ?? parseUpstreamWalletSnapshot(a.extra?.upstream_wallet_probe);
  const purposes = inferUpstreamPurposes([
    a.name,
    a.platform,
    a.credentials?.model_mapping,
    a.extra?.model_mapping,
  ]);
  return {
    accountId: String(a.id),
    accountName: a.name,
    enabled: true,
    baseUrl,
    system: walletSystem(fallback?.protocol ?? 'unknown'),
    discovery: fallback ? 'server-snapshot' : 'metadata-only',
    ...(purposes.length > 0 ? { purposes } : {}),
    ...(fallback ? { snapshot: fallback } : {}),
  };
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
  // CRM 富字段（F4）：list 与 listAll 复用同一原始结构，均可选（additive，不破坏既有 users.list 映射）
  frozen_balance?: number;
  total_recharged?: number;
  created_at?: string;
  last_active_at?: string | null;
  last_used_at?: string | null;
  subscriptions?: { id: number; status?: string }[];
}

/** GET/PUT /admin/users/:id/platform-quotas 的原始行（各窗口 *_usage_usd / *_limit_usd(null=不限) / *_window_resets_at） */
interface S2ARawPlatformQuota {
  platform: string;
  daily_usage_usd?: number;
  daily_limit_usd?: number | null;
  daily_window_resets_at?: string;
  weekly_usage_usd?: number;
  weekly_limit_usd?: number | null;
  weekly_window_resets_at?: string;
  monthly_usage_usd?: number;
  monthly_limit_usd?: number | null;
  monthly_window_resets_at?: string;
}

/** 原始平台限额行 → adapter-core PlatformQuota（limit 的 null=不限原样保留，与 0=禁用区分） */
function rawToPlatformQuota(q: S2ARawPlatformQuota): PlatformQuota {
  const win = (usage: number | undefined, limit: number | null | undefined, resetsAt: string | undefined) => ({
    usageUsd: usage ?? 0,
    // 🔴 null=不限 原样保留（不可折成 0=禁用）；缺字段视为不限
    limitUsd: limit === undefined ? null : limit,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
  return {
    platform: q.platform,
    daily: win(q.daily_usage_usd, q.daily_limit_usd, q.daily_window_resets_at),
    weekly: win(q.weekly_usage_usd, q.weekly_limit_usd, q.weekly_window_resets_at),
    monthly: win(q.monthly_usage_usd, q.monthly_limit_usd, q.monthly_window_resets_at),
  };
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

    // F5 快捷充值/续杯：重置该账户所有维度配额【已用】为 0（AccountHandler.ResetQuota→ResetAccountQuota→ResetQuotaUsed）。
    // 🔴 不可逆(丢失已用计数)、纯透传。仅对 kind='quota'(apikey/bedrock) 渠道有意义——kind 判定与确认令牌/门控在 orchestrator，
    // adapter 不做业务判断，只 POST。响应无实体（envelope.data 忽略）。
    resetQuota: async (id: string): Promise<void> => {
      await this.http.post(`/api/v1/admin/accounts/${id}/reset-quota`);
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

    // CRM 全量拉取（F4）：翻完全部分页 /admin/users，映射富字段 + subscriptions?.length>0→hasSubscription。
    // 🔴 只读端点，不触碰额度/余额；balance/frozen_balance/total_recharged 归一为 number。
    listAll: async (opts?: { includeSubscriptions?: boolean }): Promise<SiteCustomerRecord[]> => {
      const inc = opts?.includeSubscriptions !== false; // 默认带订阅（判 hasSubscription）
      const path = `/api/v1/admin/users?sort_by=created_at&sort_order=desc${
        inc ? '&include_subscriptions=true' : ''
      }`;
      const raw = await this.http.listAll<S2ARawUser>(path);
      return raw.map((u) => ({
        userId: u.id,
        role: u.role === 'admin' ? 'admin' : 'user',
        status: u.status === 'active' ? 'active' : 'disabled',
        ...(u.email ? { email: u.email } : {}),
        ...(u.username ? { username: u.username } : {}),
        ...(u.balance !== undefined ? { balance: Number(u.balance) } : {}),
        ...(u.frozen_balance !== undefined ? { frozenBalance: Number(u.frozen_balance) } : {}),
        ...(u.total_recharged !== undefined ? { totalRecharged: Number(u.total_recharged) } : {}),
        ...(u.created_at ? { createdAt: u.created_at } : {}),
        ...(u.last_active_at ? { lastActiveAt: u.last_active_at } : {}),
        ...(u.last_used_at ? { lastUsedAt: u.last_used_at } : {}),
        hasSubscription: Array.isArray(u.subscriptions) && u.subscriptions.length > 0,
      }));
    },

    // 平台限额读（F3 风控护栏）：GET → http 已剥 data 信封 → 读 platform_quotas[]。
    getPlatformQuotas: async (id: string): Promise<PlatformQuota[]> => {
      const d = await this.http.get<{ platform_quotas?: S2ARawPlatformQuota[] }>(
        `/api/v1/admin/users/${id}/platform-quotas`,
      );
      return (d.platform_quotas ?? []).map(rawToPlatformQuota);
    },

    // 平台限额写：PUT 同路径【全量替换】，body={quotas:[{platform,daily_limit_usd,weekly_limit_usd,monthly_limit_usd}]}。
    // nil/0/>0 语义原样透传（undefined→null=不限、0=禁用、>0=USD 上限）；回读返回最新。
    setPlatformQuotas: async (id: string, quotas: PlatformQuotaInput[]): Promise<PlatformQuota[]> => {
      const body = {
        quotas: quotas.map((q) => ({
          platform: q.platform,
          daily_limit_usd: q.dailyLimitUsd ?? null,
          weekly_limit_usd: q.weeklyLimitUsd ?? null,
          monthly_limit_usd: q.monthlyLimitUsd ?? null,
        })),
      };
      const d = await this.http.put<{ platform_quotas?: S2ARawPlatformQuota[] }>(
        `/api/v1/admin/users/${id}/platform-quotas`,
        body,
      );
      return (d.platform_quotas ?? []).map(rawToPlatformQuota);
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
        today_amount?: number | Record<string, number>;
        today_count?: number;
        daily_series?: { date: string; amount: number | Record<string, number>; count: number }[];
      }>(`/api/v1/admin/payment/dashboard?days=${d}`);
      return {
        todayAmount: normalizeCurrencyAmounts(r.today_amount),
        todayCount: r.today_count ?? 0,
        daily: (r.daily_series ?? []).map((x) => ({
          date: x.date,
          amount: normalizeCurrencyAmounts(x.amount),
          count: x.count ?? 0,
        })),
      };
    },

    /**
     * 从正常 accounts DTO 提取启用账号的无凭据钱包候选。
     * force=true 时先让新引擎按最多 20 个 apikey 账号一批刷新快照；旧引擎没有端点或任一批失败时
     * 直接降级回读已有 DTO，不让整站发现失败。
     */
    upstreamWalletCandidates: async (opts?: { force?: boolean }): Promise<UpstreamWalletCandidate[]> => {
      let accounts = await this.http.listAll<S2ARawAccount>('/api/v1/admin/accounts');
      if (opts?.force === true) {
        const ids = [
          ...new Set(
            accounts
              .filter((a) => a.status === 'active' && a.type === 'apikey' && Number.isInteger(a.id) && a.id > 0)
              .map((a) => a.id),
          ),
        ];
        if (ids.length > 0) {
          for (let i = 0; i < ids.length; i += UPSTREAM_WALLET_PROBE_BATCH_SIZE) {
            try {
              await this.http.post(UPSTREAM_WALLET_PROBE_BATCH_PATH, {
                account_ids: ids.slice(i, i + UPSTREAM_WALLET_PROBE_BATCH_SIZE),
              });
            } catch {
              // 404/405=旧引擎；其它批量探测错误同样只影响本轮刷新，已有快照仍可回读。
              break;
            }
          }
          accounts = await this.http.listAll<S2ARawAccount>('/api/v1/admin/accounts');
        }
      }
      return accounts
        .map(accountToUpstreamWalletCandidate)
        .filter((candidate): candidate is UpstreamWalletCandidate => candidate !== null);
    },

    // F5 上游渠道"余额/可用度"：复用 /admin/accounts 列表，逐账户按覆盖度分类（纯只读）。
    // 🔴 绝不触碰 accountToChannelRecord（monitor/finance/channels.list 共用）。
    //    额度写(reset-quota)是独立能力，走 channels.resetQuota（有 root+门控+确认令牌+kind 守卫），本读路径永不触发写。
    //  - typeof quota_limit==='number'（apikey/bedrock 且管理员配>0）→ kind='quota'（带 quotaLimit/quotaUsed，真实可用额度）；
    //  - 否则 window_cost_limit 有值 或 type∈{oauth,setup_token}（Anthropic OAuth/号池）→ kind='window'（仅窗口成本闸，非余额）；
    //  - 否则 → kind='none'（零覆盖）。
    channelBalances: async (): Promise<ChannelBalance[]> => {
      const accounts = await this.http.listAll<S2ARawAccount>('/api/v1/admin/accounts');
      return accounts.map((a): ChannelBalance => {
        const base = {
          id: String(a.id),
          name: a.name,
          accountType: a.type,
          enabled: a.status === 'active',
        };
        if (typeof a.quota_limit === 'number') {
          return {
            ...base,
            kind: 'quota',
            quotaLimit: a.quota_limit,
            ...(typeof a.quota_used === 'number' ? { quotaUsed: a.quota_used } : {}),
          };
        }
        if (typeof a.window_cost_limit === 'number' || a.type === 'oauth' || a.type === 'setup_token') {
          return {
            ...base,
            kind: 'window',
            ...(typeof a.window_cost_limit === 'number' ? { windowCostLimit: a.window_cost_limit } : {}),
          };
        }
        return { ...base, kind: 'none' };
      });
    },
  };
}
