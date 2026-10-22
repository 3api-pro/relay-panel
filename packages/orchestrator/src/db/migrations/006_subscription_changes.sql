ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS monthly_price numeric(10,2);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_change jsonb;
-- Existing subscriptions have no historical rate snapshot. Freeze today's catalog
-- rate once; do not silently reprice their remaining term on future catalog edits.
UPDATE subscriptions s SET monthly_price=p.price_monthly FROM plans p
WHERE s.plan_key=p.key AND s.monthly_price IS NULL;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS billing_quote jsonb;
CREATE TABLE IF NOT EXISTS billing_quotes (
  id text PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  quote jsonb NOT NULL,
  expires_at timestamp NOT NULL,
  used_at timestamp
);
CREATE INDEX IF NOT EXISTS billing_quotes_expiry_idx ON billing_quotes(expires_at);
