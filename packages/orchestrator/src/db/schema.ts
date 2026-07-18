import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
  status: text('status').notNull().default('pending'),
  payUrl: text('pay_url'),
  qrCode: text('qr_code'),
  expiresAt: timestamp('expires_at', { mode: 'string' }),
  paidAt: timestamp('paid_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 全局键值设置。已知 key: 'credential_db'(registry 导入的 credentialDb 原样 JSON)、'alert_webhook_url'({url:string})、'support_contact'({email?,url?,docsUrl?}) */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 迁移记账表；由 runMigrations 以 IF NOT EXISTS 先建（001_init.sql 里同样 IF NOT EXISTS） */
export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { mode: 'string' }).notNull().defaultNow(),
});

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
