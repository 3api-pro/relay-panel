-- 021-funds-holder.sql
-- Tracks WHO holds the funds for each paid order:
--   'tenant'   — reseller's own merchant account collected directly (3api never
--                touches the money; wallet_balance stays 0 for this order)
--   'platform' — platform's own merchant collected on behalf of reseller; 3api
--                credits reseller's wallet_balance, reseller withdraws later
--
-- Default 'tenant' for safety (older rows assume reseller-owned, no double-
-- crediting via retroactive wallet entries).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS funds_holder varchar(16) NOT NULL DEFAULT 'tenant'
    CHECK (funds_holder IN ('tenant','platform'));

CREATE INDEX IF NOT EXISTS idx_orders_funds_holder_paid
  ON orders(funds_holder, paid_at DESC)
  WHERE status = 'paid' OR status = 'paid_pending_provision';
