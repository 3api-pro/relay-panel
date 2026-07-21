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
  UsageSummary,
  ModelUsageStat,
  CustomerUsageStat,
  CustomerRanking,
  AccountUsageStat,
  RechargeSummary,
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
  };

  groups: {
    list(): Promise<GroupRecord[]>;
    create(spec: GroupSpec): Promise<GroupRecord>;
    update(id: string, patch: Partial<GroupSpec>): Promise<GroupRecord>;
  };

  users: {
    list(query?: { search?: string; page?: number }): Promise<SiteUserRecord[]>;
    setStatus(id: string, status: 'active' | 'disabled'): Promise<void>;
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
