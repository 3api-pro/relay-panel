-- 015-google-sub.sql
-- Add google_sub binding to reseller_admin so Google OAuth (admin login)
-- can resolve a returning user by their Google subject id.
-- Email-based lookup remains the fallback for first-time linking.

ALTER TABLE reseller_admin
  ADD COLUMN IF NOT EXISTS google_sub varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_admin_google_sub
  ON reseller_admin(google_sub)
  WHERE google_sub IS NOT NULL;
