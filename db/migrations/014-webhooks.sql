-- 014 - Webhook system (v0.5).
--
-- Per-tenant outbound webhook with HMAC-signed POST. Events fire on:
--   - order.paid           (PG trigger on orders.status UPDATE)
--   - subscription.expired (PG trigger on subscription.status UPDATE)
--   - refund.processed     (dispatchEvent from refund route)
--   - wholesale.low        (dispatchEvent from wholesale_low cron)
--
-- Retry worker (src/services/webhook-worker.ts) ticks every 30s, scans
-- webhook_delivery for status IN ('pending','failed') AND next_retry_at <= NOW(),
-- attempts delivery with exponential backoff (1min, 5min, 30min, max 3 retries).
--
-- Idempotent. Rollback: db/rollback/014-webhooks.down.sql.

-- =========================================================================
-- 1. webhook - per-tenant subscription
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  secret             VARCHAR(128) NOT NULL,
  events             JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  last_triggered_at  TIMESTAMPTZ,
  fail_count_total   INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook (tenant_id) WHERE enabled = TRUE;

-- =========================================================================
-- 2. webhook_delivery - per-event row, retry state machine
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id                BIGSERIAL PRIMARY KEY,
  webhook_id        INT NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
  event_type        VARCHAR(64) NOT NULL,
  payload           JSONB NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  http_status       INT,
  response_excerpt  TEXT,
  attempts          INT NOT NULL DEFAULT 0,
  next_retry_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_pending
  ON webhook_delivery (next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_hook
  ON webhook_delivery (webhook_id, id DESC);

-- =========================================================================
-- 3. Trigger - orders.status -> 'paid' fires order.paid event
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_webhook_order_paid() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS DISTINCT FROM 'paid') THEN
    INSERT INTO webhook_delivery (webhook_id, event_type, payload, next_retry_at)
    SELECT w.id, 'order.paid',
           jsonb_build_object(
             'event_type', 'order.paid',
             'order_id',   NEW.id,
             'tenant_id',  NEW.tenant_id,
             'end_user_id',NEW.end_user_id,
             'plan_id',    NEW.plan_id,
             'amount_cents', NEW.amount_cents,
             'currency',   NEW.currency,
             'payment_provider', NEW.payment_provider,
             'provider_txn_id', NEW.provider_txn_id,
             'paid_at',    NEW.paid_at,
             'timestamp',  EXTRACT(EPOCH FROM NOW())::bigint
           ),
           NOW()
      FROM webhook w
     WHERE w.tenant_id = NEW.tenant_id
       AND w.enabled = TRUE
       AND w.events @> '"order.paid"'::jsonb;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_webhook ON orders;
CREATE TRIGGER trg_orders_webhook
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_webhook_order_paid();

-- =========================================================================
-- 4. Trigger - subscription.status -> 'expired' fires subscription.expired
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_webhook_subscription_expired() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'expired' AND (OLD.status IS DISTINCT FROM 'expired') THEN
    INSERT INTO webhook_delivery (webhook_id, event_type, payload, next_retry_at)
    SELECT w.id, 'subscription.expired',
           jsonb_build_object(
             'event_type', 'subscription.expired',
             'subscription_id', NEW.id,
             'tenant_id', NEW.tenant_id,
             'end_user_id', NEW.end_user_id,
             'plan_id', NEW.plan_id,
             'plan_name', NEW.plan_name,
             'period_end', NEW.period_end,
             'expires_at', NEW.expires_at,
             'timestamp', EXTRACT(EPOCH FROM NOW())::bigint
           ),
           NOW()
      FROM webhook w
     WHERE w.tenant_id = NEW.tenant_id
       AND w.enabled = TRUE
       AND w.events @> '"subscription.expired"'::jsonb;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscription_webhook ON subscription;
CREATE TRIGGER trg_subscription_webhook
  AFTER UPDATE OF status ON subscription
  FOR EACH ROW EXECUTE FUNCTION trg_webhook_subscription_expired();
