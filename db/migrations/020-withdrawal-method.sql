-- 020-withdrawal-method.sql
-- Simplify withdrawal to 2 channels: domestic bank card OR Alipay (国际兼容).
-- The earlier SWIFT/IBAN/payout_country fields stay in the table (nullable)
-- so existing rows keep working, but new submissions go through one of these
-- two paths only.

ALTER TABLE withdrawal_request
  ADD COLUMN IF NOT EXISTS method varchar(16) NOT NULL DEFAULT 'bank'
    CHECK (method IN ('bank','alipay')),
  ADD COLUMN IF NOT EXISTS alipay_account varchar(255);

-- Drop the NOT NULL on card_number — for 'alipay' method, card_number is NULL.
ALTER TABLE withdrawal_request
  ALTER COLUMN card_number DROP NOT NULL;
