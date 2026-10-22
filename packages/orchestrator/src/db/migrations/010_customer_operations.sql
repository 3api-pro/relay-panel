CREATE TABLE IF NOT EXISTS refund_requests (
  id serial PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  order_id integer NOT NULL REFERENCES payment_orders(id),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','completed','cancelled')),
  version integer NOT NULL DEFAULT 1,
  note text,
  receipt text,
  reviewed_by text,
  entitlement text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_requests_owner_idx ON refund_requests(operator_id);
CREATE UNIQUE INDEX IF NOT EXISTS refund_receipt_uk ON refund_requests(receipt);
CREATE TABLE IF NOT EXISTS support_tickets (
  id serial PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  version integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_owner_idx ON support_tickets(operator_id,id);
CREATE TABLE IF NOT EXISTS support_messages (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES support_tickets(id),
  actor_id integer NOT NULL REFERENCES operators(id),
  staff boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
