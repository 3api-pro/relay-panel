-- 006 — upstream_channel multi-key support (P1 #14).
--
-- Add a JSONB array `keys` (each entry: {key, status, added_at,
-- cooled_until?, last_error?}) plus `current_key_idx` for cheap
-- round-robin. The existing single `api_key` column is preserved as a
-- legacy fallback for any code path that has not been updated yet, and
-- as the soft-migration target: existing rows are backfilled so keys[0]
-- mirrors api_key.
--
-- Idempotent. Rollback: db/rollback/006-channel-multi-keys.sql (manual).

ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS keys             JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS current_key_idx  INT   NOT NULL DEFAULT 0;

-- Backfill: any row that has an api_key but an empty keys[] gets
-- keys[0] = api_key. Status defaults to 'active'; cooled_until null;
-- added_at = now (ISO 8601 string for JSON friendliness).
UPDATE upstream_channel
   SET keys = jsonb_build_array(
              jsonb_build_object(
                'key',          api_key,
                'status',       'active',
                'added_at',     to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'cooled_until', NULL,
                'last_error',   NULL
              )
            )
 WHERE (keys IS NULL OR keys = '[]'::jsonb)
   AND api_key IS NOT NULL
   AND api_key <> '';
