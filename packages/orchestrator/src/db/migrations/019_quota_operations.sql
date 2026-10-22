BEGIN;
CREATE TABLE IF NOT EXISTS quota_operations (
 id serial PRIMARY KEY,
 site_id integer NOT NULL REFERENCES sites(id), actor_id integer NOT NULL REFERENCES operators(id),
 user_id text NOT NULL CHECK(user_id ~ '^[1-9][0-9]{0,18}$'),
 site_fingerprint text NOT NULL,
 change jsonb NOT NULL, before_limits jsonb NOT NULL, requested_limits jsonb NOT NULL,
 observed jsonb,
 status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','applying','verified','conflict','uncertain','failed','resolved')),
 detail text NOT NULL DEFAULT '', resolution_note text,
 expires_at timestamp NOT NULL, started_at timestamp, checked_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS quota_operation_inflight ON quota_operations(site_id,user_id) WHERE status IN ('applying','uncertain');
CREATE INDEX IF NOT EXISTS quota_operation_history ON quota_operations(site_id,id);
COMMIT;
