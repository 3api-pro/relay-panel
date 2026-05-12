-- 012 — affiliate / reseller-to-reseller referral (v0.4 P2 #18).
--
-- Reseller A invites Reseller B (a new tenant signs up via Reseller A's
-- aff_code on the /create page). Every paid order from any of B's customers
-- credits a 10% lifetime commission to A. A can later withdraw or convert
-- to wholesale balance.
--
-- Wiring:
--   - tenant.aff_code          — 8-char identifier reseller shares (?ref=…)
--   - reseller_referral        — link row, one per referred tenant
--   - referral_withdrawal      — pending/paid payouts
--   - trg_orders_affiliate     — AFTER UPDATE on orders.status='paid'
--                                auto-credits referrer.commission_cents
--
-- Idempotent. Rollback: db/rollback/012-affiliate.sql.

-- =========================================================================
-- 1. tenant.aff_code — backfilled deterministically from id.
-- =========================================================================
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS aff_code VARCHAR(16);
UPDATE tenant
   SET aff_code = LOWER(SUBSTRING(MD5(id::text || '3api-aff') FROM 1 FOR 8))
 WHERE aff_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_aff_code ON tenant (aff_code);

-- New tenants need an aff_code too. We can't use a column DEFAULT because
-- it has to reference id (a serial generated DURING the INSERT). A BEFORE
-- INSERT trigger sets it from NEW.id; Postgres assigns serial defaults
-- before BEFORE triggers fire, so NEW.id is already populated here.
CREATE OR REPLACE FUNCTION trg_tenant_aff_code_default() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.aff_code IS NULL THEN
    NEW.aff_code := LOWER(SUBSTRING(MD5(NEW.id::text || '3api-aff') FROM 1 FOR 8));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_aff_code ON tenant;
CREATE TRIGGER trg_tenant_aff_code
  BEFORE INSERT ON tenant
  FOR EACH ROW
  EXECUTE FUNCTION trg_tenant_aff_code_default();

-- =========================================================================
-- 2. reseller_referral — A → B link.
-- =========================================================================
CREATE TABLE IF NOT EXISTS reseller_referral (
  id                  SERIAL PRIMARY KEY,
  referrer_tenant_id  INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  referred_tenant_id  INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  commission_pct      INT NOT NULL DEFAULT 10
                       CHECK (commission_pct BETWEEN 0 AND 100),
  commission_cents    BIGINT NOT NULL DEFAULT 0,
  status              VARCHAR(16) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'withdrawn')),
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referred_tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_referrer
  ON reseller_referral (referrer_tenant_id, status);

-- =========================================================================
-- 3. referral_withdrawal — payout requests.
-- =========================================================================
CREATE TABLE IF NOT EXISTS referral_withdrawal (
  id                   SERIAL PRIMARY KEY,
  referrer_tenant_id   INT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  amount_cents         BIGINT NOT NULL CHECK (amount_cents > 0),
  method               VARCHAR(32),
  account_info         TEXT,
  status               VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'paid', 'rejected')),
  note                 TEXT,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_withdrawal_referrer
  ON referral_withdrawal (referrer_tenant_id, status, requested_at DESC);

-- =========================================================================
-- 4. Trigger: AFTER UPDATE on orders → credit referrer's commission.
--
-- Fires only on the pending→paid transition (so we never double-credit
-- when the same row is touched again). Looks up an active referral keyed
-- on the order's tenant_id and adds (amount * pct / 100) cents to
-- reseller_referral.commission_cents.
--
-- We *only* accumulate on the referral row; actual payout happens via
-- the /admin/affiliate/withdraw flow, so this trigger never touches
-- wholesale_balance and never has to know about the operator's payout
-- preference.
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_calc_affiliate_commission() RETURNS TRIGGER AS $$
DECLARE
  v_pct        INT;
  v_commission BIGINT;
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS DISTINCT FROM 'paid') THEN
    SELECT commission_pct INTO v_pct
      FROM reseller_referral
     WHERE referred_tenant_id = NEW.tenant_id
       AND status = 'active'
     LIMIT 1;
    IF v_pct IS NOT NULL THEN
      v_commission := (NEW.amount_cents::BIGINT * v_pct) / 100;
      IF v_commission > 0 THEN
        UPDATE reseller_referral
           SET commission_cents = commission_cents + v_commission
         WHERE referred_tenant_id = NEW.tenant_id
           AND status = 'active';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_affiliate ON orders;
CREATE TRIGGER trg_orders_affiliate
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_calc_affiliate_commission();
