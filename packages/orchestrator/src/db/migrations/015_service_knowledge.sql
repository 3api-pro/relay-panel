BEGIN;
CREATE TABLE IF NOT EXISTS service_knowledge_spaces (
 site_id integer PRIMARY KEY REFERENCES sites(id), token text NOT NULL UNIQUE,
 title text NOT NULL, description text NOT NULL DEFAULT '', published boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_documents (
 id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites(id), token text NOT NULL UNIQUE,
 draft jsonb NOT NULL, published jsonb, published_revision integer,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), published_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CHECK ((published IS NULL AND published_revision IS NULL AND published_at IS NULL) OR
        (published IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS service_documents_site_idx ON service_documents(site_id,id);
CREATE TABLE IF NOT EXISTS service_document_versions (
 id serial PRIMARY KEY, document_id integer NOT NULL REFERENCES service_documents(id),
 version integer NOT NULL, action text NOT NULL, content jsonb NOT NULL,
 actor_id integer NOT NULL REFERENCES operators(id), created_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT service_document_version_uk UNIQUE(document_id,version)
);
COMMIT;
