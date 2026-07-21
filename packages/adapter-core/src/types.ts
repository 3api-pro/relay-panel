/**
 * 引擎无关的领域类型。所有 adapter 把各引擎的概念映射到这里。
 * 映射不了的引擎私有能力走 capability flag + `raw` 透传，不污染公共类型。
 */

export type EngineKind = 'sub2api' | 'newapi';

/** 一个站的期望规格（provision 的输入） */
export interface SiteSpec {
  /** 全局唯一站点标识，用作 compose project 名、数据目录名 */
  slug: string;
  engine: EngineKind;
  /** 引擎版本（image tag / release 版本号），'latest' 禁止 —— 必须钉版本 */
  version: string;
  /** 站点对外域名（可多个，第一个为主域名） */
  domains: string[];
  /** 分配的宿主机端口（引擎 HTTP 入口） */
  hostPort: number;
  /** 数据库接入：编排器负责在共享 PG/MySQL 上建库，或每站独立容器 */
  database: DatabaseSpec;
  /** 初始 admin 账号（密码由编排器生成，加密入库，不回显） */
  adminEmail: string;
  /** 站点品牌初始化（名称、公告等），provision 第 5 步写入 */
  branding?: SiteBranding;
}

export interface DatabaseSpec {
  mode: 'shared' | 'dedicated';
  /** shared 模式：既有 DB 服务器 DSN（不含库名）；dedicated：由 provisioner 起容器 */
  serverDsn?: string;
  dbName: string;
}

export interface SiteBranding {
  siteName: string;
  logoUrl?: string;
  announcement?: string;
}

/** provision 的产物：定位一个活着的实例所需的一切（凭据除外，凭据走 CredentialRef） */
export interface InstanceInfo {
  siteSlug: string;
  engine: EngineKind;
  version: string;
  /** 编排器访问引擎的内部地址（不经公网域名） */
  baseUrl: string;
  dataDir: string;
  composeProject: string;
  /** 指向编排器凭据库的引用，adapter 经 CredentialStore 解密使用 */
  credentialRef: string;
}

/** 凭据解析回调 —— 由 orchestrator 注入，adapter 永不落盘/打印凭据 */
export interface CredentialStore {
  resolve(ref: string): Promise<EngineCredential>;
}

export interface EngineCredential {
  kind: 'admin-password' | 'admin-token' | 'jwt-secret';
  /** 语义随 kind：密码 / 长期token / 用于自签JWT的secret材料 */
  secret: string;
  adminEmail?: string;
  extra?: Record<string, string>;
}

export interface HealthReport {
  ok: boolean;
  httpOk: boolean;
  dbOk?: boolean;
  version?: string;
  latencyMs?: number;
  detail?: string;
}

// ---------- admin 面 ----------

/** 引擎无关的渠道抽象（渠道市场注入的落点） */
export interface ChannelSpec {
  name: string;
  /** 上游协议 */
  protocol: 'anthropic' | 'openai' | 'openai-responses' | 'gemini';
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** 模型重定向映射（对外模型名 -> 上游模型名） */
  modelMapping?: Record<string, string>;
  /** 所属分组（引擎语义各异，adapter 负责映射/建组） */
  groups?: string[];
  priority?: number;
  weight?: number;
  /** 引擎私有字段透传（如 sub2api 的 responses_supported） */
  raw?: Record<string, unknown>;
}

export interface ChannelRecord extends ChannelSpec {
  id: string;
  enabled: boolean;
  apiKey: '<redacted>' | string;
}

export interface ChannelTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string;
}

export interface GroupSpec {
  name: string;
  /** 倍率 */
  ratio: number;
  description?: string;
  raw?: Record<string, unknown>;
}

export interface GroupRecord extends GroupSpec {
  id: string;
}

export interface SiteUserRecord {
  id: string;
  email?: string;
  username?: string;
  role: 'admin' | 'user';
  balance?: number;
  status: 'active' | 'disabled';
}

/**
 * CRM 专用客户记录（F4 客户 CRM + 流失预警）。比 SiteUserRecord 富：含余额/冻结/累计充值/
 * 创建与活跃时间/订阅标记，供客户资产·活跃·流失分析与每日快照使用。
 * 🔴 balance/frozenBalance = 客户预付余额（对客钱包负债，站点结算货币口径，本行业 USD:RMB 1:1），
 *    与上游 channel balance（渠道账户余额）严格区分，绝不混用。
 * 纯新增导出，绝不改动既有 SiteUserRecord（users.list / UsersTab 仍用它）。
 */
export interface SiteCustomerRecord {
  userId: number;
  email?: string;
  username?: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  /** 客户预付余额（对客负债），全字段可选：引擎未返回即缺省 */
  balance?: number;
  /** 冻结余额（进行中订单占用等） */
  frozenBalance?: number;
  /** 累计充值（现金到账合计） */
  totalRecharged?: number;
  /** 账号创建时间（引擎原样时间串，可能为 ISO） */
  createdAt?: string;
  /** 最近活跃（登录/请求）时间 */
  lastActiveAt?: string;
  /** API key 最近使用时间 */
  lastUsedAt?: string;
  /** 是否持有站内订阅（需 includeSubscriptions 拉取时才可靠填充） */
  hasSubscription?: boolean;
}

export interface UsageSummary {
  /** 统计窗口 */
  from: Date;
  to: Date;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** 引擎记账货币口径由 adapter 归一为字符串说明 */
  costUnit: string;
  /** 对客计费额（用户被扣费用，对客价）——运营视角即营收流水 */
  cost: number;
  /**
   * 上游账户实际成本（引擎按上游账户计费口径记账的真实 COGS）。
   * 引擎不提供该口径时为 undefined（此时成本需由上层用成本率估算）。
   */
  accountCost?: number;
  byModel?: Record<string, { requests: number; tokens: number; cost: number }>;
}

/**
 * 经营下钻通用口径：revenue=实际扣费（actual_cost，客户钱包真实扣走=消费流水=真实营收，含分组倍率）；
 * cost=上游账户实际成本（真实 COGS）；actualCost=同 revenue（保留原始字段）。
 */
export interface ModelUsageStat {
  model: string;
  requests: number;
  tokens: number;
  revenue: number;
  actualCost: number;
  cost: number;
}

/** 单客户用量+盈利（口径同 ModelUsageStat） */
export interface CustomerUsageStat {
  userId: number;
  email: string;
  requests: number;
  tokens: number;
  revenue: number;
  actualCost: number;
  cost: number;
}

/** 客户消费榜单行（引擎 users-ranking 仅 actualCost 口径） */
export interface CustomerRankingItem {
  userId: number;
  email: string;
  actualCost: number;
  requests: number;
  tokens: number;
}
export interface CustomerRanking {
  items: CustomerRankingItem[];
  totalActualCost: number;
  totalRequests: number;
  totalTokens: number;
}

/** 充值(现金到账)单日点。amount 为站点结算货币(llmapi 系为 RMB)，非 USD。 */
export interface RechargePoint {
  date: string;
  amount: number;
  count: number;
}
/** 充值汇总（源 sub2api payment/dashboard，days 窗口终点为今天）。amount 口径=现金到账，非营收/消费。 */
export interface RechargeSummary {
  todayAmount: number;
  todayCount: number;
  daily: RechargePoint[];
}

/**
 * 上游渠道(账户)区间用量+盈利。revenue=实际扣费(total_user_cost，与其它维度同口径)，cost=账号口径成本(total_cost)。
 * 🔴 引擎按 days 取（1..90，窗口终点固定为今天），不支持任意 from/to 闭区间。
 */
export interface AccountUsageStat {
  requests: number;
  tokens: number;
  revenue: number;
  cost: number;
  avgDailyCost: number;
  days: number;
}

/**
 * 上游渠道"余额/可用度"读模型（F5）。
 * 🔴 引擎【从不】提供上游钱包真实余额；本类型是能拿到的最接近口径，按覆盖度分三类：
 *  - kind='quota'：apikey/bedrock 类型，管理员手配的额度上限 quotaLimit(USD) 与已用 quotaUsed(USD)，
 *    remaining = quotaLimit − quotaUsed 是【真实可用额度】。
 *  - kind='window'：Anthropic OAuth/号池，仅有 5h 窗口成本闸 windowCostLimit(USD，非余额，无池总额)→零余额口径。
 *  - kind='none'：零覆盖（无 quota 上限、无窗口闸），只能靠账号口径日均消耗估算，绝不编造余额。
 * accountType=引擎账户 type 原样字符串(apikey|bedrock|oauth|setup_token…)，enabled=账户是否启用。
 */
export interface ChannelBalance {
  id: string;
  name: string;
  /** 引擎账户 type 原样字符串（apikey/bedrock/oauth/setup_token…） */
  accountType: string;
  enabled: boolean;
  /** 余额口径：quota=真实额度上限；window=仅窗口成本闸(非余额)；none=零覆盖 */
  kind: 'quota' | 'window' | 'none';
  /** kind='quota' 时的额度上限(USD，管理员手配) */
  quotaLimit?: number;
  /** kind='quota' 时的已用额度(USD) */
  quotaUsed?: number;
  /** kind='window' 时的 5h 窗口成本上限(USD，非余额，不可当撑几天算) */
  windowCostLimit?: number;
}

// ---------- 平台限额（风控护栏 F3；user × platform 粒度，日/周/月窗口）----------

/**
 * 单窗口限额状态（读模型）。金额单位 USD。
 *  - usageUsd：当前窗口已用量（USD）。
 *  - limitUsd：窗口上限（USD）；null=不限。
 *  - resetsAt：窗口重置时刻（引擎原样时间串，可能为 ISO）。
 */
export interface QuotaWindowState {
  usageUsd: number;
  limitUsd: number | null;
  resetsAt?: string;
}

/**
 * 平台限额读模型（GET /users/:id/platform-quotas 映射）：某平台的日/周/月三窗口用量与上限。
 * platform ∈ 引擎允许集合（如 anthropic/openai/gemini/codex/grok）。
 */
export interface PlatformQuota {
  platform: string;
  daily: QuotaWindowState;
  weekly: QuotaWindowState;
  monthly: QuotaWindowState;
}

/**
 * 平台限额写模型（PUT /users/:id/platform-quotas —— 🔴【全量替换】该用户所有平台限额，
 * 缺失的 platform 会被软删）。每窗口 limit 语义：
 *   undefined/null = 不限；0 = 完全禁用；>0 = USD 上限。金额单位 USD。
 * 调用方必须先 getPlatformQuotas 合并（保留未涉及 platform 与同 platform 其它窗口）再写回。
 */
export interface PlatformQuotaInput {
  platform: string;
  dailyLimitUsd?: number | null;
  weeklyLimitUsd?: number | null;
  monthlyLimitUsd?: number | null;
}

// ---------- capability ----------

export interface EngineCapabilities {
  /** 用户侧个人访问令牌（sub2api >= 0.1.158） */
  userAccessTokens: boolean;
  /** 多分组 API key */
  multiGroupKeys: boolean;
  /** anthropic 原生协议分发 */
  anthropicNative: boolean;
  /** 站内订阅/套餐计费 */
  subscriptionBilling: boolean;
}
