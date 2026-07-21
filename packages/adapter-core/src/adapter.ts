import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineCapabilities,
  EngineKind,
  GroupRecord,
  GroupSpec,
  HealthReport,
  InstanceInfo,
  SiteBranding,
  SiteSpec,
  SiteUserRecord,
  SiteCustomerRecord,
  UsageSummary,
  ModelUsageStat,
  CustomerUsageStat,
  CustomerRanking,
  AccountUsageStat,
  ChannelBalance,
  RechargeSummary,
  PlatformQuota,
  PlatformQuotaInput,
} from './types.js';

/**
 * 每个引擎实现一个 EngineAdapter。
 *
 * 铁律（见 docs/LICENSE-COMPLIANCE.md 与 docs/ARCHITECTURE.md）：
 * 1. 只经引擎公开 admin API（HTTP）操作引擎；直连 DB 须显式声明 dbDirect 并注明风险。
 * 2. 凭据只经 CredentialStore 在内存解密使用，绝不落日志、落盘、回显。
 * 3. adapter 不含渠道市场等商业逻辑 —— 那些在 orchestrator 层。
 */
export interface EngineAdapter {
  readonly engine: EngineKind;
  /** 该 adapter 是否有绕过 admin API 直连引擎 DB 的路径 */
  readonly dbDirect: boolean;

  capabilities(inst: InstanceInfo): Promise<EngineCapabilities>;
  health(inst: InstanceInfo): Promise<HealthReport>;

  /** 建立 admin 会话（自签 JWT / 登录换 session 等），会话在 adapter 内部缓存与续期 */
  connect(inst: InstanceInfo, credentials: CredentialStore): Promise<EngineAdminClient>;
}

/** 已认证的引擎 admin 客户端 —— 所有写操作必须过 orchestrator 的审计钩子 */
export interface EngineAdminClient {
  readonly inst: InstanceInfo;

  channels: {
    list(): Promise<ChannelRecord[]>;
    create(spec: ChannelSpec): Promise<ChannelRecord>;
    update(id: string, patch: Partial<ChannelSpec> & { enabled?: boolean }): Promise<ChannelRecord>;
    remove(id: string): Promise<void>;
    test(id: string, model?: string): Promise<ChannelTestResult>;
    /**
     * 重置该渠道(账户)全部维度的配额【已用】计数为 0（F5 快捷充值/续杯；可选：引擎支持才实现，
     * adapter-newapi 未实现即 undefined）。🔴 不可逆：丢失已用计数，仅对 kind='quota'
     * (apikey/bedrock，有真实 quota_limit) 的渠道有意义；window/none 零覆盖渠道无额度语义，
     * 上层（orchestrator）必须先经 channelBalances 判 kind 后再调，绝不对 window/none 渠道调用。
     * adapter 层为纯透传（POST /accounts/:id/reset-quota），业务门控/确认令牌在 orchestrator。
     */
    resetQuota?(id: string): Promise<void>;
  };

  groups: {
    list(): Promise<GroupRecord[]>;
    create(spec: GroupSpec): Promise<GroupRecord>;
    update(id: string, patch: Partial<GroupSpec>): Promise<GroupRecord>;
  };

  users: {
    list(query?: { search?: string; page?: number }): Promise<SiteUserRecord[]>;
    setStatus(id: string, status: 'active' | 'disabled'): Promise<void>;
    /**
     * 全量拉取客户（CRM，F4）：可选——引擎支持才实现（adapter-newapi 不实现→undefined，
     * CRM 侧判为不支持并把该站标 degraded 跳过）。翻完全部分页返回富客户记录
     * （余额/充值/活跃时间/订阅标记）。includeSubscriptions 决定是否附 hasSubscription。
     * 🔴 只读，绝不触碰客户额度/余额；与既有 list/setStatus 签名完全独立。
     */
    listAll?(opts?: { includeSubscriptions?: boolean }): Promise<SiteCustomerRecord[]>;
    /**
     * 读某用户各平台限额（可选：引擎支持才实现，F3 风控护栏用）。
     * 金额单位 USD；limitUsd null=不限。
     */
    getPlatformQuotas?(id: string): Promise<PlatformQuota[]>;
    /**
     * 写某用户平台限额（可选）。🔴 PUT 是【全量替换】：缺失的 platform 会被软删，
     * 调用方必须先 getPlatformQuotas 合并（保留未涉及 platform 与同 platform 其它窗口）再写回。
     * 回读返回最新。nil/0/>0 语义见 PlatformQuotaInput。
     */
    setPlatformQuotas?(id: string, quotas: PlatformQuotaInput[]): Promise<PlatformQuota[]>;
  };

  settings: {
    getBranding(): Promise<SiteBranding>;
    setBranding(branding: Partial<SiteBranding>): Promise<void>;
    /** 引擎公开设置的原样读写（键语义随引擎） */
    getRaw(key: string): Promise<string | null>;
    setRaw(key: string, value: string): Promise<void>;
  };

  stats: {
    usage(from: Date, to: Date): Promise<UsageSummary>;
    /** 经营下钻（可选：引擎支持才实现）。按 from/to 日历日闭区间聚合。 */
    modelBreakdown?(from: Date, to: Date): Promise<ModelUsageStat[]>;
    customerBreakdown?(from: Date, to: Date, limit?: number): Promise<CustomerUsageStat[]>;
    customerRanking?(from: Date, to: Date, limit?: number): Promise<CustomerRanking>;
    /** 上游账户区间盈利。🔴 只吃 days(1..90，终点为今天)，不支持任意区间。 */
    accountStats?(accountId: string, days: number): Promise<AccountUsageStat>;
    /** 充值(现金到账)汇总。days 窗口终点为今天。口径=现金流入，非营收/消费。 */
    rechargeSummary?(days: number): Promise<RechargeSummary>;
    /**
     * 上游渠道"余额/可用度"（F5，可选：引擎支持才实现，adapter-newapi 未实现即 undefined）。
     * 🔴 引擎从不提供上游钱包真实余额；本方法按覆盖度返回 quota/window/none 分类（见 ChannelBalance），
     * 绝不编造余额。只读，绝不写回/砍余额。
     */
    channelBalances?(): Promise<ChannelBalance[]>;
  };
}

/**
 * 实例生命周期驱动。与 EngineAdapter 分离：
 * lifecycle 操作宿主机（docker/文件系统），adapter 操作引擎 API —— 权限面不同。
 */
export interface EngineLifecycle {
  readonly engine: EngineKind;

  /** 渲染 compose + 配置 → 起容器 → 等健康 → 初始化 admin。幂等：同 slug 重入从断点续 */
  provision(spec: SiteSpec): Promise<InstanceInfo>;
  /** 钉版本升级，失败回滚旧 image tag，数据卷不动 */
  upgrade(inst: InstanceInfo, toVersion: string): Promise<InstanceInfo>;
  stop(inst: InstanceInfo): Promise<void>;
  start(inst: InstanceInfo): Promise<void>;
  destroy(inst: InstanceInfo, opts: { keepData: boolean }): Promise<void>;
}
