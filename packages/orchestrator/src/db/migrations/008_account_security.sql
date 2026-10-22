ALTER TABLE operators ADD COLUMN IF NOT EXISTS email_verified_at timestamp DEFAULT now();
ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_secret text;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_pending_secret text;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_pending_expires_at timestamp;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_last_counter bigint NOT NULL DEFAULT -1;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_recovery_hashes jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash text PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  purpose text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_owner_idx ON auth_tokens(operator_id, purpose);
CREATE TABLE IF NOT EXISTS auth_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 1,
  expires_at timestamp NOT NULL
);
