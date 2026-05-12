-- 008 — per-tenant system_setting (P1 #10).
--
-- Three orthogonal switches the reseller admin can flip from /admin
-- without touching env vars:
--   - signup_enabled       (default true)  — allow end-user signups
--   - maintenance_mode     (default false) — storefront + /v1 return 503
--   - announcement / level — top-of-store banner (info|warn|error)
--
-- One row per tenant, seeded for every existing tenant. Future tenants
-- get seeded on first GET via the service (defaults coerced).
--
-- Idempotent. Rollback: db/rollback/008-system-setting.sql.

CREATE TABLE IF NOT EXISTS system_setting (
  tenant_id            INT PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  signup_enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  maintenance_mode     BOOLEAN     NOT NULL DEFAULT FALSE,
  announcement         TEXT,
  announcement_level   VARCHAR(16) NOT NULL DEFAULT 'info'
                       CHECK (announcement_level IN ('info', 'warn', 'error')),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed defaults for any tenant that doesn't yet have a row.
INSERT INTO system_setting (tenant_id)
SELECT id FROM tenant
ON CONFLICT (tenant_id) DO NOTHING;
