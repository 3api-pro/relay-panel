-- 001_init: 全量初始 DDL（与 src/db/schema.ts 完全同构 —— 改任何一边必须同步另一边）
-- schema_migrations 由迁移器以 IF NOT EXISTS 先建，此处同样 IF NOT EXISTS 保持同构且不冲突

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE operators (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text,
  password_hash text,
  role text NOT NULL DEFAULT 'operator',
  status text NOT NULL DEFAULT 'active',
  last_login_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL,
  ip text,
  user_agent text
);

CREATE TABLE invites (
  token text PRIMARY KEY,
  role text NOT NULL DEFAULT 'operator',
  note text,
  created_by text NOT NULL,
  expires_at timestamp NOT NULL,
  used_by text,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id serial PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  engine text NOT NULL,
  version text NOT NULL,
  domains jsonb NOT NULL DEFAULT '[]',
  host_port integer NOT NULL,
  base_url text NOT NULL,
  data_dir text NOT NULL DEFAULT '',
  compose_project text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  managed text NOT NULL DEFAULT 'compose',
  notes text,
  credential_ref text NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- 未销毁站的 host_port 唯一（纵深防御 TOCTOU；destroyed 站不占端口故排除）
CREATE UNIQUE INDEX IF NOT EXISTS sites_host_port_active_uk ON sites(host_port) WHERE status <> 'destroyed' AND managed = 'compose';

CREATE TABLE credentials (
  ref text PRIMARY KEY,
  kind text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  rotated_at timestamp
);

CREATE TABLE audit_events (
  id serial PRIMARY KEY,
  site_id integer REFERENCES sites(id),
  actor text NOT NULL,
  action text NOT NULL,
  payload jsonb,
  ok boolean NOT NULL,
  error text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  site_id integer REFERENCES sites(id),
  slug text NOT NULL,
  payload jsonb,
  status text NOT NULL DEFAULT 'queued',
  steps jsonb NOT NULL DEFAULT '[]',
  error text,
  created_by text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp,
  finished_at timestamp
);

CREATE TABLE alerts (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  site_id integer REFERENCES sites(id),
  severity text NOT NULL,
  title text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open',
  first_seen_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  resolved_at timestamp
);

CREATE TABLE channel_templates (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  protocol text NOT NULL,
  models jsonb NOT NULL,
  suggested_ratio real,
  model_mapping jsonb,
  source text NOT NULL DEFAULT 'byo',
  params_schema jsonb,
  raw jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE channel_grants (
  id serial PRIMARY KEY,
  site_id integer NOT NULL REFERENCES sites(id),
  template_id integer NOT NULL REFERENCES channel_templates(id),
  engine_channel_id text NOT NULL,
  meter_key_ref text,
  channel_name text,
  status text NOT NULL DEFAULT 'active',
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamp NOT NULL DEFAULT now(),
  revoked_at timestamp
);

CREATE TABLE usage_ledger (
  id serial PRIMARY KEY,
  grant_id integer NOT NULL REFERENCES channel_grants(id),
  period_start timestamp NOT NULL,
  period_end timestamp NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  upstream_cost numeric(14, 6) NOT NULL DEFAULT 0,
  billed_cost numeric(14, 6) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'gateway',
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_grant_period_source_unique UNIQUE (grant_id, period_start, source)
);

CREATE TABLE plans (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  price_monthly numeric(10, 2) NOT NULL DEFAULT 0,
  site_quota integer NOT NULL,
  features jsonb,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  id serial PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  plan_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_period_end timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);

-- 种子：套餐三档
INSERT INTO plans (key, title, price_monthly, site_quota) VALUES
  ('free', '入门', 0, 1),
  ('pro', '专业', 29, 5),
  ('scale', '规模', 99, 20)
ON CONFLICT (key) DO NOTHING;
