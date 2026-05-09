-- 002 — upstream_channel default + priority
--
-- Additive. Pre-existing rows get priority=100, is_default=FALSE.
-- A partial unique index enforces "at most one is_default=TRUE per tenant".
-- This is the foundation for P1 (BYOK relay): /v1/messages handlers will
-- pick the active default channel for the tenant and forward to its
-- base_url + api_key.

ALTER TABLE upstream_channel
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE upstream_channel
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;

CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_channel_one_default_per_tenant
  ON upstream_channel (tenant_id)
  WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_upstream_channel_routing
  ON upstream_channel (tenant_id, status, is_default DESC, weight DESC, priority);
