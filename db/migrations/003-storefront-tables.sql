-- 003 — Storefront tables: plans, orders, wholesale_balance, brand_config,
--                         refund, coupon  +  additive columns on existing
--                         subscription / end_user / end_token / usage_log
--
-- Idempotent. The migration runner re-applies on every startup.
-- Rollback in 003-storefront-tables.rollback.sql (manual run only).
--
-- Naming note: existing tables use singular form (tenant, end_user, end_token,
-- usage_log, subscription). New tables follow the same convention.

-- =====================================================
-- 1. plans  — SKU catalog per tenant
-- =====================================================
CREATE TABLE IF NOT EXISTS plans (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name                        VARCHAR(64)  NOT NULL,
  slug                        VARCHAR(32)  NOT NULL,
  period_days                 INT          NOT NULL,
  quota_tokens                BIGINT       NOT NULL,
  price_cents                 INT          NOT NULL,
  wholesale_face_value_cents  INT          NOT NULL,
  allowed_models              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  enabled                     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order                  INT          NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_plans_tenant ON plans (tenant_id, enabled, sort_order);

-- =====================================================
-- 2. wholesale_balance  — reseller balance with upstream (local mirror)
-- =====================================================
CREATE TABLE IF NOT EXISTS wholesale_balance (
  tenant_id     INT PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- 3. orders  — end-user purchase records
-- =====================================================
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT NOT NULL REFERENCES tenant(id)   ON DELETE CASCADE,
  end_user_id       INT NOT NULL REFERENCES end_user(id) ON DELETE CASCADE,
  plan_id           INT NOT NULL REFERENCES plans(id),
  amount_cents      INT NOT NULL,
  currency          VARCHAR(8)  NOT NULL DEFAULT 'CNY',
  payment_provider  VARCHAR(32),
  provider_txn_id   VARCHAR(128),
  status            VARCHAR(24) NOT NULL DEFAULT 'pending',
  idempotency_key   VARCHAR(128) UNIQUE,
  coupon_id         INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at           TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant    ON orders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_end_user  ON orders (end_user_id, created_at DESC);

-- =====================================================
-- 4. subscription  — extend with plan/order linkage + token remaining
-- =====================================================
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS plan_id          INT REFERENCES plans(id);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS order_id         INT REFERENCES orders(id);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS expires_at       TIMESTAMPTZ;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS remaining_tokens BIGINT;
CREATE INDEX IF NOT EXISTS idx_subscription_tenant ON subscription (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_subscription_plan   ON subscription (plan_id, status);

-- =====================================================
-- 5. end_user  — verification / reset tokens (additive)
-- =====================================================
ALTER TABLE end_user ADD COLUMN IF NOT EXISTS email_verified_at       TIMESTAMPTZ;
ALTER TABLE end_user ADD COLUMN IF NOT EXISTS verify_token            VARCHAR(64);
ALTER TABLE end_user ADD COLUMN IF NOT EXISTS verify_token_expires_at TIMESTAMPTZ;
ALTER TABLE end_user ADD COLUMN IF NOT EXISTS reset_token             VARCHAR(64);
ALTER TABLE end_user ADD COLUMN IF NOT EXISTS reset_token_expires_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_end_user_verify_token ON end_user (verify_token) WHERE verify_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_end_user_reset_token  ON end_user (reset_token)  WHERE reset_token  IS NOT NULL;

-- =====================================================
-- 6. end_token  — link to subscription
-- =====================================================
ALTER TABLE end_token ADD COLUMN IF NOT EXISTS subscription_id INT REFERENCES subscription(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_end_token_subscription ON end_token (subscription_id) WHERE subscription_id IS NOT NULL;

-- =====================================================
-- 7. usage_log  — link to subscription
-- =====================================================
ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS subscription_id INT REFERENCES subscription(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_usage_log_subscription ON usage_log (subscription_id, created_at DESC) WHERE subscription_id IS NOT NULL;

-- =====================================================
-- 8. brand_config
-- =====================================================
CREATE TABLE IF NOT EXISTS brand_config (
  tenant_id      INT PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  store_name     VARCHAR(64),
  logo_url       TEXT,
  primary_color  VARCHAR(16) NOT NULL DEFAULT '#6366f1',
  announcement   TEXT,
  footer_html    TEXT,
  contact_email  VARCHAR(128),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- 9. refund
-- =====================================================
CREATE TABLE IF NOT EXISTS refund (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tenant_id     INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  amount_cents  INT NOT NULL,
  reason        TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  refunded_by   VARCHAR(32),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refunded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refund_tenant ON refund (tenant_id, status, created_at DESC);

-- =====================================================
-- 10. coupon
-- =====================================================
CREATE TABLE IF NOT EXISTS coupon (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code            VARCHAR(32) NOT NULL,
  discount_pct    INT,
  discount_cents  INT,
  max_uses        INT,
  used_count      INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_coupon_tenant ON coupon (tenant_id, enabled);

-- =====================================================
-- 11. orders.coupon_id FK — wired after coupon table exists
-- =====================================================
-- Use information_schema instead of DO block (heredoc-safe)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_coupon_id_fkey;
ALTER TABLE orders
  ADD CONSTRAINT orders_coupon_id_fkey
  FOREIGN KEY (coupon_id) REFERENCES coupon(id) ON DELETE SET NULL;
