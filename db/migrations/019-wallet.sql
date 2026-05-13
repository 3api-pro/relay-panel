-- 019-wallet.sql
-- Platform wallet for reseller monetization. Money flows:
--
--   1. end_user pays an order on tenant's storefront (alipay/usdt/paddle/creem)
--   2. payment webhook -> wallet_transaction(type='order_credit', delta_cents>0)
--      and wallet_balance.balance_cents += delta_cents
--   3. reseller can use the balance for:
--        a) `topup_llmapi` — internal transfer to their llmapi sub (no fee)
--        b) `withdrawal` — apply for bank-card payout, 3% fee, T+1 manual
--      both consume balance via additional wallet_transaction rows
--
-- DESIGN PRINCIPLES:
--   * append-only ledger (wallet_transaction is never UPDATE/DELETE'd —
--     refunds/reversals add NEGATIVE rows, never mutate originals)
--   * idempotency_key UNIQUE per (tenant_id) prevents double-credit on
--     duplicate webhooks
--   * locked_cents tracks money on-hold for pending withdrawals so two
--     concurrent withdrawals can't overdraw
--   * balance_cents is denormalised cache of SUM(delta_cents); a periodic
--     reconcile job (deferred) can compare the two

CREATE TABLE IF NOT EXISTS wallet_balance (
  tenant_id      integer PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  balance_cents  bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  locked_cents   bigint NOT NULL DEFAULT 0 CHECK (locked_cents >= 0),
  currency       varchar(8) NOT NULL DEFAULT 'CNY',
  updated_at     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transaction (
  id               bigserial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  delta_cents      bigint NOT NULL,
  -- type ∈ {
  --   order_credit          (positive: end_user paid an order)
  --   order_refund          (negative: order refunded after credit)
  --   topup_llmapi          (negative: balance applied to user's llmapi sub)
  --   withdrawal_hold       (negative: balance locked for pending withdrawal)
  --   withdrawal_release    (positive: rejected withdrawal returns hold)
  --   withdrawal_fee        (negative: 3% platform fee on approved withdrawal)
  --   withdrawal_paid       (negative: bank payout completed; fee NOT included)
  --   adjustment            (manual platform adjustment, requires admin user)
  -- }
  type             varchar(32) NOT NULL,
  idempotency_key  varchar(128),
  reference        varchar(128),   -- e.g. order_id, withdrawal_id, llmapi_topup_id
  note             text,
  created_by       varchar(64) NOT NULL DEFAULT 'system',
  ip               varchar(64),
  created_at       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_idem
  ON wallet_transaction(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_tenant_time
  ON wallet_transaction(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_reference
  ON wallet_transaction(reference)
  WHERE reference IS NOT NULL;

-- Withdrawal request lifecycle.
CREATE TABLE IF NOT EXISTS withdrawal_request (
  id                bigserial PRIMARY KEY,
  tenant_id         integer NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  requested_by      integer NOT NULL REFERENCES reseller_admin(id) ON DELETE CASCADE,
  -- gross_cents = amount the reseller asked for (the locked balance)
  -- fee_cents   = 3% of gross_cents, kept by platform
  -- net_cents   = gross - fee, what we wire to the bank
  gross_cents       bigint NOT NULL CHECK (gross_cents > 0),
  fee_cents         bigint NOT NULL CHECK (fee_cents >= 0),
  net_cents         bigint NOT NULL CHECK (net_cents > 0),
  currency          varchar(8) NOT NULL DEFAULT 'CNY',
  -- payout details (filled by reseller; international supported)
  cardholder_name   varchar(100) NOT NULL,
  bank_name         varchar(100),
  card_number       varchar(64) NOT NULL,
  swift_code        varchar(32),
  iban              varchar(64),
  payout_country    varchar(8),
  contact_email     varchar(255),
  -- email confirmation step
  confirm_code_hash varchar(64),
  confirmed_at      timestamp with time zone,
  -- platform side
  status            varchar(20) NOT NULL DEFAULT 'pending_confirm'
                    CHECK (status IN ('pending_confirm','pending','approved','rejected','paid','cancelled')),
  platform_note     text,
  approved_by       varchar(64),
  approved_at       timestamp with time zone,
  paid_at           timestamp with time zone,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_tenant_status
  ON withdrawal_request(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_pending
  ON withdrawal_request(status, created_at)
  WHERE status IN ('pending','approved');

-- Cross-system topup ledger (3api -> llmapi). The actual llmapi-side
-- subscription extension happens via an HTTPS call to llmapi's internal
-- topup endpoint; this table records the 3api side for audit + idempotency.
CREATE TABLE IF NOT EXISTS llmapi_topup_request (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  requested_by    integer NOT NULL REFERENCES reseller_admin(id) ON DELETE CASCADE,
  llmapi_user_id  integer NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  plan_slug       varchar(32) NOT NULL,
  llmapi_order_id varchar(128),
  status          varchar(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','succeeded','failed','reversed')),
  err_short       varchar(255),
  idempotency_key varchar(128) UNIQUE,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  succeeded_at    timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_llmapi_topup_tenant
  ON llmapi_topup_request(tenant_id, created_at DESC);
