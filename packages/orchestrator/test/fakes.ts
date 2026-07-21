import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineAdapter,
  EngineAdminClient,
  EngineCapabilities,
  EngineKind,
  EngineLifecycle,
  GroupRecord,
  GroupSpec,
  HealthReport,
  InstanceInfo,
  SiteBranding,
  SiteSpec,
  SiteUserRecord,
  SiteCustomerRecord,
  UsageSummary,
  CustomerRanking,
  CustomerRankingItem,
  PlatformQuota,
  PlatformQuotaInput,
  ChannelBalance,
  AccountUsageStat,
} from '@relay-panel/adapter-core';

/**
 * Phase F 交付的测试替身（规格 §12）。全内存、零网络、零 docker。
 * 失败注入统一走 failOn(op)/clearFailure(op)；注入的错误信息不得含凭据。
 */

/** 用量基线（stats.usage 按窗口原样返回，from/to 覆盖为调用参数） */
export interface FakeUsageBase {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  costUnit: string;
  byModel?: Record<string, { requests: number; tokens: number; cost: number }>;
}

export interface FakeSiteState {
  channels: ChannelRecord[];
  groups: GroupRecord[];
  users: SiteUserRecord[];
  branding: SiteBranding;
  rawSettings: Map<string, string>;
  usage: FakeUsageBase;
  nextId: number;
  /** 客户消费榜单（F3 风控）：单日窗口(from===to)返回 recent，多日窗口返回 baseline */
  rankingRecent: CustomerRankingItem[];
  rankingBaseline: CustomerRankingItem[];
  /** 平台限额（F3 风控护栏）：userId → 该用户全量平台限额（PUT 全量替换写这里） */
  platformQuotas: Map<string, PlatformQuota[]>;
  /** CRM 客户全量（F4）：users.listAll 返回；未设置时回落 undefined→listAll 返回空 */
  customers?: SiteCustomerRecord[];
  /** 上游渠道余额/可用度（F5）：stats.channelBalances 返回；未设置=空 */
  channelBalances?: ChannelBalance[];
  /** 账号口径日均消耗（F5）：stats.accountStats 返回的 avgDailyCost（accountId → USD）；缺省 0 */
  accountAvgDailyCost?: Map<string, number>;
}

function defaultState(slug: string): FakeSiteState {
  return {
    channels: [],
    groups: [],
    users: [],
    branding: { siteName: slug },
    rawSettings: new Map(),
    usage: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, costUnit: 'USD' },
    nextId: 1,
    rankingRecent: [],
    rankingBaseline: [],
    platformQuotas: new Map(),
  };
}

export class FakeAdapter implements EngineAdapter {
  readonly engine: EngineKind;
  readonly dbDirect = false;
  /** 操作调用序列（形如 'connect:site-a'、'channels.create:site-a'），供断言 */
  readonly calls: string[] = [];
  private readonly states = new Map<string, FakeSiteState>();
  private readonly failures = new Map<string, string>();
  private readonly unhealthy = new Set<string>();
  private readonly unreachable = new Set<string>();

  constructor(engine: EngineKind = 'sub2api') {
    this.engine = engine;
  }

  /** 取（并按需初始化）某站的内存状态，测试可直接改 */
  stateFor(slug: string): FakeSiteState {
    let s = this.states.get(slug);
    if (!s) {
      s = defaultState(slug);
      this.states.set(slug, s);
    }
    return s;
  }

  /** 让指定操作（如 'connect'、'channels.create'、'health'）开始抛错/报不健康 */
  failOn(op: string, message = `injected failure: ${op}`): void {
    this.failures.set(op, message);
  }

  clearFailure(op: string): void {
    this.failures.delete(op);
  }

  /** 单站健康开关（site_down 告警测试用） */
  setUnhealthy(slug: string, down = true): void {
    if (down) this.unhealthy.add(slug);
    else this.unhealthy.delete(slug);
  }

  /** 单站 connect 失败开关（模拟站点不可达：admin 面读写在连接期即失败，用于批量 partial 测试） */
  setUnreachable(slug: string, down = true): void {
    if (down) this.unreachable.add(slug);
    else this.unreachable.delete(slug);
  }

  /** 设某站两窗口客户消费榜单（F3 风控骤增侦测；recent=今日单日窗口，baseline=多日基线窗口） */
  setRanking(slug: string, recent: CustomerRankingItem[], baseline: CustomerRankingItem[]): void {
    const s = this.stateFor(slug);
    s.rankingRecent = recent;
    s.rankingBaseline = baseline;
  }

  /** 设某用户全量平台限额（F3 风控护栏；PUT 全量替换回读的初值） */
  setPlatformQuotas(slug: string, userId: string, quotas: PlatformQuota[]): void {
    this.stateFor(slug).platformQuotas.set(userId, quotas);
  }

  /** 设某站 CRM 客户全量（F4 客户 CRM；users.listAll 返回该列表） */
  setCustomers(slug: string, customers: SiteCustomerRecord[]): void {
    this.stateFor(slug).customers = customers;
  }

  /** 设某站上游渠道余额/可用度（F5；stats.channelBalances 返回该列表） */
  setChannelBalances(slug: string, balances: ChannelBalance[]): void {
    this.stateFor(slug).channelBalances = balances;
  }

  /** 设某站某账户账号口径日均消耗（F5；stats.accountStats 的 avgDailyCost，USD） */
  setAccountAvgDailyCost(slug: string, accountId: string, usd: number): void {
    const s = this.stateFor(slug);
    (s.accountAvgDailyCost ??= new Map()).set(accountId, usd);
  }

  private check(op: string): void {
    const msg = this.failures.get(op);
    if (msg) throw new Error(msg);
  }

  async capabilities(_inst: InstanceInfo): Promise<EngineCapabilities> {
    this.check('capabilities');
    return {
      userAccessTokens: true,
      multiGroupKeys: true,
      anthropicNative: this.engine === 'sub2api',
      subscriptionBilling: false,
    };
  }

  async health(inst: InstanceInfo): Promise<HealthReport> {
    this.calls.push(`health:${inst.siteSlug}`);
    const msg = this.failures.get('health');
    if (msg) return { ok: false, httpOk: false, detail: msg };
    if (this.unhealthy.has(inst.siteSlug)) {
      return { ok: false, httpOk: false, detail: 'connection refused (injected)' };
    }
    return { ok: true, httpOk: true, dbOk: true, latencyMs: 5, version: inst.version };
  }

  /** 注意：不调用 credentials.resolve —— 凭据链路由 credstore 单测覆盖，避免 fake 场景强制铺凭据 */
  async connect(inst: InstanceInfo, _credentials: CredentialStore): Promise<EngineAdminClient> {
    this.calls.push(`connect:${inst.siteSlug}`);
    this.check('connect');
    if (this.unreachable.has(inst.siteSlug)) {
      throw new Error(`connection refused (injected): ${inst.siteSlug}`);
    }
    return this.clientFor(inst);
  }

  clientFor(inst: InstanceInfo): EngineAdminClient {
    const slug = inst.siteSlug;
    const state = this.stateFor(slug);
    const track = (op: string): void => {
      this.calls.push(`${op}:${slug}`);
      this.check(op);
    };

    return {
      inst,
      channels: {
        list: async (): Promise<ChannelRecord[]> => {
          track('channels.list');
          return state.channels.map((c) => ({ ...c }));
        },
        create: async (spec: ChannelSpec): Promise<ChannelRecord> => {
          track('channels.create');
          const rec: ChannelRecord = { ...spec, id: String(state.nextId++), enabled: true };
          state.channels.push(rec);
          return { ...rec };
        },
        update: async (
          id: string,
          patch: Partial<ChannelSpec> & { enabled?: boolean },
        ): Promise<ChannelRecord> => {
          track('channels.update');
          const rec = state.channels.find((c) => c.id === id);
          if (!rec) throw new Error(`channel not found: ${id}`);
          Object.assign(rec, patch);
          return { ...rec };
        },
        remove: async (id: string): Promise<void> => {
          track('channels.remove');
          const idx = state.channels.findIndex((c) => c.id === id);
          if (idx < 0) throw new Error(`channel not found: ${id}`);
          state.channels.splice(idx, 1);
        },
        test: async (id: string, model?: string): Promise<ChannelTestResult> => {
          track('channels.test');
          const rec = state.channels.find((c) => c.id === id);
          if (!rec) return { ok: false, error: `channel not found: ${id}` };
          return { ok: true, latencyMs: 3, ...(model !== undefined ? { model } : {}) };
        },
        // F5 快捷充值：重置该渠道已用额度为 0（对预置 channelBalances 里同 id 的 quotaUsed 归零）
        resetQuota: async (id: string): Promise<void> => {
          track('channels.resetQuota');
          const b = state.channelBalances?.find((x) => x.id === id);
          if (b && b.kind === 'quota') b.quotaUsed = 0;
        },
      },
      groups: {
        list: async (): Promise<GroupRecord[]> => {
          track('groups.list');
          return state.groups.map((g) => ({ ...g }));
        },
        create: async (spec: GroupSpec): Promise<GroupRecord> => {
          track('groups.create');
          const rec: GroupRecord = { ...spec, id: String(state.nextId++) };
          state.groups.push(rec);
          return { ...rec };
        },
        update: async (id: string, patch: Partial<GroupSpec>): Promise<GroupRecord> => {
          track('groups.update');
          const rec = state.groups.find((g) => g.id === id);
          if (!rec) throw new Error(`group not found: ${id}`);
          Object.assign(rec, patch);
          return { ...rec };
        },
      },
      users: {
        list: async (query?: { search?: string; page?: number }): Promise<SiteUserRecord[]> => {
          track('users.list');
          const q = query?.search?.toLowerCase();
          const all = state.users.map((u) => ({ ...u }));
          if (!q) return all;
          return all.filter(
            (u) => u.email?.toLowerCase().includes(q) || u.username?.toLowerCase().includes(q),
          );
        },
        setStatus: async (id: string, status: 'active' | 'disabled'): Promise<void> => {
          track('users.setStatus');
          const u = state.users.find((x) => x.id === id);
          if (!u) throw new Error(`user not found: ${id}`);
          u.status = status;
        },
        // F4 CRM：全量客户拉取（深拷贝防外部改动；未设置 customers 时返回空）
        listAll: async (_opts?: { includeSubscriptions?: boolean }): Promise<SiteCustomerRecord[]> => {
          track('users.listAll');
          return (state.customers ?? []).map((c) => ({ ...c }));
        },
        // F3 风控护栏：平台限额读（返回该用户全量限额，深拷贝防外部改动）
        getPlatformQuotas: async (id: string): Promise<PlatformQuota[]> => {
          track('users.getPlatformQuotas');
          return (state.platformQuotas.get(id) ?? []).map((q) => ({
            platform: q.platform,
            daily: { ...q.daily },
            weekly: { ...q.weekly },
            monthly: { ...q.monthly },
          }));
        },
        // F3 风控护栏：平台限额写（【全量替换】，limit 从 input 取、usage 从既有回搬，回读返回）
        setPlatformQuotas: async (id: string, quotas: PlatformQuotaInput[]): Promise<PlatformQuota[]> => {
          track('users.setPlatformQuotas');
          const prev = new Map((state.platformQuotas.get(id) ?? []).map((q) => [q.platform, q]));
          const next: PlatformQuota[] = quotas.map((q) => {
            const old = prev.get(q.platform);
            const win = (limit: number | null | undefined, usage: number | undefined) => ({
              usageUsd: usage ?? 0,
              limitUsd: limit === undefined ? null : limit,
            });
            return {
              platform: q.platform,
              daily: win(q.dailyLimitUsd, old?.daily.usageUsd),
              weekly: win(q.weeklyLimitUsd, old?.weekly.usageUsd),
              monthly: win(q.monthlyLimitUsd, old?.monthly.usageUsd),
            };
          });
          state.platformQuotas.set(id, next);
          return next.map((q) => ({ platform: q.platform, daily: { ...q.daily }, weekly: { ...q.weekly }, monthly: { ...q.monthly } }));
        },
      },
      settings: {
        getBranding: async (): Promise<SiteBranding> => {
          track('settings.getBranding');
          return { ...state.branding };
        },
        setBranding: async (branding: Partial<SiteBranding>): Promise<void> => {
          track('settings.setBranding');
          Object.assign(state.branding, branding);
        },
        getRaw: async (key: string): Promise<string | null> => {
          track('settings.getRaw');
          return state.rawSettings.get(key) ?? null;
        },
        setRaw: async (key: string, value: string): Promise<void> => {
          track('settings.setRaw');
          state.rawSettings.set(key, value);
        },
      },
      stats: {
        usage: async (from: Date, to: Date): Promise<UsageSummary> => {
          track('stats.usage');
          const { byModel, ...base } = state.usage;
          return { from, to, ...base, ...(byModel !== undefined ? { byModel } : {}) };
        },
        // F3 风控：单日窗口(from===to 同一日历日)返回 recent，多日窗口返回 baseline
        customerRanking: async (from: Date, to: Date, limit = 50): Promise<CustomerRanking> => {
          track('stats.customerRanking');
          const single = from.toISOString().slice(0, 10) === to.toISOString().slice(0, 10);
          const items = (single ? state.rankingRecent : state.rankingBaseline).slice(0, limit).map((r) => ({ ...r }));
          return {
            items,
            totalActualCost: items.reduce((a, r) => a + r.actualCost, 0),
            totalRequests: items.reduce((a, r) => a + r.requests, 0),
            totalTokens: items.reduce((a, r) => a + r.tokens, 0),
          };
        },
        // F5 上游余额：返回该站预置的 channelBalances（深拷贝防外部改动；未设置=空）
        channelBalances: async (): Promise<ChannelBalance[]> => {
          track('stats.channelBalances');
          return (state.channelBalances ?? []).map((b) => ({ ...b }));
        },
        // F5 账号口径日均：avgDailyCost 从预置 map 取（缺省 0）；其余字段占位
        accountStats: async (accountId: string, days: number): Promise<AccountUsageStat> => {
          track('stats.accountStats');
          const avg = state.accountAvgDailyCost?.get(accountId) ?? 0;
          return { requests: 0, tokens: 0, revenue: 0, cost: 0, avgDailyCost: avg, days };
        },
      },
    };
  }
}

export interface FakeLifecycleOptions {
  onStep?: (
    slug: string,
    step: string,
    status: 'start' | 'ok' | 'fail',
    detail?: string,
  ) => Promise<void>;
  /** 同真实 lifecycle：生成的凭据交给上层入库，返回 credentialRef */
  storeCredential?: (slug: string, secrets: Record<string, string>) => Promise<string>;
}

const PROVISION_STEPS = ['render', 'compose-up', 'health', 'store-credential'] as const;

export class FakeLifecycle implements EngineLifecycle {
  readonly engine: EngineKind;
  /** 方法调用序列（'provision:site-a'、'upgrade:site-a:v2' …） */
  readonly calls: string[] = [];
  private readonly failSteps = new Map<string, string>();
  private readonly opts: FakeLifecycleOptions;

  constructor(engine: EngineKind = 'sub2api', opts: FakeLifecycleOptions = {}) {
    this.engine = engine;
    this.opts = opts;
  }

  /** 让 provision 的某一步（'render'|'compose-up'|'health'|'store-credential'）或某方法（'upgrade' 等）失败 */
  failAt(stepOrMethod: string, message = `injected failure: ${stepOrMethod}`): void {
    this.failSteps.set(stepOrMethod, message);
  }

  clearFailure(stepOrMethod: string): void {
    this.failSteps.delete(stepOrMethod);
  }

  private async step(slug: string, name: string): Promise<void> {
    await this.opts.onStep?.(slug, name, 'start');
    const msg = this.failSteps.get(name);
    if (msg) {
      await this.opts.onStep?.(slug, name, 'fail', msg);
      throw new Error(msg);
    }
    await this.opts.onStep?.(slug, name, 'ok');
  }

  private checkMethod(name: string): void {
    const msg = this.failSteps.get(name);
    if (msg) throw new Error(msg);
  }

  async provision(spec: SiteSpec): Promise<InstanceInfo> {
    this.calls.push(`provision:${spec.slug}`);
    for (const s of PROVISION_STEPS) await this.step(spec.slug, s);
    // 凭据值是占位假数据（fake- 前缀），非真实凭据
    const credentialRef = this.opts.storeCredential
      ? await this.opts.storeCredential(spec.slug, {
          adminEmail: spec.adminEmail,
          adminPassword: `fake-password-${spec.slug}`,
        })
      : `devfile:data/sites/${spec.slug}/credentials.json`;
    return {
      siteSlug: spec.slug,
      engine: this.engine,
      version: spec.version,
      baseUrl: `http://127.0.0.1:${spec.hostPort}`,
      dataDir: `data/sites/${spec.slug}`,
      composeProject: `rp-${spec.slug}`,
      credentialRef,
    };
  }

  async upgrade(inst: InstanceInfo, toVersion: string): Promise<InstanceInfo> {
    this.calls.push(`upgrade:${inst.siteSlug}:${toVersion}`);
    if (toVersion === 'latest') throw new Error('version must be pinned');
    this.checkMethod('upgrade');
    return { ...inst, version: toVersion };
  }

  async stop(inst: InstanceInfo): Promise<void> {
    this.calls.push(`stop:${inst.siteSlug}`);
    this.checkMethod('stop');
  }

  async start(inst: InstanceInfo): Promise<void> {
    this.calls.push(`start:${inst.siteSlug}`);
    this.checkMethod('start');
  }

  async destroy(inst: InstanceInfo, opts: { keepData: boolean }): Promise<void> {
    this.calls.push(`destroy:${inst.siteSlug}:keepData=${opts.keepData}`);
    this.checkMethod('destroy');
  }
}

/** 与规格 §7 网关 HTTP 契约对应的行形状（G2 的 MeteringGateway 接口须与本 fake 结构兼容） */
export interface GatewayUsageRow {
  periodStart: string;
  periodEnd: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  upstreamCost: number;
  billedCost: number;
}

export class FakeGateway {
  readonly issued: { keyRef: string; siteSlug: string; templateKey: string; models: string[] }[] = [];
  readonly revoked: string[] = [];
  private readonly usage = new Map<string, GatewayUsageRow[]>();
  private readonly failures = new Map<string, string>();
  private seq = 1;

  failOn(op: string, message = `injected failure: ${op}`): void {
    this.failures.set(op, message);
  }

  clearFailure(op: string): void {
    this.failures.delete(op);
  }

  private check(op: string): void {
    const msg = this.failures.get(op);
    if (msg) throw new Error(msg);
  }

  async issueKey(input: {
    siteSlug: string;
    templateKey: string;
    models: string[];
  }): Promise<{ keyRef: string; apiKey: string; baseUrl: string }> {
    this.check('issueKey');
    const keyRef = `meter-${this.seq++}`;
    this.issued.push({ keyRef, ...input });
    return { keyRef, apiKey: `sk-fake-${keyRef}`, baseUrl: 'https://gateway.example.com/v1' };
  }

  async revokeKey(keyRef: string): Promise<void> {
    this.check('revokeKey');
    this.revoked.push(keyRef);
  }

  setUsage(keyRef: string, rows: GatewayUsageRow[]): void {
    this.usage.set(keyRef, rows);
  }

  async pullUsage(keyRef: string, from: Date, to: Date): Promise<GatewayUsageRow[]> {
    this.check('pullUsage');
    const rows = this.usage.get(keyRef) ?? [];
    return rows.filter(
      (r) => new Date(r.periodEnd).getTime() > from.getTime() && new Date(r.periodStart).getTime() < to.getTime(),
    );
  }
}

export interface NotifyEvent {
  type: 'open' | 'resolve';
  alert: unknown;
  site?: unknown;
}

export class FakeNotifier {
  readonly events: NotifyEvent[] = [];

  async fire(event: NotifyEvent): Promise<void> {
    this.events.push(event);
  }
}
