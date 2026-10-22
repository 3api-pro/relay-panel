CREATE TABLE IF NOT EXISTS notification_preferences (
  operator_id integer PRIMARY KEY REFERENCES operators(id),
  alerts boolean NOT NULL DEFAULT true,
  billing boolean NOT NULL DEFAULT true,
  support boolean NOT NULL DEFAULT true,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id serial PRIMARY KEY,
  operator_id integer NOT NULL REFERENCES operators(id),
  category text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  subject text NOT NULL,
  body text NOT NULL,
  mail_ciphertext text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp,
  read_at timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications(operator_id, id);
CREATE INDEX IF NOT EXISTS notifications_delivery_idx ON notifications(status, next_attempt_at);
