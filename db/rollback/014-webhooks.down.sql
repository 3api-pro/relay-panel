-- 014 rollback - drop webhook system tables, triggers, functions.
-- Manual run only.

DROP TRIGGER  IF EXISTS trg_subscription_webhook ON subscription;
DROP TRIGGER  IF EXISTS trg_orders_webhook       ON orders;
DROP FUNCTION IF EXISTS trg_webhook_subscription_expired();
DROP FUNCTION IF EXISTS trg_webhook_order_paid();

DROP INDEX    IF EXISTS idx_webhook_delivery_hook;
DROP INDEX    IF EXISTS idx_webhook_delivery_pending;
DROP TABLE    IF EXISTS webhook_delivery;

DROP INDEX    IF EXISTS idx_webhook_tenant;
DROP TABLE    IF EXISTS webhook;
