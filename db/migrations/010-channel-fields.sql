-- 010 — upstream_channel new-api parity fields (v0.3).
--
-- Adds 6 columns + 1 backfill rule to bring our channel admin to new-api /
-- sub2api parity AND to surface the 3api unfair advantage: the built-in
-- llmapi.pro wholesale upstream. The reseller picks "use recommended" in
-- onboarding and we route through that channel without them ever having
-- to source an API key.
--
-- Columns:
--   provider_type    — protocol selector (anthropic / openai / gemini / ...).
--                      Independent of legacy `type` column (which keeps the
--                      byok-* / wholesale-3api taxonomy). upstream.ts looks
--                      at this first to pick the right protocol adapter.
--   custom_headers   — JSON object merged into the outbound request headers.
--                      Useful for x-api-key style auth or org/project IDs.
--   last_tested_at   — populated by POST /admin/channels/:id/test.
--   last_test_result — { ok, latency_ms, error?, models? } from the test.
--   enabled          — soft on/off independent of status. status='disabled'
--                      hides from listings; enabled=false hides only from
--                      routing. Allows "park but keep configured".
--   is_recommended   — flagged for the platform-default channel. UI surfaces
--                      these in the Hero card. Backfilled below for any row
--                      pointing at llmapi.pro.
--
-- Already present (from 001 / 006): models TEXT, model_mapping JSONB,
-- priority INT, is_default BOOL, keys JSONB[], current_key_idx INT.
--
-- Idempotent. Rollback: db/rollback/010-channel-fields.sql.

ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS provider_type   VARCHAR(32) NOT NULL DEFAULT 'anthropic';
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS custom_headers  JSONB       NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS last_tested_at  TIMESTAMPTZ;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS last_test_result JSONB;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS enabled         BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS is_recommended  BOOLEAN     NOT NULL DEFAULT FALSE;

-- Enum constraint pinned post-add so retries against pre-existing rows are safe.
ALTER TABLE upstream_channel DROP CONSTRAINT IF EXISTS upstream_channel_provider_type_check;
ALTER TABLE upstream_channel
  ADD CONSTRAINT upstream_channel_provider_type_check
  CHECK (provider_type IN (
    'anthropic',
    'openai',
    'gemini',
    'moonshot',
    'deepseek',
    'minimax',
    'qwen',
    'llmapi-wholesale',
    'custom'
  ));

-- Backfill: rows currently typed 'wholesale-3api' map to provider_type
-- 'llmapi-wholesale' (Anthropic-compatible body, llmapi.pro as the wholesale
-- upstream). Rows pointing at api.llmapi.pro also get flagged is_recommended
-- so the Hero card surfaces them.
UPDATE upstream_channel
   SET provider_type = 'llmapi-wholesale'
 WHERE type = 'wholesale-3api'
   AND provider_type = 'anthropic'; -- only the default backfill

UPDATE upstream_channel
   SET is_recommended = TRUE
 WHERE (base_url LIKE '%llmapi.pro%' OR base_url LIKE '%api.llmapi.pro%')
   AND is_recommended = FALSE;

-- Index for the Hero card lookup: "show me the recommended channel(s)
-- for this tenant, ordered by priority". Cheap partial.
CREATE INDEX IF NOT EXISTS idx_upstream_channel_recommended
  ON upstream_channel (tenant_id, priority)
  WHERE is_recommended = TRUE;
