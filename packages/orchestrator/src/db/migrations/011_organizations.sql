CREATE TABLE IF NOT EXISTS organizations (
  owner_id integer PRIMARY KEY REFERENCES operators(id),
  name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_members (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES organizations(owner_id),
  operator_id integer NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('editor','reader')),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT organization_member_uk UNIQUE(owner_id,operator_id)
);
CREATE TABLE IF NOT EXISTS organization_invites (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES organizations(owner_id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor','reader')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
