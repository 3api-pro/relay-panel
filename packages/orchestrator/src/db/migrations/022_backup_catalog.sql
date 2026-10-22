BEGIN;
CREATE TABLE IF NOT EXISTS backup_runs (
  id serial PRIMARY KEY,
  storage_key text NOT NULL UNIQUE,
  database_kind text NOT NULL CHECK (database_kind IN ('pg','pglite')),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  archive_file text NOT NULL CHECK (archive_file IN ('panel.dump','panel.tar.gz')),
  bytes bigint,
  sha256 text,
  manifest_sha256 text,
  excluded_tables jsonb NOT NULL DEFAULT '[]',
  actor text NOT NULL,
  lease_token text NOT NULL,
  lease_until timestamp NOT NULL,
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  error text,
  CHECK (bytes IS NULL OR bytes > 0),
  CHECK (status <> 'succeeded' OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS backup_runs_status_id ON backup_runs(status,id);
CREATE TABLE IF NOT EXISTS backup_checks (
  id serial PRIMARY KEY,
  backup_id integer NOT NULL REFERENCES backup_runs(id),
  status text NOT NULL CHECK (status IN ('running','verified','missing','mismatch','unavailable','interrupted')),
  actor text NOT NULL,
  lease_until timestamp NOT NULL,
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  observed_bytes bigint,
  observed_sha256 text,
  detail text
);
CREATE INDEX IF NOT EXISTS backup_checks_backup_id ON backup_checks(backup_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS backup_checks_running ON backup_checks(backup_id) WHERE status='running';
COMMIT;
