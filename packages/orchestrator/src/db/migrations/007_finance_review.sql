-- Additive only: old releases continue serving during migration.
CREATE TABLE IF NOT EXISTS finance_review_cases (
  id serial PRIMARY KEY,
  site_id integer NOT NULL REFERENCES sites(id),
  source_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reviewing','confirmed','explained','resolved')),
  version integer NOT NULL DEFAULT 1,
  evidence jsonb NOT NULL,
  fingerprint text NOT NULL,
  reasons jsonb NOT NULL,
  verification text NOT NULL DEFAULT 'flagged' CHECK (verification IN ('flagged','clear','unavailable')),
  checked_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(site_id, source_id)
);
CREATE INDEX IF NOT EXISTS finance_review_cases_state_id_idx ON finance_review_cases(state, id);
CREATE TABLE IF NOT EXISTS finance_review_events (
  id serial PRIMARY KEY,
  case_id integer NOT NULL REFERENCES finance_review_cases(id),
  actor text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  note text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_review_events_case_id_idx ON finance_review_events(case_id, id);
