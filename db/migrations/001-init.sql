-- 3API Relay Panel — initial schema
-- Compatible with PostgreSQL 14+ and SQLite 3.40+ (with minor type differences)
-- For SQLite: BIGSERIAL → INTEGER PRIMARY KEY AUTOINCREMENT, JSONB → TEXT, etc.

-- =====================================================
-- 1. tenant — multi-tenant isolation root
-- =====================================================
CREATE TABLE IF NOT EXISTS tenant (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(64) UNIQUE NOT NULL,
  custom_domain VARCHAR(255) UNIQUE,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  branding      JSONB,
  config        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- single-tenant mode: insert default tenant id=1
INSERT INTO tenant (id, slug, status) VALUES (1, 'default', 'active')
  ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- 2. reseller_admin — panel owner accounts
-- =====================================================
CREATE TABLE IF NOT EXISTS reseller_admin (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(100),
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

-- =====================================================
-- 3. end_user — reseller's customers
-- =====================================================
CREATE TABLE IF NOT EXISTS end_user (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email             VARCHAR(255) NOT NULL,
  password_hash     VARCHAR(255),
  display_name      VARCHAR(100),
  group_name        VARCHAR(32) NOT NULL DEFAULT 'default',
  quota_cents       BIGINT NOT NULL DEFAULT 0,
  used_quota_cents  BIGINT NOT NULL DEFAULT 0,
  aff_code          VARCHAR(32) UNIQUE,
  inviter_id        INT,
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_end_user_tenant ON end_user (tenant_id, status);

-- =====================================================
-- 4. end_token — API keys end-users get
-- =====================================================
CREATE TABLE IF NOT EXISTS end_token (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  end_user_id         INT NOT NULL REFERENCES end_user(id) ON DELETE CASCADE,
  name                VARCHAR(100) NOT NULL DEFAULT 'Default',
  key_prefix          VARCHAR(16) NOT NULL,
  key_hash            VARCHAR(64) NOT NULL,
  remain_quota_cents  BIGINT NOT NULL DEFAULT 0,
  unlimited_quota     BOOLEAN NOT NULL DEFAULT FALSE,
  used_quota_cents    BIGINT NOT NULL DEFAULT 0,
  allowed_models      TEXT,
  expires_at          TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'active',
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (key_prefix, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_end_token_lookup ON end_token (key_prefix, key_hash, status);
CREATE INDEX IF NOT EXISTS idx_end_token_user   ON end_token (tenant_id, end_user_id, status);

-- =====================================================
-- 5. upstream_channel — upstream API providers
-- =====================================================
CREATE TABLE IF NOT EXISTS upstream_channel (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  base_url      VARCHAR(255) NOT NULL DEFAULT 'https://api.llmapi.pro/wholesale/v1',
  api_key       TEXT,
  type          VARCHAR(32) NOT NULL DEFAULT 'wholesale-3api',
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  weight        INT NOT NULL DEFAULT 100,
  models        TEXT,
  model_mapping JSONB,
  group_access  TEXT NOT NULL DEFAULT 'default',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upstream_tenant ON upstream_channel (tenant_id, status);

-- =====================================================
-- 6. redemption — top-up codes
-- =====================================================
CREATE TABLE IF NOT EXISTS redemption (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code          VARCHAR(64) UNIQUE NOT NULL,
  quota_cents   BIGINT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'unused',
  redeemed_by   INT REFERENCES end_user(id) ON DELETE SET NULL,
  redeemed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_redemption_tenant_status ON redemption (tenant_id, status);

-- =====================================================
-- 7. usage_log — per-request usage records
-- =====================================================
CREATE TABLE IF NOT EXISTS usage_log (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  end_user_id         INT,
  end_token_id        INT,
  channel_id          INT,
  model_name          VARCHAR(100),
  prompt_tokens       INT NOT NULL DEFAULT 0,
  completion_tokens   INT NOT NULL DEFAULT 0,
  quota_charged_cents BIGINT NOT NULL DEFAULT 0,
  request_id          VARCHAR(64),
  elapsed_ms          INT,
  is_stream           BOOLEAN NOT NULL DEFAULT FALSE,
  status              VARCHAR(20) NOT NULL DEFAULT 'success',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_created ON usage_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_end_user      ON usage_log (end_user_id, created_at DESC) WHERE end_user_id IS NOT NULL;

-- =====================================================
-- 8. subscription — optional monthly sub per end-user
-- =====================================================
CREATE TABLE IF NOT EXISTS subscription (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  end_user_id   INT NOT NULL REFERENCES end_user(id) ON DELETE CASCADE,
  plan_name     VARCHAR(32) NOT NULL,
  upstream_sub_id INT,
  upstream_token TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  period_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end    TIMESTAMPTZ NOT NULL,
  is_primary    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_user ON subscription (end_user_id, status);
