BEGIN;
CREATE TABLE IF NOT EXISTS observation_runs (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), day text NOT NULL,
 status text NOT NULL DEFAULT 'pending', next_page integer NOT NULL DEFAULT 1,
 generation integer NOT NULL DEFAULT 1, total integer, source_scope text,
 lease_until timestamp, updated_at timestamp NOT NULL DEFAULT now(), error text,
 CONSTRAINT observation_run_day_uk UNIQUE(site_id,day)
);
CREATE TABLE IF NOT EXISTS observed_requests (
 id serial PRIMARY KEY, run_id integer NOT NULL REFERENCES observation_runs(id) ON DELETE CASCADE,
 source_id text NOT NULL, generation integer NOT NULL, evidence jsonb NOT NULL,
 observed_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT observed_request_source_uk UNIQUE(run_id,source_id)
);
CREATE INDEX IF NOT EXISTS observed_requests_run_idx ON observed_requests(run_id,generation,id);
CREATE TABLE IF NOT EXISTS observation_source_rows (
 run_id integer NOT NULL REFERENCES observation_runs(id) ON DELETE CASCADE,
 source_id text NOT NULL, generation integer NOT NULL,
 PRIMARY KEY(run_id,source_id)
);
CREATE TABLE IF NOT EXISTS service_partners (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), kind text NOT NULL,
 name text NOT NULL, contact text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active', version integer NOT NULL DEFAULT 1,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_partners_site_idx ON service_partners(site_id,id);
CREATE TABLE IF NOT EXISTS service_work (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), kind text NOT NULL,
 title text NOT NULL, description text NOT NULL, status text NOT NULL DEFAULT 'open',
 priority text NOT NULL DEFAULT 'normal', version integer NOT NULL DEFAULT 1,
 source_id integer REFERENCES observed_requests(id) ON DELETE SET NULL, evidence jsonb,
 partner_id integer REFERENCES service_partners(id), ticket_id integer REFERENCES support_tickets(id),
 details jsonb NOT NULL DEFAULT '{}', created_by integer NOT NULL REFERENCES operators(id),
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_work_site_idx ON service_work(site_id,id);
CREATE TABLE IF NOT EXISTS service_events (
 id serial PRIMARY KEY, work_id integer NOT NULL REFERENCES service_work(id),
 actor_id integer NOT NULL REFERENCES operators(id), status text NOT NULL, note text NOT NULL,
 created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_publications (
 site_id integer PRIMARY KEY REFERENCES sites(id), token text NOT NULL UNIQUE,
 title text NOT NULL, body text NOT NULL, state text NOT NULL DEFAULT 'maintenance',
 published boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 updated_at timestamp NOT NULL DEFAULT now()
);
COMMIT;
