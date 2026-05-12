-- 009 — plans.billing_type: subscription vs token_pack
--
-- v0.3 dual-track billing. Major asks from resellers ("我能不能上 token 包,
-- 不要包月"). Competitors (new-api / sub2api) all do both. Two flavours:
--
--   subscription : monthly recurring; remaining_tokens reset each period
--                  (in practice — we never auto-renew, every order is a
--                  fresh subscription). period_days = 30/90/365.
--   token_pack   : one-shot top-up. period_days conceptually "permanent";
--                  we still store an expires_at (3650d = ~10y) for index
--                  consistency. remaining_tokens just counts down.
--
-- Migration is additive + idempotent (default 'subscription' so all extant
-- rows fall into the old behaviour with zero change). Reverse migration in
-- db/rollback/009-plan-billing-type.down.sql.
--
-- /v1/messages debit logic is repointed in src/middleware/auth-token.ts +
-- src/services/order-engine.ts: pre-debit gate sums ALL active subs for the
-- end_user, recordUsage debits oldest-expires-first across them. So a user
-- with both a subscription and a token_pack burns the subscription first
-- (closer expiry) then the token_pack (far expiry). Same path; no per-row
-- flag needed at debit time.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS billing_type VARCHAR(16) NOT NULL DEFAULT 'subscription';

-- Constraint pinned post-add so retries against pre-existing tables are safe.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_billing_type_check;
ALTER TABLE plans
  ADD CONSTRAINT plans_billing_type_check
  CHECK (billing_type IN ('subscription', 'token_pack'));

-- Backfill any historical NULL (column NOT NULL so this is belt+suspenders).
UPDATE plans SET billing_type = 'subscription' WHERE billing_type IS NULL OR billing_type = '';

-- Index for storefront catalog ordering (split by type).
CREATE INDEX IF NOT EXISTS idx_plans_billing_type ON plans (tenant_id, billing_type, sort_order)
  WHERE enabled = TRUE;
