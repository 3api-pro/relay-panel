-- 012 rollback — drop affiliate / referral tables, triggers, and tenant.aff_code.
-- Manual run only (the auto-runner only applies migrations/).
--
-- Order matters: triggers before tables, tables before tenant column.

DROP TRIGGER  IF EXISTS trg_orders_affiliate ON orders;
DROP TRIGGER  IF EXISTS trg_tenant_aff_code  ON tenant;
DROP FUNCTION IF EXISTS trg_calc_affiliate_commission();
DROP FUNCTION IF EXISTS trg_tenant_aff_code_default();

DROP TABLE IF EXISTS referral_withdrawal;
DROP TABLE IF EXISTS reseller_referral;

DROP INDEX IF EXISTS idx_tenant_aff_code;
ALTER TABLE tenant DROP COLUMN IF EXISTS aff_code;
