-- 004 — Email reminders / payment provider rows.
--
-- Adds:
--   * subscription.reminder_sent_at         — set when expiring-soon email goes out
--   * wholesale_balance.low_warning_sent_at — set when low-balance warning goes out
--   * usdt_payment                          — pending USDT payment intents
--   * orders.payment_meta                   — provider-specific scratch (qr_code, expected_amount...)
--
-- Idempotent. Same migration runner re-applies on every startup.
-- Rollback in db/rollback/004-email-reminders.sql (manual only).

ALTER TABLE subscription ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_subscription_reminder
  ON subscription (status, expires_at)
  WHERE reminder_sent_at IS NULL AND status = 'active';

ALTER TABLE wholesale_balance ADD COLUMN IF NOT EXISTS low_warning_sent_at TIMESTAMPTZ;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS usdt_payment (
  id                SERIAL PRIMARY KEY,
  order_id          INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tenant_id         INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  network           VARCHAR(16) NOT NULL,
  address           VARCHAR(64) NOT NULL,
  expected_amount   NUMERIC(18, 6) NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  last_checked_at   TIMESTAMPTZ,
  matched_txn       VARCHAR(128),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS idx_usdt_payment_pending
  ON usdt_payment (status, network, address)
  WHERE status = 'pending';
