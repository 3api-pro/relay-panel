/**
 * 后端 API 响应类型（与 orchestrator 路由契约同构，前端手工维护）。
 * 实时字段（ok/latencyMs/usage24h 等）在站点探测失败或后端旧版本时可能缺失，
 * 视图层一律可选访问。
 */

export type OperatorRole = 'root' | 'operator' | 'viewer';

/** GET /api/auth/me、POST /api/auth/login 响应 */
export interface Me {
  email: string;
  displayName: string | null;
  role: OperatorRole;
  signupMode: 'closed' | 'invite' | 'open';
}

/** 站点 24h 用量摘要（G1 快照聚合提供） */
export interface SiteUsage24h {
  requests?: number;
  tokens?: number;
  cost?: number;
  costUnit?: string;
}

/** GET /api/sites 列表项（DB 字段 + G1 实时探测字段，后者全部可选） */
export interface SiteView {
  id: number;
  slug: string;
  label: string;
  engine: string;
  version: string;
  status: string;
  managed: 'compose' | 'external' | string;
  /** 只读保险丝：true 时面板拒绝对该站的引擎写操作 */
  readonly?: boolean;
  hostPort: number;
  baseUrl: string;
  domains: string[];
  notes?: string | null;
  operatorId?: number;
  operatorEmail?: string;
  createdAt: string;
  updatedAt?: string;
  /** ---- 实时字段（G1）---- */
  ok?: boolean;
  latencyMs?: number;
  groups?: number;
  accounts?: { total: number; active: number };
  usage24h?: SiteUsage24h;
  branding?: { siteName?: string; logoUrl?: string };
  error?: string;
  activeJob?: { id: number; kind: string; status: string } | null;
}

export interface SitesResponse {
  sites: SiteView[];
  generatedAt: string;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** GET /api/alerts 行（G3） */
export interface AlertView {
  id: number;
  kind: string;
  siteId: number | null;
  siteSlug?: string | null;
  severity: AlertSeverity | string;
  title: string;
  detail?: string | null;
  status: 'open' | 'resolved' | string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string | null;
}

export interface AlertsResponse {
  alerts: AlertView[];
}

/** GET /api/sites/:slug/usage 桶（G1） */
export interface UsageBucket {
  date: string;
  requests: number;
  tokens: number;
  cost: number;
}

/** ---- 渠道市场分账账本（G2 / LedgerView 专属）---- */

/** GET /api/marketplace/ledger 明细行（tokens=prompt+completion，margin=billed-upstream） */
export interface LedgerRow {
  grantId: number;
  siteSlug: string;
  templateKey: string;
  templateTitle?: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  upstreamCost: number;
  billedCost: number;
  margin: number;
}

/** GET /api/marketplace/ledger 合计 */
export interface LedgerTotals {
  requests: number;
  tokens: number;
  upstreamCost: number;
  billedCost: number;
  margin: number;
}

export interface LedgerResponse {
  rows: LedgerRow[];
  totals: LedgerTotals;
}

/** POST /api/marketplace/ledger/import 单条补账行（source 固定 manual） */
export interface LedgerImportRow {
  periodStart: string;
  periodEnd: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  upstreamCost: number;
  billedCost: number;
  source?: string;
}

export interface LedgerImportResponse {
  imported: number;
}

// ============================================================
// 渠道市场（G2）— MarketplaceView 专属（在文件末尾 append）
// ============================================================

export type ChannelProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'gemini';
export type TemplateSource = 'byo' | 'managed';

/** GET /api/marketplace/templates 行（凭据从不出口，raw 已在后端 redact） */
export interface MarketplaceTemplate {
  id: number;
  key: string;
  title: string;
  description?: string | null;
  protocol: ChannelProtocol | string;
  models: string[];
  suggestedRatio?: number | null;
  modelMapping?: Record<string, string> | null;
  source: TemplateSource | string;
  paramsSchema?: Record<string, unknown> | null;
  enabled: boolean;
  createdAt?: string;
}

export interface MarketplaceTemplatesResponse {
  templates: MarketplaceTemplate[];
}

/** GET /api/marketplace/grants 行 / POST·DELETE grants 响应（无 apiKey/meterKeyRef） */
export interface MarketplaceGrant {
  id: number;
  siteSlug: string;
  siteLabel: string;
  templateKey: string;
  templateTitle: string;
  source: string;
  channelName: string | null;
  engineChannelId: string;
  managed: boolean;
  status: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface MarketplaceGrantsResponse {
  grants: MarketplaceGrant[];
}

/** POST /api/marketplace/grants 请求体 */
export interface GrantCreateBody {
  siteSlug: string;
  templateKey: string;
  channelName?: string;
  byo?: { baseUrl: string; apiKey: string };
  groupIds?: string[];
  priority?: number;
}

/** POST/PATCH /api/marketplace/templates 请求体（key 在 PATCH 时不可改） */
export interface TemplateWriteBody {
  key?: string;
  title: string;
  description?: string | null;
  protocol: ChannelProtocol;
  models: string[];
  suggestedRatio?: number | null;
  source: TemplateSource;
  enabled?: boolean;
}

/** GET /api/sites/:slug/groups 行（引擎分组，wizard 分组选择用） */
export interface SiteGroupOption {
  id: string;
  name: string;
  ratio?: number;
  description?: string;
}

/** 任务单步（F3/G1）：编排各阶段的执行记录 */
export interface JobStep {
  step: string;
  status: string;
  detail?: string | null;
  at: string;
}

/** GET /api/jobs 行 / GET /api/jobs/:id 的 job（F3/G1） */
export interface JobView {
  id: number;
  kind: string;
  siteId: number | null;
  slug: string;
  status: string;
  steps: JobStep[];
  error?: string | null;
  createdBy: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobsResponse {
  jobs: JobView[];
}

export interface JobResponse {
  job: JobView;
}

/** ---- 操作员 / 邀请（F2，OperatorsView 专属）---- */

/** 操作员当前订阅摘要（列表内联） */
export interface OperatorSubscription {
  planKey: string;
  currentPeriodEnd: string | null;
}

/** GET /api/operators 行（root 专属） */
export interface OperatorView {
  id: number;
  email: string;
  displayName: string | null;
  role: OperatorRole;
  status: 'active' | 'disabled' | string;
  createdAt: string;
  lastLoginAt?: string | null;
  siteCount: number;
  subscription: OperatorSubscription | null;
}

export interface OperatorsResponse {
  operators: OperatorView[];
}

/** PATCH /api/operators/:id 请求体（字段全可选，只提交变更项） */
export interface OperatorPatchBody {
  role?: OperatorRole;
  status?: 'active' | 'disabled';
  displayName?: string;
}

/** GET /api/invites 行（root，列表不含完整 token） */
export interface InviteView {
  tokenPrefix: string;
  role: OperatorRole;
  note?: string | null;
  expiresAt: string;
  usedBy?: string | null;
  usedAt?: string | null;
  createdAt: string;
}

export interface InvitesResponse {
  invites: InviteView[];
}

/** POST /api/invites 请求体 */
export interface InviteCreateBody {
  role?: OperatorRole;
  note?: string;
  ttlHours?: number;
}

/** POST /api/invites 响应：含完整一次性 token（仅此一次可见） */
export interface InviteCreatedResponse {
  token: string;
  role: OperatorRole;
  note?: string | null;
  expiresAt: string;
}

/** GET/PUT /api/settings/alerts（root · G3 告警通知设置） */
export interface AlertSettings {
  /** webhook 地址；null/'' 表示未配置（停用推送） */
  webhookUrl: string | null;
}

/** POST /api/alerts/:id/resolve 响应（G3） */
export interface AlertResolveResponse {
  ok: boolean;
  alert: AlertView;
}
