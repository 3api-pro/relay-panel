# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Active    |
| < 0.1   | No        |

We patch the latest minor only. If you are on an older minor and need a
backport, open an issue.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email: **security@3api.pro**

We aim to:

- Acknowledge receipt within **24 hours**
- Provide a triage assessment within **72 hours**
- Ship a fix within **14 days** for high-severity issues

You will be credited in the release notes unless you ask otherwise.

## Scope

In scope:

- The `relay-panel` codebase (this repository)
- The default `docker-compose.yml` and `Dockerfile`
- The bundled `Caddyfile`
- Any code under `@3api/*` on npm

Out of scope:

- Vulnerabilities in third-party upstreams (Anthropic, OpenAI, etc.)
- Social engineering of operators
- DoS that requires sustained traffic above your VPS plan
- Self-XSS / clickjacking on pages with no authenticated state

## Hardening checklist for operators

If you self-host, please at minimum:

1. Set strong `JWT_SECRET` and `POSTGRES_PASSWORD` (32+ random bytes each)
2. Set `PLATFORM_TOKEN` if you expose `/platform/*` routes
3. Terminate TLS at Caddy or a reverse proxy — never expose `:8080` raw
4. Keep the `relay-panel` image up to date (`docker compose pull && up -d`)
5. Rotate upstream keys every 90 days
6. Back up the Postgres volume — `pgdata/` — daily

## Known non-issues

These are documented as won't-fix unless an exploit chain is demonstrated:

- `tenant_id = 0` is read-only by design (marketing tenant); enumeration of slugs is not a vulnerability
- Side-channel timing on `bcrypt.compare` for failed logins is bounded by node's event loop
- Webhook endpoints validate signatures; replays older than 5 minutes are rejected
