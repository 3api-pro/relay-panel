# Contributing to 3api / relay-panel

Thanks for your interest. This project is intentionally small in surface area —
the core path is `tenant resolver → auth → billing → relay`. Most contributions
fall into one of four buckets:

1. **Bug fixes** — fix a thing that's broken, ideally with a regression test
2. **Adapters** — a new upstream provider, a new payment provider, a new mail provider
3. **Storefront polish** — branding hooks, i18n strings, accessibility, mobile fixes
4. **Docs / examples** — `docs/`, `README`, example `.env` files for specific upstreams

Things we usually **don't** merge:

- New top-level features without a tracking issue (open one first, get a 👍)
- Refactors that touch `src/services/` without a concrete bug or perf gain
- Anything that adds heavy runtime dependencies (we keep the image small on purpose)

## Dev setup

```bash
git clone https://github.com/3api-pro/relay-panel
cd relay-panel
cp .env.example .env
docker compose up -d postgres   # bring up just Postgres
npm install
npm run dev                     # panel boots on :8080 with hot reload
```

Smoke tests:

```bash
bash scripts/smoke-test.sh       # 13 endpoints (admin + customer + v1)
bash scripts/smoke-byok.sh       # BYOK end-to-end with mock upstream
```

## Coding conventions

- **Language:** TypeScript strict. `tsc --noEmit` must pass.
- **Style:** 2-space indent, `prettier` defaults — `npm run lint` is the source of truth.
- **Errors:** never `throw new Error('foo')` from a route — return a typed error response (`{ error: { code, message } }`).
- **DB:** one query per logical step; use transactions for anything touching `subscription` or `wholesale_balance`. **Never** `SELECT *` in committed code.
- **Tenancy:** every query that touches a tenant-scoped table **must** filter by `tenant_id`. If your route doesn't have a `req.tenantId`, you're in the wrong middleware chain.
- **Logging:** `logger.info({ tenantId, requestId, ... }, 'message')` — JSON only, never raw `console.log` in committed code.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). Common types:
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `build:`.

Scope is optional but encouraged: `feat(billing): ...`, `fix(relay): ...`.

Breaking changes use `!` (`feat!: rename foo to bar`) and a `BREAKING CHANGE:`
footer.

## Pull request flow

1. Fork → branch `feat/your-thing` (or `fix/...`)
2. Make it work, make it tested, make it lint-clean
3. `npm test` and the smoke scripts pass
4. Open the PR against `main` — the template loads automatically
5. CI runs lint + tsc + smoke; expect under 10 min
6. A maintainer reviews within about 3 business days

## Reporting bugs

Use the [bug template](https://github.com/3api-pro/relay-panel/issues/new?template=bug_report.md).
Please include:

- `docker compose logs panel | tail -200` (redact secrets)
- The exact `curl` request that misbehaves
- Expected vs actual output
- Your `.env` with secrets stripped

## Security disclosures

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).
