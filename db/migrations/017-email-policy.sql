-- 017-email-policy.sql
-- Email registration policy (disposable / abusive domain blocklist + optional
-- allowlist) + per-recipient send-log used to throttle verification spam.
--
-- Ported from llmapi-v2's email-policy module (see services/email-policy.ts
-- in llmapi). Same wildcard semantics: a domain entry starting with '.'
-- (e.g. '.eu.org') matches every subdomain (anything.eu.org).

CREATE TABLE IF NOT EXISTS blocked_email_domains (
  domain      varchar(255) PRIMARY KEY,
  reason      varchar(255) NOT NULL DEFAULT '',
  created_by  varchar(100) NOT NULL DEFAULT 'system',
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allowed_email_domains (
  domain      varchar(255) PRIMARY KEY,
  reason      varchar(255) NOT NULL DEFAULT '',
  created_by  varchar(100) NOT NULL DEFAULT 'system',
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

-- email_send_log: append-only per-recipient outbound log. Used as a
-- cooldown source (cannot resend the same template to the same address
-- within N seconds) and for delivery audit. NOT a queue.
CREATE TABLE IF NOT EXISTS email_send_log (
  id          bigserial PRIMARY KEY,
  to_email    varchar(255) NOT NULL,
  template    varchar(64)  NOT NULL,
  status      varchar(20)  NOT NULL,
  provider    varchar(20),
  tenant_id   integer,
  err_short   varchar(255),
  sent_at     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_to_recent
  ON email_send_log(to_email, sent_at DESC);

-- Seed common disposable / catch-all free-subdomain domains.
INSERT INTO blocked_email_domains (domain, reason, created_by) VALUES
  ('mailinator.com',         'disposable',           'seed'),
  ('10minutemail.com',       'disposable',           'seed'),
  ('10minutemail.net',       'disposable',           'seed'),
  ('tempmail.com',           'disposable',           'seed'),
  ('temp-mail.org',          'disposable',           'seed'),
  ('temp-mail.io',           'disposable',           'seed'),
  ('guerrillamail.com',      'disposable',           'seed'),
  ('guerrillamail.net',      'disposable',           'seed'),
  ('sharklasers.com',        'disposable',           'seed'),
  ('throwawaymail.com',      'disposable',           'seed'),
  ('yopmail.com',            'disposable',           'seed'),
  ('maildrop.cc',            'disposable',           'seed'),
  ('getnada.com',            'disposable',           'seed'),
  ('trashmail.com',          'disposable',           'seed'),
  ('emailondeck.com',        'disposable',           'seed'),
  ('fakemailgenerator.com',  'disposable',           'seed'),
  ('dispostable.com',        'disposable',           'seed'),
  ('mintemail.com',          'disposable',           'seed'),
  ('33mail.com',             'disposable',           'seed'),
  ('mohmal.com',             'disposable',           'seed'),
  ('spamgourmet.com',        'disposable',           'seed'),
  ('mvrht.com',              'disposable',           'seed'),
  ('inboxbear.com',          'disposable',           'seed'),
  ('mailcatch.com',          'disposable',           'seed'),
  ('mytemp.email',           'disposable',           'seed'),
  ('emailfake.com',          'disposable',           'seed'),
  ('fakeinbox.com',          'disposable',           'seed'),
  ('moakt.cc',               'disposable',           'seed'),
  ('inboxkitten.com',        'disposable',           'seed'),
  ('mailpoof.com',           'disposable',           'seed'),
  ('.eu.org',                'free subdomain pool',  'seed'),
  ('.is-a.dev',              'free subdomain pool',  'seed'),
  ('.js.org',                'free subdomain pool',  'seed'),
  ('.tk',                    'free ccTLD',           'seed'),
  ('.ml',                    'free ccTLD',           'seed'),
  ('.ga',                    'free ccTLD',           'seed'),
  ('.cf',                    'free ccTLD',           'seed'),
  ('.gq',                    'free ccTLD',           'seed')
ON CONFLICT (domain) DO NOTHING;
