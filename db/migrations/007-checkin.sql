-- 007 — daily check-in (P1 #15).
--
-- Log per check-in: amount of reward + the streak length that produced it.
-- Reward goes to subscription.remaining_tokens (handled by service), but
-- we still log reward_cents=0 column for future cash-style rewards.
--
-- Idempotent. Rollback: db/rollback/007-checkin.sql.
--
-- Per-tenant checkin config lives in tenant.config JSONB, key 'checkin':
--   { enabled: bool,
--     reward_tokens_per_day: int,         -- base reward
--     streak_bonus_tokens: int,           -- extra at day 7, 14, 21 ...
--     bonus_every_n_days: int }           -- defaults to 7

CREATE TABLE IF NOT EXISTS check_in_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     INT       NOT NULL REFERENCES tenant(id)  ON DELETE CASCADE,
  end_user_id   INT       NOT NULL REFERENCES end_user(id) ON DELETE CASCADE,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The DATE bucket the check-in counts towards (server UTC). Stored
  -- explicitly so unique constraints and look-ups don't depend on
  -- DATE(checked_at) immutability concerns.
  check_date    DATE      NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  reward_cents  INT       NOT NULL DEFAULT 0,
  reward_tokens BIGINT    NOT NULL DEFAULT 0,
  streak_days   INT       NOT NULL DEFAULT 1
);

-- One check-in per user per UTC day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_unique_per_day
  ON check_in_log (end_user_id, check_date);

-- Histogram / history listing.
CREATE INDEX IF NOT EXISTS idx_checkin_user_recent
  ON check_in_log (end_user_id, check_date DESC);

-- Tenant-level reporting.
CREATE INDEX IF NOT EXISTS idx_checkin_tenant_day
  ON check_in_log (tenant_id, check_date DESC);
