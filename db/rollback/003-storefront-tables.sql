-- 003 rollback — manual only. Run with psql, not the migration runner.
-- DROPs in reverse FK order. Drops ADD COLUMNs last (non-destructive: those
-- are nullable / NOT NULL with default so dropping them removes data).
--
-- Usage:
--   docker exec -i 3api-postgres psql -U admin -d relay_panel_3api < 003-storefront-tables.rollback.sql

BEGIN;

-- Remove added FKs first
ALTER TABLE IF EXISTS orders DROP CONSTRAINT IF EXISTS orders_coupon_id_fkey;

-- Drop tables that reference subscription / orders / plans
DROP TABLE IF EXISTS coupon       CASCADE;
DROP TABLE IF EXISTS refund       CASCADE;
DROP TABLE IF EXISTS brand_config CASCADE;

-- Drop added columns on existing tables
ALTER TABLE IF EXISTS usage_log    DROP COLUMN IF EXISTS subscription_id;
ALTER TABLE IF EXISTS end_token    DROP COLUMN IF EXISTS subscription_id;
ALTER TABLE IF EXISTS end_user     DROP COLUMN IF EXISTS reset_token_expires_at;
ALTER TABLE IF EXISTS end_user     DROP COLUMN IF EXISTS reset_token;
ALTER TABLE IF EXISTS end_user     DROP COLUMN IF EXISTS verify_token_expires_at;
ALTER TABLE IF EXISTS end_user     DROP COLUMN IF EXISTS verify_token;
ALTER TABLE IF EXISTS end_user     DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE IF EXISTS subscription DROP COLUMN IF EXISTS remaining_tokens;
ALTER TABLE IF EXISTS subscription DROP COLUMN IF EXISTS expires_at;
ALTER TABLE IF EXISTS subscription DROP COLUMN IF EXISTS order_id;
ALTER TABLE IF EXISTS subscription DROP COLUMN IF EXISTS plan_id;

-- Drop new tables
DROP TABLE IF EXISTS orders            CASCADE;
DROP TABLE IF EXISTS wholesale_balance CASCADE;
DROP TABLE IF EXISTS plans             CASCADE;

COMMIT;
