import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/** 站长（托管版=注册用户；自部署单机版=单一默认 operator） */
export const operators = pgTable('operators', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});

export const sites = pgTable('sites', {
  id: serial('id').primaryKey(),
  operatorId: integer('operator_id')
    .notNull()
    .references(() => operators.id),
  slug: text('slug').notNull().unique(),
  engine: text('engine').notNull(), // 'sub2api' | 'newapi'
  version: text('version').notNull(),
  domains: jsonb('domains').$type<string[]>().notNull().default([]),
  hostPort: integer('host_port').notNull(),
  baseUrl: text('base_url').notNull(),
  dataDir: text('data_dir').notNull(),
  composeProject: text('compose_project').notNull(),
  // provision 状态机: pending -> provisioning:<step> -> active | failed:<step> | destroyed
  status: text('status').notNull().default('pending'),
  credentialRef: text('credential_ref').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

/** 引擎 admin 凭据，密文存储（libsodium sealed box），明文只在进程内存 */
export const credentials = pgTable('credentials', {
  ref: text('ref').primaryKey(),
  kind: text('kind').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { mode: 'string' }),
});

/** 所有经 adapter 的写操作与生命周期动作都落审计 */
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

/** 渠道市场：模板（P2 填充，先立表） */
export const channelTemplates = pgTable('channel_templates', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  title: text('title').notNull(),
  protocol: text('protocol').notNull(),
  models: jsonb('models').$type<string[]>().notNull(),
  paramsSchema: jsonb('params_schema').$type<Record<string, unknown>>(),
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
  meterKeyRef: text('meter_key_ref').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
});
