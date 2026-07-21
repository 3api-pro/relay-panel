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

/** ---- 经营概览（FinanceView 专属）---- */

/** 成本来源：engine=引擎真实账户成本；ratio=成本率覆盖；null=均无 */
export type CostSource = 'engine' | 'ratio' | null;

/** GET /api/finance/summary 单站行；cost/profit 无成本口径时为 null */
export interface FinanceSummaryRow {
  slug: string;
  label: string;
  ok: boolean;
  requests: number;
  tokens: number;
  revenue: number;
  costRatio: number | null;
  costSource: CostSource;
  cost: number | null;
  profit: number | null;
  error?: string;
}

export interface FinanceTotals {
  requests: number;
  tokens: number;
  revenue: number;
  /** 仅累加已配成本率的站点 */
  cost: number;
  profit: number;
  /** 充值(现金到账)区间合计；全站取不到为 null。与营收(消费)不同口径 */
  recharge: number | null;
}

/** 走势/每日明细单日点：充值/营收(消耗)/成本/毛利/请求/token 均为该北京日历日真实值。recharge 全站无数据为 null */
export interface FinanceTrendPoint {
  date: string;
  revenue: number;
  requests: number;
  tokens: number;
  cost: number;
  profit: number;
  recharge: number | null;
}

export interface FinanceSummaryResponse {
  /** 北京日历日闭区间 YYYY-MM-DD */
  from: string;
  to: string;
  costUnit: string;
  rows: FinanceSummaryRow[];
  totals: FinanceTotals;
  /** 全部站点都有成本口径时 true（否则成本/毛利仅为部分合计） */
  allCosted: boolean;
  /** 按天走势/每日明细（已补齐区间内每一天，含充值） */
  trend: FinanceTrendPoint[];
}

/** GET/PUT /api/finance/cost-ratios */
export interface CostRatiosResponse {
  ratios: Record<string, number>;
}

/** ---- 经营下钻（FinanceView 内嵌）---- */
export type BreakdownDim = 'model' | 'customer' | 'account';

/** GET /api/finance/breakdown 单行（营收=标准计费，成本=上游账户成本，毛利=营收−成本） */
export interface FinanceBreakdownRow {
  key: string;
  label: string;
  sublabel?: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number | null;
  loss: boolean;
  requests: number;
  tokens: number;
}

export interface FinanceBreakdownResponse {
  dim: BreakdownDim;
  from?: string;
  to?: string;
  days?: number;
  rows: FinanceBreakdownRow[];
  totals: { revenue: number; cost: number; profit: number; requests: number; tokens: number };
  /** 仅 customer 维度：大客户集中度 */
  concentration?: { top3Share: number | null; count: number };
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

// ---- 批量干跑预览（POST /api/sites/batch dryRun:true）----
export type PreviewFlag = 'noop' | 'conflict' | 'blocked' | 'miss' | 'skip';

/** 一条“将会发生什么”（apiKey 绝不出现在 from/to；轮换仅以 field=apiKey 标注） */
export interface PreviewItem {
  kind: string;
  target: string;
  field?: string;
  from?: string;
  to?: string;
  flag?: PreviewFlag;
}

/** 逐站预览结果：ok=false 携 error（站不可达）；readonly 站携 blocked */
export interface BatchPreviewResult {
  slug: string;
  ok: boolean;
  blocked?: boolean;
  preview?: PreviewItem[];
  error?: string;
}

export interface BatchPreviewResponse {
  dryRun: true;
  total: number;
  ok: number;
  failed: number;
  results: BatchPreviewResult[];
}

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
  /** 告警邮箱收件人；null/'' 表示未配置（停用邮件）。需服务端配置 RP_SMTP_* 才实际发信 */
  alertEmailTo: string | null;
}

/** POST /api/alerts/:id/resolve 响应（G3） */
export interface AlertResolveResponse {
  ok: boolean;
  alert: AlertView;
}
