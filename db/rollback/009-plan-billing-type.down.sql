-- 009 rollback — drop plans.billing_type + its index.
-- Manual run only (the auto-runner only applies migrations/, not rollback/).

DROP INDEX IF EXISTS idx_plans_billing_type;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_billing_type_check;
ALTER TABLE plans DROP COLUMN IF EXISTS billing_type;
