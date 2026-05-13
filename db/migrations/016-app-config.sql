-- 016-app-config.sql
-- Global runtime KV config table. Authoritative source of truth for any
-- secret/setting that env is too fragile to hold (OAuth credentials,
-- outbound proxy, third-party API keys, etc.).
--
-- Rule: anything that CAN live here MUST live here. env is reserved for
-- bootstrap-only values (DATABASE_URL, PORT, NODE_ENV).

CREATE TABLE IF NOT EXISTS app_config (
  key        varchar(64) PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
