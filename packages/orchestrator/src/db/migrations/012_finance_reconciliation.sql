CREATE TABLE IF NOT EXISTS reconciliation_runs (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id),
 from_date text NOT NULL, to_date text NOT NULL, supplier text NOT NULL,
 invoice_ref text NOT NULL, invoice_amount numeric(18,6) NOT NULL CHECK(invoice_amount >= 0),
 account_id text, status text NOT NULL DEFAULT 'scanning', next_page integer NOT NULL DEFAULT 1,
 expected_rows integer, version integer NOT NULL DEFAULT 1, note text NOT NULL,
 created_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT reconciliation_invoice_uk UNIQUE(site_id,supplier,invoice_ref)
);
CREATE TABLE IF NOT EXISTS reconciliation_records (
 id serial PRIMARY KEY, run_id integer NOT NULL REFERENCES reconciliation_runs(id),
 source_id text NOT NULL, evidence jsonb NOT NULL,
 CONSTRAINT reconciliation_record_uk UNIQUE(run_id,source_id)
);
CREATE TABLE IF NOT EXISTS historical_rates (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), user_id text NOT NULL,
 model text NOT NULL, from_at timestamp NOT NULL, to_at timestamp NOT NULL,
 multiplier numeric(14,6) NOT NULL CHECK(multiplier >= 0), note text NOT NULL,
 voided_at timestamp, void_reason text,
 created_at timestamp NOT NULL DEFAULT now()
);
