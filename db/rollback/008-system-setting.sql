-- Rollback for 008 — system_setting.
-- Hard drop. Once rolled back, storefront/v1 will not honour maintenance
-- mode or signup_enabled and the cached middleware will silently fall
-- back to "always open" (see services/system-setting.ts catch path).

DROP TABLE IF EXISTS system_setting;
