-- 013 — Phase-2 per-tenant shadow sk-relay-* metadata (v0.5).
--
-- We track which provisioning "phase" a recommended channel was minted
-- under, plus the shadow-purchase metadata returned by llmapi.pro. That
-- way the platform admin can see (a) which tenants are on the shared
-- wsk- (phase 1, costs nothing) vs an isolated sk-relay-* (phase 2,
-- ~¥29/tenant) and (b) when each phase-2 sk- expires so we can renew
-- before the upstream stops honouring it.
--
-- All columns are optional and nullable so the application code can keep
-- running on a stock schema if this migration hasn't been applied.
-- The provisioner stores the same metadata in custom_headers JSONB as
-- a no-migration-required fallback path.
--
-- Idempotent.

ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ;
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS provision_phase    VARCHAR(16);
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS shadow_purchase_id VARCHAR(64);
ALTER TABLE upstream_channel ADD COLUMN IF NOT EXISTS shadow_expires_at  TIMESTAMPTZ;

-- Backfill — every existing recommended llmapi-wholesale row was minted
-- under phase-1 (shared platform wsk-).
UPDATE upstream_channel
   SET provision_phase = 'phase1'
 WHERE provision_phase IS NULL
   AND provider_type = 'llmapi-wholesale'
   AND is_recommended = TRUE;

CREATE INDEX IF NOT EXISTS idx_upstream_provision_phase
  ON upstream_channel (provision_phase)
  WHERE provision_phase IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upstream_shadow_expires
  ON upstream_channel (shadow_expires_at)
  WHERE shadow_expires_at IS NOT NULL;
