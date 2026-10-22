BEGIN;
CREATE TABLE IF NOT EXISTS finance_scopes (
 access_id integer PRIMARY KEY REFERENCES service_access(id), label text NOT NULL,
 from_day text NOT NULL, to_day text NOT NULL, channel_id text, model text,
 costs boolean NOT NULL DEFAULT false, details boolean NOT NULL DEFAULT false,
 export boolean NOT NULL DEFAULT false, review boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamp NOT NULL DEFAULT now(),
 CHECK(from_day ~ '^\d{4}-\d{2}-\d{2}$' AND to_day ~ '^\d{4}-\d{2}-\d{2}$' AND from_day<=to_day)
);
CREATE TABLE IF NOT EXISTS finance_submissions (
 id serial PRIMARY KEY, access_id integer NOT NULL REFERENCES finance_scopes(access_id), scope_version integer NOT NULL,
 report jsonb NOT NULL, note text NOT NULL, status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','accepted','returned')),
 decision text, decided_at timestamp, decided_by integer REFERENCES operators(id),
 version integer NOT NULL DEFAULT 1, created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_submissions_access ON finance_submissions(access_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS finance_submission_pending ON finance_submissions(access_id,scope_version) WHERE status='submitted';
COMMIT;
