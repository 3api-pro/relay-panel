-- Rollback for 010 — channel fields (v0.3).
--
-- Drops the 6 added columns + the partial index + the provider_type CHECK.
-- The legacy `type`, `models`, `model_mapping`, `keys[]` columns are
-- preserved (they never moved), so post-rollback routing falls back to
-- the v0.2 path automatically.
--
-- Manual run only (the auto-runner only applies migrations/, not rollback/).

DROP INDEX IF EXISTS idx_upstream_channel_recommended;
ALTER TABLE upstream_channel DROP CONSTRAINT IF EXISTS upstream_channel_provider_type_check;

ALTER TABLE upstream_channel DROP COLUMN IF EXISTS is_recommended;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS enabled;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS last_test_result;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS last_tested_at;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS custom_headers;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS provider_type;
