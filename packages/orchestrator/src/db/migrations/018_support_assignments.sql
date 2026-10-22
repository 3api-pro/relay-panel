BEGIN;
CREATE TABLE IF NOT EXISTS support_assignments (
 id serial PRIMARY KEY, ticket_id integer NOT NULL REFERENCES support_tickets(id), operator_id integer NOT NULL REFERENCES operators(id),
 email text NOT NULL, assigned_by integer NOT NULL REFERENCES operators(id),
 can_reply boolean NOT NULL DEFAULT false, can_resolve boolean NOT NULL DEFAULT false, can_notes boolean NOT NULL DEFAULT false,
 expires_at timestamp NOT NULL, revoked_at timestamp, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), CHECK(NOT can_resolve OR can_reply)
);
CREATE UNIQUE INDEX IF NOT EXISTS support_assignment_active ON support_assignments(ticket_id,operator_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS support_assignment_operator ON support_assignments(operator_id,ticket_id);
CREATE TABLE IF NOT EXISTS support_internal_notes (
 id serial PRIMARY KEY, ticket_id integer NOT NULL REFERENCES support_tickets(id), actor_id integer NOT NULL REFERENCES operators(id),
 body text NOT NULL, created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_note_ticket ON support_internal_notes(ticket_id,id);
CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages(ticket_id,id);
CREATE INDEX IF NOT EXISTS support_tickets_updated ON support_tickets(updated_at,id);
COMMIT;
