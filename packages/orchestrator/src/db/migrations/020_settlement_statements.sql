BEGIN;
CREATE TABLE IF NOT EXISTS settlement_statements (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), owner_id integer NOT NULL REFERENCES operators(id),
 partner_id integer NOT NULL REFERENCES service_partners(id), partner_name text NOT NULL,
 reference text NOT NULL, title text NOT NULL, direction text NOT NULL CHECK(direction IN ('payable','receivable')),
 currency text NOT NULL CHECK(currency IN ('USD','CNY')), from_day text NOT NULL, to_day text NOT NULL, due_day text,
 lines jsonb NOT NULL, total numeric(24,6) NOT NULL CHECK(total>0 AND total<=1000000000),
 public_note text NOT NULL DEFAULT '', internal_note text NOT NULL DEFAULT '',
 source_review_id integer REFERENCES finance_submissions(id), source_evidence jsonb,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','cancelled')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 issued_at timestamp, cancelled_at timestamp, cancel_reason text,
 created_by integer NOT NULL REFERENCES operators(id), created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT settlement_statement_reference UNIQUE(owner_id,partner_id,reference), CHECK(from_day<=to_day), CHECK(jsonb_typeof(lines)='array')
);
CREATE INDEX IF NOT EXISTS settlement_statement_site ON settlement_statements(site_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_source_review ON settlement_statements(source_review_id) WHERE source_review_id IS NOT NULL AND status<>'cancelled';
CREATE TABLE IF NOT EXISTS settlement_shares (
 id serial PRIMARY KEY, statement_id integer NOT NULL REFERENCES settlement_statements(id), access_id integer NOT NULL REFERENCES service_access(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','disputed')),
 note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1 CHECK(version>0), revoked_at timestamp,
 shared_by integer NOT NULL REFERENCES operators(id), created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_share_active ON settlement_shares(statement_id,access_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS settlement_share_access ON settlement_shares(access_id,id);
CREATE TABLE IF NOT EXISTS settlement_receipts (
 id serial PRIMARY KEY, statement_id integer NOT NULL REFERENCES settlement_statements(id), owner_id integer NOT NULL REFERENCES operators(id),
 amount numeric(24,6) NOT NULL CHECK(amount>0 AND amount<=1000000000), reference text NOT NULL, method text NOT NULL, received_day text NOT NULL,
 note text NOT NULL DEFAULT '', recorded_by integer NOT NULL REFERENCES operators(id),
 voided_at timestamp, void_reason text, created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_receipt_reference ON settlement_receipts(owner_id,reference) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS settlement_receipt_statement ON settlement_receipts(statement_id,id);
CREATE TABLE IF NOT EXISTS settlement_events (
 id serial PRIMARY KEY, statement_id integer NOT NULL REFERENCES settlement_statements(id), share_id integer REFERENCES settlement_shares(id),
 actor_id integer NOT NULL REFERENCES operators(id), action text NOT NULL, note text NOT NULL, created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_event_statement ON settlement_events(statement_id,id);
COMMIT;
