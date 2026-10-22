-- Legacy paid orders may already have granted a subscription before a crash.
-- Keep them review-only; version 1 fulfillment is atomic and safe to retry.
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS fulfillment_version integer NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reconciliation_error text;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS last_checked_at timestamp;
CREATE INDEX IF NOT EXISTS payment_orders_reconcile_idx ON payment_orders(status, last_checked_at);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS provider_config_ref text;
