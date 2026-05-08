# 3API Relay Panel — Architecture

## Overview

```
┌────────────────────────────────────────────────────┐
│  End Customer (uses reseller's panel)              │
│   - Signs up at panel URL                          │
│   - Buys credit (token-billed) or subscription     │
│   - Gets API key, calls /v1/messages               │
└────────────────┬───────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────┐
│  Reseller Panel (this OSS, on reseller's VPS       │
│  OR hosted by us at <slug>.3api.pro)               │
│   - Multi-tenant ready (TENANT_MODE=single|multi)  │
│   - Storage: SQLite (single) or PG (multi)         │
│   - Components:                                    │
│     - end-user accounts + tokens                   │
│     - quota / billing engine (token + sub modes)   │
│     - admin panel (reseller's dashboard)           │
│     - relay endpoint (proxies to upstream)         │
└────────────────┬───────────────────────────────────┘
                 │ Bearer wsk-* (UPSTREAM_KEY)
                 ▼
┌────────────────────────────────────────────────────┐
│  3API Wholesale Upstream (api.llmapi.pro/wholesale)│
│   - Reseller buys subs in advance                  │
│   - Each sub provisions a shadow account            │
│   - Panel multiplexes shadow keys among customers  │
└────────────────┬───────────────────────────────────┘
                 │
                 ▼
              Claude-compatible API
```

## Tenant Modes

### `TENANT_MODE=single` (default, self-host)

- One reseller per panel
- SQLite (file-based, no DB ops)
- All tables have `tenant_id=1` implicitly
- Domain: reseller's own (e.g., `relay.example.com`)

### `TENANT_MODE=multi` (hosted SaaS at 3api.pro)

- Many resellers per panel instance
- PostgreSQL required
- Each table has `tenant_id` enforced via middleware (subdomain → tenant_id)
- Subdomain routing: `<slug>.3api.pro`
- Custom domain: bind via CNAME, Caddy on-demand TLS

## Schema (8 tables)

| Table | Purpose |
|---|---|
| `tenant` | Multi-tenant (single mode: 1 row, id=1 implicit) |
| `reseller_admin` | Panel owner accounts (login to admin) |
| `end_user` | Reseller's customers (panel users) |
| `end_token` | API keys end-users use (sk-* format) |
| `upstream_channel` | Upstream provider config (default: 3api wholesale) |
| `redemption` | Top-up codes (marketing tool) |
| `usage_log` | Per-request usage tracking |
| `subscription` | Optional monthly sub allocation per end-user |

## Billing Modes

End-user can be charged in 3 modes (set per-tenant or per-customer):

1. **Token-billed**: pay per token used, deducted from `end_user.quota_cents`
2. **Subscription**: monthly fee for a tier (Pro/Max5x/Max20x/Ultra), reseller buys upstream sub for them
3. **Hybrid**: subscription cap + overage billed per-token

Reseller sets retail price at admin level. Wholesale cost from us is fixed (Pro 29 / Max5x 149 / Max20x 299 / Ultra 599 RMB).

## Upstream Channel

Default channel preset:
- `base_url`: `https://api.llmapi.pro/wholesale/v1`
- `type`: `wholesale-llmapi`
- Default `models`: `claude-sonnet-4-7,claude-opus-4-7`
- `model_mapping`: aliases like `claude-3-5-sonnet → claude-sonnet-4-7`

Power users can add other channels (e.g., direct OpenAI, Anthropic) and route by group.

## Deployment

- **Self-host**: `docker compose up -d` after `install.sh` (5 min)
- **Hosted SaaS**: deployed by 3api team, multi-tenant Postgres + Caddy on-demand TLS

## Auth flow

- **Reseller admin**: login → JWT (httpOnly cookie) → admin routes
- **End-user**: login → JWT (httpOnly cookie) → customer dashboard
- **API call**: Bearer sk-* on /v1/* → tenant resolver → token lookup → quota check → upstream proxy

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Node.js 20+, Express, TypeScript |
| Database | SQLite (single-tenant) / PostgreSQL (multi-tenant) |
| Frontend | Next.js + Tailwind (in `ui/` subdir, separate package) |
| Reverse proxy | Caddy (auto Let's Encrypt) |
| Container | Docker + Docker Compose |
| License | MIT |
