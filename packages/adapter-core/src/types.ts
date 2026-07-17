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

export interface UsageSummary {
  /** 统计窗口 */
  from: Date;
  to: Date;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** 引擎记账货币口径由 adapter 归一为字符串说明 */
  costUnit: string;
  cost: number;
  byModel?: Record<string, { requests: number; tokens: number; cost: number }>;
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
