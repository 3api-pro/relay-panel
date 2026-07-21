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

/** GET/PUT /api/settings/finance-report（root · F2 经营报告配置） */
export interface FinanceReportConfig {
  /** 收件人邮箱；留空 = 回落告警邮箱 alert_email_to。须服务端配置 RP_SMTP_* 才实际发信 */
  recipients: string[];
  /** 毛利率阈值（0..1）：毛利率低于此值触发 margin_low 告警 */
  marginLowPct: number;
  /** 成本环比倍数（>=1）：当期/上期成本高于此倍数触发 cost_spike 告警 */
  costSpikeFactor: number;
  /** 日报开关 */
  daily: boolean;
  /** 周报开关 */
  weekly: boolean;
}

/** POST /api/finance/report/test 响应（root · F2 立即发送测试报告；不占用当日发送标记） */
export interface FinanceReportTestResponse {
  /** 是否至少送达一位收件人 */
  sent: boolean;
  /** 实际成功送达的收件人数（< recipients 表示部分投递失败） */
  sentCount: number;
  /** 目标收件人数（含回落告警邮箱） */
  recipients: number;
  /** 报告纯文本前若干行，供 UI 预览 */
  preview: string;
}

// ============================================================
// 风控 / 异常消费告警 + 限额护栏（F3，RiskView 专属 · root only）
// ============================================================

/** 骤增侦测规则（存 app_settings['risk_rules']，root 可编辑） */
export interface RiskRules {
  /** 骤增倍率：近期日消费 / 基线日均 ≥ 此值判骤增 */
  spikeMultiplier: number;
  /** 绝对下限（USD）：近期消费须 ≥ 此值才告警 */
  absFloorUsd: number;
  /** 基线天数：取近 N 日均值作基线 */
  baselineDays: number;
}

/** GET/PUT /api/risk/rules 响应（enforce=写回开关快照，前端每次读实时值，勿缓存） */
export interface RiskRulesResponse {
  rules: RiskRules;
  /** RP_RISK_ENFORCE=on 时 true；false=仅告警模式（写回按钮禁用） */
  enforce: boolean;
}

/** POST /api/risk/scan 骤增行（金额 USD；ratio=null 表示无基线/新增大额消费者） */
export interface RiskSpikeRow {
  siteSlug: string;
  siteLabel: string;
  userId: number;
  email: string;
  /** 近期窗口消费（USD） */
  recentCost: number;
  /** 基线日均消费（USD） */
  baselineDaily: number;
  /** 近期/基线倍数；null=无基线（新增） */
  ratio: number | null;
}

export interface RiskScanResponse {
  spikes: RiskSpikeRow[];
  enforce: boolean;
  costUnit: string;
}

export type QuotaWindow = 'daily' | 'weekly' | 'monthly';

/** 平台限额窗口状态（USD；limitUsd null=不限） */
export interface QuotaWindowState {
  usageUsd: number;
  limitUsd: number | null;
  resetsAt?: string;
}

/** 平台限额读模型（per-platform 三窗口） */
export interface PlatformQuota {
  platform: string;
  daily: QuotaWindowState;
  weekly: QuotaWindowState;
  monthly: QuotaWindowState;
}

/** 平台限额写模型（PUT 全量替换输入；limit null=不限/0=禁用/>0=USD 上限） */
export interface PlatformQuotaInput {
  platform: string;
  dailyLimitUsd?: number | null;
  weeklyLimitUsd?: number | null;
  monthlyLimitUsd?: number | null;
}

/** POST /api/risk/users/:slug/:userId/quota-preview 响应（GET-合并预览，不写） */
export interface QuotaPreviewResponse {
  platform: string;
  window: QuotaWindow;
  /** 当前全量限额 */
  current: PlatformQuota[];
  /** 合并后将写回的全量输入（仅 enforce=on 时才会实际 PUT） */
  merged: PlatformQuotaInput[];
  enforce: boolean;
  costUnit: string;
}

// ---------------------------------------------------------------------------
// 客户 CRM + 流失预警（F4；与 orchestrator/src/customers/routes.ts 返回同构，前端手工维护）
// ---------------------------------------------------------------------------

/** 分层：大/中/小 R */
export type CustomerTier = 'big' | 'mid' | 'small';
/** 流失理由：无活跃 / 消费骤降 */
export type ChurnReason = 'inactive' | 'spend_drop';

/** CRM 配置（分层门槛 + 流失阈值；金额 USD） */
export interface CustomerCrmConfig {
  tierBigUsd: number;
  tierMidUsd: number;
  churnInactiveDays: number;
  dropWindowDays: number;
  dropThresholdPct: number;
  minSnapshotDays: number;
  churnAlertsEnabled: boolean;
}

/** 单客户 CRM 行（余额=客户预付负债，USD；与上游 channel 余额无关） */
export interface CustomerCrmRow {
  /** 跨站不合并唯一键 siteSlug:userId（table row-key） */
  key: string;
  siteSlug: string;
  siteLabel: string;
  userId: number;
  email: string | null;
  balance: number;
  frozenBalance: number;
  totalRecharged: number;
  status: 'active' | 'disabled';
  lastActiveAt: string | null;
  lastUsedAt: string | null;
  tier: CustomerTier;
  windowSpend: number;
  dailySpendRecent: number;
  dailySpendPrior: number;
  dropPct: number;
  churnRisk: boolean;
  churnReasons: ChurnReason[];
  hasSubscription: boolean;
  enoughHistory: boolean;
}

export interface CustomerTotals {
  customers: number;
  /** 负债合计=Σbalance（🔴 跨站同一人重复计，USD） */
  liabilityTotal: number;
  tierBig: number;
  tierMid: number;
  tierSmall: number;
  churnCount: number;
  subscriptionCount: number;
}

/** 降级站（无 listAll 引擎 / 连不上）——从聚合剔除 */
export interface CustomerDegradedSite {
  siteSlug: string;
  siteLabel: string;
  reason: string;
}

export interface CustomersResponse {
  generatedAt: string;
  config: CustomerCrmConfig;
  /** 已积累快照天数；< minSnapshotDays 时提示需继续积累 */
  snapshotDaysAvailable: number;
  rows: CustomerCrmRow[];
  totals: CustomerTotals;
  degradedSites: CustomerDegradedSite[];
  costUnit: string;
}

// ============================================================
// 上游渠道余额 + 低余额预警 + 快捷充值（F5，ChannelBalanceView 专属 · root only）
// ============================================================

/** 单渠道余额/可用度行（与 orchestrator upstream/service.ts 的 ChannelBalanceView 同构）
 * 🔴 kind=quota 才有真实额度(quotaLimit/quotaUsed/remaining/daysLeft)；window/none 只有估算(avgDailyCost/windowCostLimit)，daysLeft 恒 null。 */
export interface ChannelBalanceView {
  id: string;
  name: string;
  accountType: string;
  enabled: boolean;
  kind: 'quota' | 'window' | 'none';
  /** 覆盖度：exact=有真实额度；estimate=仅窗口估算；none=零覆盖/站点降级 */
  coverage: 'exact' | 'estimate' | 'none';
  quotaLimit?: number;
  quotaUsed?: number;
  /** 剩余可用额度(USD)，仅 quota 型有 */
  remaining?: number;
  windowCostLimit?: number;
  /** 账号口径日均消耗(USD) */
  avgDailyCost?: number;
  /** 还能撑几天：仅 quota 且 avgDailyCost>0 才有；window/none 恒 null（不编造） */
  daysLeft?: number | null;
  /** 低余额红标：仅 quota 型可 true */
  low?: boolean;
  siteSlug: string;
  siteLabel: string;
  siteOk: boolean;
}

/** 覆盖度汇总 */
export interface UpstreamCoverage {
  withQuota: number;
  windowOnly: number;
  zeroCoverage: number;
  degradedSites: number;
}

/** GET /api/upstream/balances 响应 */
export interface UpstreamBalancesResponse {
  days: number;
  /** channel_low_balance 告警阈值(USD)；0=告警关闭 */
  thresholdUsd: number;
  costUnit: string;
  /** 快捷充值/重置写是否启用（RP_UPSTREAM_RESET_ENABLED）；false 时前端不展示/禁用重置动作 */
  resetEnabled?: boolean;
  coverage: UpstreamCoverage;
  rows: ChannelBalanceView[];
}

/** POST /api/upstream/channels/:slug/:channelId/reset-quota 请求体 */
export interface ResetQuotaRequest {
  /** 确认令牌：必须精确等于目标渠道名（防误点/跨渠道错 id） */
  confirm: string;
  /** 返回行的窗口天数（算 daysLeft，1..90，默认与当前页窗口一致） */
  days?: number;
}

/** POST reset-quota 响应（row=重置后该渠道最新对客视图行，重读失败为 null） */
export interface ResetQuotaResponse {
  ok: boolean;
  channelId: string;
  channelName: string;
  quotaUsedBefore: number;
  quotaUsedAfter: number;
  costUnit: string;
  row: ChannelBalanceView | null;
}

/** 充值外链条目 */
export interface RechargeLink {
  label: string;
  url: string;
  note?: string;
}

/** GET/PUT /api/upstream/recharge-links 响应 */
export interface RechargeLinksResponse {
  links: RechargeLink[];
}
