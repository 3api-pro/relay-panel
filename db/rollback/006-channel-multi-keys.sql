-- Rollback for 006 — channel multi-keys.
-- Drops the added columns. The legacy api_key column is preserved
-- (it never moved), so post-rollback all routing falls back to the
-- single-key path automatically.

ALTER TABLE upstream_channel DROP COLUMN IF EXISTS keys;
ALTER TABLE upstream_channel DROP COLUMN IF EXISTS current_key_idx;
