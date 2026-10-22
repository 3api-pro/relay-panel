BEGIN;
CREATE TABLE IF NOT EXISTS budget_policies (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), name text NOT NULL,
 period text NOT NULL CHECK(period IN ('day','week','month')), basis text NOT NULL CHECK(basis IN ('charge','supplierCost')),
 amount_usd numeric(20,6) NOT NULL CHECK(amount_usd > 0), warning_percent integer NOT NULL DEFAULT 80 CHECK(warning_percent BETWEEN 1 AND 99),
 channel_id text, model text, enabled boolean NOT NULL DEFAULT true, notify boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_policies_site_idx ON budget_policies(site_id,id);
CREATE TABLE IF NOT EXISTS budget_events (
 id serial PRIMARY KEY, policy_id integer NOT NULL REFERENCES budget_policies(id), policy_version integer NOT NULL,
 period_start text NOT NULL, level integer NOT NULL CHECK(level BETWEEN 1 AND 100), evidence jsonb NOT NULL,
 acknowledged_at timestamp, acknowledged_by integer REFERENCES operators(id), acknowledgement text,
 created_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT budget_event_threshold_uk UNIQUE(policy_id,policy_version,period_start,level)
);
COMMIT;
