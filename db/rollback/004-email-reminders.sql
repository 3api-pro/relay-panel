-- 004 rollback — manual only. Run with psql, not the migration runner.
--
-- Usage:
--   docker exec -i 3api-postgres psql -U admin -d relay_panel_3api < 004-email-reminders.sql

BEGIN;

DROP TABLE IF EXISTS usdt_payment CASCADE;

ALTER TABLE IF EXISTS orders            DROP COLUMN IF EXISTS payment_meta;
ALTER TABLE IF EXISTS wholesale_balance DROP COLUMN IF EXISTS low_warning_sent_at;
ALTER TABLE IF EXISTS subscription      DROP COLUMN IF EXISTS reminder_sent_at;

DROP INDEX IF EXISTS idx_subscription_reminder;
DROP INDEX IF EXISTS idx_usdt_payment_pending;

COMMIT;
