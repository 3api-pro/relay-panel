-- Rollback for 007 — check-in.
-- Hard drop. All historical check-in records are deleted.

DROP INDEX IF EXISTS idx_checkin_tenant_day;
DROP INDEX IF EXISTS idx_checkin_user_recent;
DROP INDEX IF EXISTS idx_checkin_unique_per_day;
DROP TABLE IF EXISTS check_in_log;
