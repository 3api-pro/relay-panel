BEGIN;
CREATE TABLE IF NOT EXISTS service_access (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), owner_id integer NOT NULL REFERENCES operators(id),
 email text NOT NULL, role text NOT NULL CHECK(role IN ('supplier','reseller','operations','support','finance')),
 partner_id integer REFERENCES service_partners(id), operator_id integer REFERENCES operators(id),
 invite_token_hash text NOT NULL UNIQUE, invite_expires_at timestamp NOT NULL, expires_at timestamp NOT NULL,
 accepted_at timestamp, revoked_at timestamp, created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_access_active_email ON service_access(site_id,email) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS service_access_operator ON service_access(operator_id,id);
CREATE TABLE IF NOT EXISTS service_assignments (
 id serial PRIMARY KEY, access_id integer NOT NULL REFERENCES service_access(id), work_id integer NOT NULL REFERENCES service_work(id),
 title text NOT NULL, brief text NOT NULL, status text NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','in_progress','waiting','submitted','accepted','closed')),
 version integer NOT NULL DEFAULT 1, revoked_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT service_assignment_uk UNIQUE(access_id,work_id)
);
CREATE TABLE IF NOT EXISTS service_messages (
 id serial PRIMARY KEY, assignment_id integer NOT NULL REFERENCES service_assignments(id),
 actor_id integer NOT NULL REFERENCES operators(id), staff boolean NOT NULL, body text NOT NULL,
 status text NOT NULL, created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_messages_assignment ON service_messages(assignment_id,id);
COMMIT;
