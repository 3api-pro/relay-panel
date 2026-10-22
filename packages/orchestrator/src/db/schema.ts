import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 全量 drizzle schema（规格 §3）。与 migrations/001_init.sql 完全同构 —— 改任何一边必须同步另一边。
 * timestamp 一律 mode:'string'（团队铁律）。
 */

/** 站长（托管版=注册用户；自部署单机版=单一默认 operator） */
export const operators = pgTable('operators', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  // scrypt: "scrypt:N=16384,r=8,p=1:<salt hex>:<hash hex>"
  passwordHash: text('password_hash'),
  emailVerifiedAt: timestamp('email_verified_at', { mode: 'string' }).defaultNow(),
  mfaSecret: text('mfa_secret'),
  mfaPendingSecret: text('mfa_pending_secret'),
  mfaPendingExpiresAt: timestamp('mfa_pending_expires_at', { mode: 'string' }),
  mfaLastCounter: bigint('mfa_last_counter', { mode: 'number' }).notNull().default(-1),
  mfaRecoveryHashes: jsonb('mfa_recovery_hashes').$type<string[]>().notNull().default([]),
  role: text('role').notNull().default('operator'), // 'root' | 'operator' | 'viewer'
  status: text('status').notNull().default('active'), // 'active' | 'disabled'
  lastLoginAt: timestamp('last_login_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 登录会话；DB 只存 sha256(token) */
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  operatorId: integer('operator_id')
    .notNull()
    .references(() => operators.id),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

/** 邀请注册的一次性 token */
export const invites = pgTable('invites', {
  token: text('token').primaryKey(),
  role: text('role').notNull().default('operator'),
  note: text('note'),
  createdBy: text('created_by').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  usedBy: text('used_by'),
  usedAt: timestamp('used_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const sites = pgTable(
  'sites',
  {
    id: serial('id').primaryKey(),
    operatorId: integer('operator_id')
      .notNull()
      .references(() => operators.id),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    engine: text('engine').notNull(), // 'sub2api' | 'newapi'
    version: text('version').notNull(),
    domains: jsonb('domains').$type<string[]>().notNull().default([]),
    hostPort: integer('host_port').notNull(),
    baseUrl: text('base_url').notNull(),
    dataDir: text('data_dir').notNull().default(''),
    composeProject: text('compose_project').notNull().default(''),
    // pending | provisioning | active | stopped | failed:<step> | destroyed
    status: text('status').notNull().default('pending'),
    // 'compose'=本面板开的站(可生命周期操作) | 'external'=接管的存量站(只读生命周期)
    managed: text('managed').notNull().default('compose'),
    // true 时面板拒绝一切引擎写操作（渠道/用户/品牌/市场授权），生产存量站 dogfood 保险丝
    readonly: boolean('readonly').notNull().default(false),
    notes: text('notes'),
    credentialRef: text('credential_ref').notNull().default(''),
    createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  // host_port 唯一仅约束「面板自建的 compose 站」（纵深防御 TOCTOU：即便建站临界区
  // 互斥失效，两站也不可能同时占用同一 host_port）。external 接管站的 host_port 是
  // 自报元数据（常为 0，面板不绑定），故排除；destroyed 站不占端口亦排除。
  (t) => [
    uniqueIndex('sites_host_port_active_uk')
      .on(t.hostPort)
      .where(sql`${t.status} <> 'destroyed' AND ${t.managed} = 'compose'`),
  ],
);

/** 引擎 admin 凭据，密文存储（AES-256-GCM，见 secrets.ts），明文只在进程内存 */
export const credentials = pgTable('credentials', {
  ref: text('ref').primaryKey(),
  kind: text('kind').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { mode: 'string' }),
});

/** 所有经 adapter 的写操作与生命周期动作都落审计；payload 必须先过 redact() */
export const auditEvents = pgTable('audit_events', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').references(() => sites.id),
  actor: text('actor').notNull(), // operator email | 'system'
  action: text('action').notNull(), // e.g. 'channel.create', 'lifecycle.upgrade'
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export interface JobStep {
  step: string;
  status: string;
  detail?: string;
  at: string;
}

export const jobs = pgTable('jobs', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(), // provision|upgrade|start|stop|destroy
  siteId: integer('site_id').references(() => sites.id),
  slug: text('slug').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('queued'), // queued|running|succeeded|failed|cancelled
  steps: jsonb('steps').$type<JobStep[]>().notNull().default([]),
  error: text('error'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { mode: 'string' }),
  finishedAt: timestamp('finished_at', { mode: 'string' }),
});

/** 语义唯一：同 (kind, site_id) 最多一条 open（引擎层保证，不加 DB 约束以兼容 site_id null） */
export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(), // site_down|job_failed|channel_disabled|low_balance
  siteId: integer('site_id').references(() => sites.id),
  severity: text('severity').notNull(), // critical|warning|info
  title: text('title').notNull(),
  detail: text('detail'),
  status: text('status').notNull().default('open'), // open|resolved
  firstSeenAt: timestamp('first_seen_at', { mode: 'string' }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'string' }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { mode: 'string' }),
});

/** 渠道市场：模板 */
export const channelTemplates = pgTable('channel_templates', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  protocol: text('protocol').notNull(),
  models: jsonb('models').$type<string[]>().notNull(),
  suggestedRatio: real('suggested_ratio'),
  modelMapping: jsonb('model_mapping').$type<Record<string, string>>(),
  source: text('source').notNull().default('byo'), // byo|managed
  paramsSchema: jsonb('params_schema').$type<Record<string, unknown>>(),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const channelGrants = pgTable('channel_grants', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id')
    .notNull()
    .references(() => sites.id),
  templateId: integer('template_id')
    .notNull()
    .references(() => channelTemplates.id),
  engineChannelId: text('engine_channel_id').notNull(),
  meterKeyRef: text('meter_key_ref'), // managed 才有
  channelName: text('channel_name'),
  status: text('status').notNull().default('active'), // active|revoked
  createdBy: text('created_by').notNull().default('system'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { mode: 'string' }),
});

/** 用量账本（网关拉取 / 手工补账） */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: serial('id').primaryKey(),
    grantId: integer('grant_id')
      .notNull()
      .references(() => channelGrants.id),
    periodStart: timestamp('period_start', { mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { mode: 'string' }).notNull(),
    requests: integer('requests').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    // 金额用 numeric 保精度（real=float4 仅 7 位有效数字会舍入漂移）。
    // mode:'number' → 读出经 mapFromDriverValue=Number 归一（pglite / node-postgres 皆可能回字符串，
    // 此处统一收敛为 number），写入经 mapToDriverValue=String 精确入库，故下游类型仍是 number。
    upstreamCost: numeric('upstream_cost', { precision: 14, scale: 6, mode: 'number' })
      .notNull()
      .default(0),
    billedCost: numeric('billed_cost', { precision: 14, scale: 6, mode: 'number' })
      .notNull()
      .default(0),
    source: text('source').notNull().default('gateway'), // gateway|manual
    createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [unique('usage_ledger_grant_period_source_unique').on(t.grantId, t.periodStart, t.source)],
);

export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  title: text('title').notNull(),
  // 金额用 numeric（mode:'number' 读出归一为 number，写入精确入库）
  priceMonthly: numeric('price_monthly', { precision: 10, scale: 2, mode: 'number' })
    .notNull()
    .default(0),
  siteQuota: integer('site_quota').notNull(),
  features: jsonb('features').$type<Record<string, unknown>>(),
  active: boolean('active').notNull().default(true),
});

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  operatorId: integer('operator_id')
    .notNull()
    .references(() => operators.id),
  planKey: text('plan_key').notNull(),
  status: text('status').notNull().default('active'), // active|expired|cancelled
  currentPeriodEnd: timestamp('current_period_end', { mode: 'string' }).notNull(),
  monthlyPrice: numeric('monthly_price', { precision: 10, scale: 2, mode: 'number' }),
  pendingChange: jsonb('pending_change').$type<{
    planKey: string; monthlyPrice: number; months: number; effectiveAt: string; orderNo: string | null;
  }>(),
  // 到期提醒台账：各档（t7/t1/expiry/graceEnd）已发时间戳；续费顺延后清空重新计。
  // 幂等依据——扫描循环据此保证「同档绝不重发」。
  remindersSent: jsonb('reminders_sent').$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 收款渠道实例；config 密文存 credentials 表（enc:payment:<key>），此处只存引用 */
export const paymentProviders = pgTable('payment_providers', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(), // 'alipay' | 'wxpay' | 'usdt'
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  paymentMode: text('payment_mode').notNull().default(''), // ''|'redirect'
  configRef: text('config_ref').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 订阅购买订单。状态机：pending -> paid -> completed；终态 expired|failed|cancelled */
export const paymentOrders = pgTable('payment_orders', {
  id: serial('id').primaryKey(),
  orderNo: text('order_no').notNull().unique(),
  operatorId: integer('operator_id')
    .notNull()
    .references(() => operators.id),
  planKey: text('plan_key').notNull(),
  months: integer('months').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  providerKey: text('provider_key').notNull(),
  providerTradeNo: text('provider_trade_no'),
  providerConfigRef: text('provider_config_ref'),
  fulfillmentVersion: integer('fulfillment_version').notNull().default(0),
  reconciliationError: text('reconciliation_error'),
  lastCheckedAt: timestamp('last_checked_at', { mode: 'string' }),
  status: text('status').notNull().default('pending'),
  payUrl: text('pay_url'),
  qrCode: text('qr_code'),
  expiresAt: timestamp('expires_at', { mode: 'string' }),
  paidAt: timestamp('paid_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  billingQuote: jsonb('billing_quote').$type<import('../billing/changes.js').BillingQuote>(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

export const billingQuotes = pgTable('billing_quotes', {
  id: text('id').primaryKey(),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  quote: jsonb('quote').$type<import('../billing/changes.js').BillingQuote>().notNull(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  usedAt: timestamp('used_at', { mode: 'string' }),
});

/** 全局键值设置。已知 key: 'credential_db'(registry 导入的 credentialDb 原样 JSON)、'alert_webhook_url'({url:string})、'support_contact'({email?,url?,docsUrl?}) */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/**
 * 客户 CRM 每日快照（F4）。与 migrations/004_customer_snapshots.sql 完全同构（改一边必须同步另一边）。
 * 逐日为每站每客户落一行；相邻日 period_cost 之差=当日消耗，供消费骤降/流失侦测。
 * period_cost = 累计净消耗代理 = total_recharged - balance - frozen_balance（近似，UI 标估算）。
 * 去重键 UNIQUE(site_slug,user_id,captured_date)：每站每人每北京日历日一行（一天多次 tick 幂等只更今日）。
 * balance/frozen_balance = 客户预付余额（对客负债），与上游 channel 余额严格区分。
 */
export const customerSnapshots = pgTable(
  'customer_snapshots',
  {
    id: serial('id').primaryKey(),
    siteSlug: text('site_slug').notNull(),
    userId: integer('user_id').notNull(),
    email: text('email'),
    // 金额 numeric(14,6) mode:'number'（读出归一 number，写入精确入库），对齐 usage_ledger 口径
    balance: numeric('balance', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    frozenBalance: numeric('frozen_balance', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    totalRecharged: numeric('total_recharged', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    periodCost: numeric('period_cost', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    status: text('status'),
    // 北京日历日 'YYYY-MM-DD'（date mode:'string'）
    capturedDate: date('captured_date', { mode: 'string' }).notNull(),
    capturedAt: timestamp('captured_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_snapshots_site_user_date_uk').on(t.siteSlug, t.userId, t.capturedDate),
    index('customer_snapshots_site_user_date_idx').on(t.siteSlug, t.userId, t.capturedDate),
  ],
);

/** 迁移记账表；由 runMigrations 以 IF NOT EXISTS 先建（001_init.sql 里同样 IF NOT EXISTS） */
export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { mode: 'string' }).notNull().defaultNow(),
});

/** Only hashes of short-lived, one-use authentication tokens are stored. */
export const authTokens = pgTable('auth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  purpose: text('purpose').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('auth_tokens_owner_idx').on(t.operatorId, t.purpose)]);

/** Persistent limits survive restarts and apply across application workers. */
export const authAttempts = pgTable('auth_attempts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(1),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
});

export const notificationPreferences = pgTable('notification_preferences', {
  operatorId: integer('operator_id').primaryKey().references(() => operators.id),
  alerts: boolean('alerts').notNull().default(true),
  billing: boolean('billing').notNull().default(true),
  support: boolean('support').notNull().default(true),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  category: text('category').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  mailCiphertext: text('mail_ciphertext'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { mode: 'string' }),
  readAt: timestamp('read_at', { mode: 'string' }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('notifications_owner_idx').on(t.operatorId, t.id), index('notifications_delivery_idx').on(t.status, t.nextAttemptAt)]);

export const refundRequests = pgTable('refund_requests', {
  id: serial('id').primaryKey(),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  orderId: integer('order_id').notNull().references(() => paymentOrders.id),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('requested'),
  version: integer('version').notNull().default(1),
  note: text('note'),
  receipt: text('receipt'),
  reviewedBy: text('reviewed_by'),
  entitlement: text('entitlement'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('refund_requests_owner_idx').on(t.operatorId), uniqueIndex('refund_receipt_uk').on(t.receipt)]);

export const supportTickets = pgTable('support_tickets', {
  id: serial('id').primaryKey(),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  subject: text('subject').notNull(),
  status: text('status').notNull().default('open'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('support_tickets_owner_idx').on(t.operatorId, t.id)]);

export const supportMessages = pgTable('support_messages', {
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => supportTickets.id),
  actorId: integer('actor_id').notNull().references(() => operators.id),
  staff: boolean('staff').notNull().default(false),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const organizations = pgTable('organizations', {
  ownerId: integer('owner_id').primaryKey().references(() => operators.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});
export const organizationMembers = pgTable('organization_members', {
  id: serial('id').primaryKey(),
  ownerId: integer('owner_id').notNull().references(() => organizations.ownerId),
  operatorId: integer('operator_id').notNull().references(() => operators.id),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('organization_member_uk').on(t.ownerId, t.operatorId)]);
export const organizationInvites = pgTable('organization_invites', {
  id: serial('id').primaryKey(),
  ownerId: integer('owner_id').notNull().references(() => organizations.ownerId),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  usedAt: timestamp('used_at', { mode: 'string' }),
  revokedAt: timestamp('revoked_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id),
  fromDate: text('from_date').notNull(),
  toDate: text('to_date').notNull(),
  supplier: text('supplier').notNull(),
  invoiceRef: text('invoice_ref').notNull(),
  invoiceAmount: numeric('invoice_amount', { precision: 18, scale: 6, mode: 'number' }).notNull(),
  accountId: text('account_id'),
  status: text('status').notNull().default('scanning'),
  nextPage: integer('next_page').notNull().default(1),
  expectedRows: integer('expected_rows'),
  version: integer('version').notNull().default(1),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('reconciliation_invoice_uk').on(t.siteId, t.supplier, t.invoiceRef)]);

export const reconciliationRecords = pgTable('reconciliation_records', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull().references(() => reconciliationRuns.id),
  sourceId: text('source_id').notNull(),
  evidence: jsonb('evidence').$type<import('@relay-panel/adapter-core').UsageRecord>().notNull(),
}, t => [unique('reconciliation_record_uk').on(t.runId, t.sourceId)]);

export const historicalRates = pgTable('historical_rates', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id),
  userId: text('user_id').notNull(),
  model: text('model').notNull(),
  fromAt: timestamp('from_at', { mode: 'string' }).notNull(),
  toAt: timestamp('to_at', { mode: 'string' }).notNull(),
  multiplier: numeric('multiplier', { precision: 14, scale: 6, mode: 'number' }).notNull(),
  note: text('note').notNull(),
  voidedAt: timestamp('voided_at', { mode: 'string' }),
  voidReason: text('void_reason'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const financeReviewCases = pgTable('finance_review_cases', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id),
  sourceId: text('source_id').notNull(),
  state: text('state').notNull().default('pending'),
  version: integer('version').notNull().default(1),
  evidence: jsonb('evidence').$type<import('@relay-panel/adapter-core').UsageRecord>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull(),
  verification: text('verification').notNull().default('flagged'),
  checkedAt: timestamp('checked_at', { mode: 'string' }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('finance_review_cases_site_id_source_id_key').on(t.siteId, t.sourceId), index('finance_review_cases_state_id_idx').on(t.state, t.id)]);

export const financeReviewEvents = pgTable('finance_review_events', {
  id: serial('id').primaryKey(),
  caseId: integer('case_id').notNull().references(() => financeReviewCases.id),
  actor: text('actor').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  note: text('note').notNull(),
  evidence: jsonb('evidence').$type<import('@relay-panel/adapter-core').UsageRecord>().notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('finance_review_events_case_id_idx').on(t.caseId, t.id)]);

export const observationRuns = pgTable('observation_runs', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id), day: text('day').notNull(),
  status: text('status').notNull().default('pending'), nextPage: integer('next_page').notNull().default(1),
  generation: integer('generation').notNull().default(1), total: integer('total'), sourceScope: text('source_scope'),
  leaseUntil: timestamp('lease_until', { mode: 'string' }), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(), error: text('error'),
}, t => [unique('observation_run_day_uk').on(t.siteId, t.day)]);
export const observedRequests = pgTable('observed_requests', {
  id: serial('id').primaryKey(), runId: integer('run_id').notNull().references(() => observationRuns.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(), generation: integer('generation').notNull(),
  evidence: jsonb('evidence').$type<import('@relay-panel/adapter-core').PassiveRecord>().notNull(),
  observedAt: timestamp('observed_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('observed_request_source_uk').on(t.runId, t.sourceId), index('observed_requests_run_idx').on(t.runId, t.generation, t.id)]);
export const observationSourceRows=pgTable('observation_source_rows',{
  runId:integer('run_id').notNull().references(()=>observationRuns.id,{onDelete:'cascade'}),sourceId:text('source_id').notNull(),generation:integer('generation').notNull(),
},t=>[unique('observation_source_rows_pkey').on(t.runId,t.sourceId)]);
export const servicePartners = pgTable('service_partners', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id), kind: text('kind').notNull(),
  name: text('name').notNull(), contact: text('contact').notNull().default(''), notes: text('notes').notNull().default(''),
  status: text('status').notNull().default('active'), version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('service_partners_site_idx').on(t.siteId, t.id)]);
export const serviceWork = pgTable('service_work', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id), kind: text('kind').notNull(),
  title: text('title').notNull(), description: text('description').notNull(), status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'), version: integer('version').notNull().default(1),
  sourceId: integer('source_id').references(() => observedRequests.id, { onDelete: 'set null' }),
  evidence: jsonb('evidence').$type<import('@relay-panel/adapter-core').PassiveRecord>(),
  partnerId: integer('partner_id').references(() => servicePartners.id), ticketId: integer('ticket_id').references(() => supportTickets.id),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}), createdBy: integer('created_by').notNull().references(() => operators.id),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('service_work_site_idx').on(t.siteId, t.id)]);
export const serviceEvents = pgTable('service_events', {
  id: serial('id').primaryKey(), workId: integer('work_id').notNull().references(() => serviceWork.id), actorId: integer('actor_id').notNull().references(() => operators.id),
  status: text('status').notNull(), note: text('note').notNull(), createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});
export const servicePublications = pgTable('service_publications', {
  siteId: integer('site_id').primaryKey().references(() => sites.id), token: text('token').notNull().unique(), title: text('title').notNull(),
  body: text('body').notNull(), state: text('state').notNull().default('maintenance'), published: boolean('published').notNull().default(false),
  version: integer('version').notNull().default(1), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

export const serviceAccess = pgTable('service_access', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id),
  ownerId: integer('owner_id').notNull().references(() => operators.id), email: text('email').notNull(), role: text('role').notNull(),
  partnerId: integer('partner_id').references(() => servicePartners.id), operatorId: integer('operator_id').references(() => operators.id),
  inviteTokenHash: text('invite_token_hash').notNull().unique(), inviteExpiresAt: timestamp('invite_expires_at', {mode:'string'}).notNull(),
  expiresAt: timestamp('expires_at', {mode:'string'}).notNull(), acceptedAt: timestamp('accepted_at', {mode:'string'}),
  revokedAt: timestamp('revoked_at', {mode:'string'}), createdAt: timestamp('created_at', {mode:'string'}).notNull().defaultNow(),
}, t => [uniqueIndex('service_access_active_email').on(t.siteId,t.email).where(sql`${t.revokedAt} IS NULL`), index('service_access_operator').on(t.operatorId,t.id)]);
export const serviceAssignments = pgTable('service_assignments', {
  id: serial('id').primaryKey(), accessId: integer('access_id').notNull().references(() => serviceAccess.id),
  workId: integer('work_id').notNull().references(() => serviceWork.id), title: text('title').notNull(), brief: text('brief').notNull(),
  status: text('status').notNull().default('open'), version: integer('version').notNull().default(1), revokedAt: timestamp('revoked_at', {mode:'string'}),
  createdAt: timestamp('created_at', {mode:'string'}).notNull().defaultNow(), updatedAt: timestamp('updated_at', {mode:'string'}).notNull().defaultNow(),
}, t => [unique('service_assignment_uk').on(t.accessId,t.workId)]);
export const serviceMessages = pgTable('service_messages', {
  id: serial('id').primaryKey(), assignmentId: integer('assignment_id').notNull().references(() => serviceAssignments.id),
  actorId: integer('actor_id').notNull().references(() => operators.id), staff: boolean('staff').notNull(), body: text('body').notNull(),
  status: text('status').notNull(), createdAt: timestamp('created_at', {mode:'string'}).notNull().defaultNow(),
}, t => [index('service_messages_assignment').on(t.assignmentId,t.id)]);

export const serviceKnowledgeSpaces = pgTable('service_knowledge_spaces', {
  siteId: integer('site_id').primaryKey().references(() => sites.id), token: text('token').notNull().unique(),
  title: text('title').notNull(), description: text('description').notNull().default(''), published: boolean('published').notNull().default(false),
  version: integer('version').notNull().default(1), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});
export const serviceDocuments = pgTable('service_documents', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id), token: text('token').notNull().unique(),
  draft: jsonb('draft').$type<import('../services/knowledge-content.js').DocumentContent>().notNull(),
  published: jsonb('published').$type<import('../services/knowledge-content.js').DocumentContent>(), publishedRevision: integer('published_revision'),
  version: integer('version').notNull().default(1), publishedAt: timestamp('published_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('service_documents_site_idx').on(t.siteId, t.id)]);
export const serviceDocumentVersions = pgTable('service_document_versions', {
  id: serial('id').primaryKey(), documentId: integer('document_id').notNull().references(() => serviceDocuments.id),
  version: integer('version').notNull(), action: text('action').notNull(),
  content: jsonb('content').$type<import('../services/knowledge-content.js').DocumentContent>().notNull(),
  actorId: integer('actor_id').notNull().references(() => operators.id), createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('service_document_version_uk').on(t.documentId, t.version)]);

export const budgetPolicies = pgTable('budget_policies', {
  id: serial('id').primaryKey(), siteId: integer('site_id').notNull().references(() => sites.id), name: text('name').notNull(),
  period: text('period').notNull(), basis: text('basis').notNull(), amountUsd: numeric('amount_usd', { precision: 20, scale: 6 }).notNull(),
  warningPercent: integer('warning_percent').notNull().default(80), channelId: text('channel_id'), model: text('model'),
  enabled: boolean('enabled').notNull().default(true), notify: boolean('notify').notNull().default(false), version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('budget_policies_site_idx').on(t.siteId, t.id)]);
export const budgetEvents = pgTable('budget_events', {
  id: serial('id').primaryKey(), policyId: integer('policy_id').notNull().references(() => budgetPolicies.id), policyVersion: integer('policy_version').notNull(),
  periodStart: text('period_start').notNull(), level: integer('level').notNull(), evidence: jsonb('evidence').$type<import('../services/budgets.js').BudgetReport>().notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { mode: 'string' }), acknowledgedBy: integer('acknowledged_by').references(() => operators.id), acknowledgement: text('acknowledgement'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [unique('budget_event_threshold_uk').on(t.policyId, t.policyVersion, t.periodStart, t.level)]);

// 常用行类型（下游模块共享，避免各自重复推导）
export type OperatorRow = typeof operators.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type SiteRow = typeof sites.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type ChannelTemplateRow = typeof channelTemplates.$inferSelect;
export type ChannelGrantRow = typeof channelGrants.$inferSelect;
export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PaymentProviderRow = typeof paymentProviders.$inferSelect;
export type PaymentOrderRow = typeof paymentOrders.$inferSelect;
export type CustomerSnapshotRow = typeof customerSnapshots.$inferSelect;

export const financeScopes = pgTable('finance_scopes', {
  accessId: integer('access_id').primaryKey().references(() => serviceAccess.id), label: text('label').notNull(),
  fromDay: text('from_day').notNull(), toDay: text('to_day').notNull(), channelId: text('channel_id'), model: text('model'),
  costs: boolean('costs').notNull().default(false), details: boolean('details').notNull().default(false),
  export: boolean('export').notNull().default(false), review: boolean('review').notNull().default(false), enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1), updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});
export const financeSubmissions = pgTable('finance_submissions', {
  id: serial('id').primaryKey(), accessId: integer('access_id').notNull().references(() => financeScopes.accessId), scopeVersion: integer('scope_version').notNull(),
  report: jsonb('report').$type<import('../services/finance-access.js').SharedFinanceReport>().notNull(), note: text('note').notNull(),
  status: text('status').notNull().default('submitted'), decision: text('decision'), decidedAt: timestamp('decided_at', { mode: 'string' }),
  decidedBy: integer('decided_by').references(() => operators.id), version: integer('version').notNull().default(1), createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, t => [index('finance_submissions_access').on(t.accessId, t.id), uniqueIndex('finance_submission_pending').on(t.accessId, t.scopeVersion).where(sql`${t.status}='submitted'`)]);
