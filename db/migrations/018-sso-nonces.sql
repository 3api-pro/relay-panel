-- 018-sso-nonces.sql
-- One-time nonce ledger for cross-system SSO tokens (llmapi -> 3api etc.).
-- Each SSO token carries a 64-hex nonce; the receiving side INSERTs into
-- this table inside the same transaction that mints the session, so any
-- second use of the same token hits the PRIMARY KEY conflict and is
-- rejected as replay.
--
-- A cron-style cleanup can DELETE rows older than ~1h (token TTL is 5min).

CREATE TABLE IF NOT EXISTS sso_nonces (
  nonce       char(64) PRIMARY KEY,
  source      varchar(32) NOT NULL DEFAULT 'llmapi',
  consumed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_nonces_consumed
  ON sso_nonces(consumed_at);
