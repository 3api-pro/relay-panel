-- Migration 005: wholesale_platform_balance
--
-- Mirror of the upstream llmapi reseller account balance (the "platform
-- floating capital" that 3api pre-pays to llmapi via the wsk-* key).
--
-- One row per process; PK enforces singleton via `id = 1`.
-- Populated by the wholesale-sync cron (every 5 min) hitting
-- ${UPSTREAM_BASE_URL}/wholesale/balance with the wsk- Bearer token.
--
-- Distinct from `wholesale_balance` (per-tenant local mirror used for
-- internal admin top-ups) — that table can drift from upstream; this
-- one is the source of truth for the platform-wide capital we have to
-- spend with llmapi.

CREATE TABLE IF NOT EXISTS wholesale_platform_balance (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_cents           BIGINT  NOT NULL DEFAULT 0,
  total_deposited_cents   BIGINT  NOT NULL DEFAULT 0,
  total_purchased_cents   BIGINT  NOT NULL DEFAULT 0,
  reseller_id             INTEGER,                      -- upstream reseller.id (informational)
  last_sync_at            TIMESTAMPTZ,
  last_sync_status        VARCHAR(32),                  -- 'ok' | 'http_error' | 'network_error' | 'unconfigured'
  last_sync_error         TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
