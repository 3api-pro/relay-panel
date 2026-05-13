# Architecture

This document describes the deployment model, request lifecycle, money flow,
data model, and security boundaries of `3api/relay-panel`.

## TL;DR

A single Node process (`src/index.ts`) plus Postgres. Tenant is resolved from
the host header. The same code path serves the marketing site, admin UI,
storefront UI, and the `/v1/messages` relay — separated by middleware, not by
microservice.

## High-level diagram

```mermaid
graph TB
  subgraph "Public Internet"
    A[reseller.com] -- CNAME --> B["*.3api.pro / your-host"]
    A2[acme.3api.pro] --> B
    A3[3api.pro root] --> B
  end

  subgraph "3api panel container (single Node process)"
    B --> C{Express Router + Tenant Middleware}
    C -- "admin JWT cookie" --> D[Admin API + UI]
    C -- "end-user JWT cookie" --> E[Storefront API + UI]
    C -- "Bearer sk-*" --> F[/v1/messages Relay]
    C -- "X-Platform-Token" --> P[Platform /platform/tenants]
  end

  subgraph "Upstream"
    F --> G["api.llmapi.pro / wholesale"]
    F -. BYOK .-> H["Anthropic / OpenRouter / LiteLLM / ..."]
  end

  subgraph "Postgres"
    D --> I[("tenant, plan, order, subscription,<br/>end_user, end_token, usage_log,<br/>upstream_channel, redemption")]
    E --> I
    F --> I
    P --> I
  end

  style F fill:#6366f1,color:#fff
  style I fill:#0ea5e9,color:#fff
```

## Tenant resolution strategy

Every request is tagged with a `tenant_id` by `src/middleware/tenant-resolver.ts`
**before** any route handler runs. The resolver tries, in order:

1. **`X-Tenant-Slug` header** — used by smoke tests and the platform API
2. **Custom domain** — `Host: panel.acme.com` → lookup `tenant.custom_domain`
3. **Subdomain** — `Host: acme.3api.pro` → lookup `tenant.slug = 'acme'`
4. **Root domain** — `Host: 3api.pro` → marketing tenant (id = 0, read-only)
5. **`TENANT_MODE=single`** — bypass resolver, use `tenant_id = 1` implicitly

If steps 1-4 fail in multi-tenant mode the request gets `404 unknown tenant`.

## Request lifecycle — `/v1/messages`

```
Client (sk-* Bearer)
   │
   ▼
tenant-resolver         ──► sets req.tenantId
   │
   ▼
auth-token middleware   ──► resolves sk-* → end_user, plan, rate-limit bucket
   │
   ▼
rate-limit              ──► per-token + per-tenant + per-plan caps
   │
   ▼
billing.preflight       ──► reject if quota_cents < est_cost OR sub not active
   │
   ▼
upstream.callUpstream*  ──► pick channel by tenant + plan + model;
   │                       failover order: BYOK channel → wholesale pool
   ▼
billing.commit          ──► record usage_log row, debit quota_cents,
   │                       tick subscription.usage_count
   ▼
SSE / JSON response back to client
```

Non-streaming and streaming go through the same path; the upstream client
just delegates to `callUpstream` vs `callUpstreamStream`. The relay never
holds onto the request body for longer than the upstream call — there is
no replay buffer.

## Money flow

```
Customer ──$── reseller's storefront ──$── reseller's bank / Alipay / USDT wallet
                                              │
                                              ├── reseller's profit
                                              │
                                              └──$── 3api wholesale ──$── upstream LLM provider
```

`order` rows track the customer → reseller leg. The reseller → 3api leg
lives on `wholesale_purchase` rows in the upstream `llmapi-v2` backend
(out of scope for this repo). The two are bridged by the upstream key
configured under `upstream_channel`.

The relay-panel codebase **never holds reseller funds** — there is no
internal wallet between customer and reseller. All payment processors
settle directly to the reseller's account.

## Schema overview (`db/migrations/001-init.sql`)

| Table              | Purpose                                                       |
|--------------------|---------------------------------------------------------------|
| `tenant`           | One row per reseller; `slug`, `custom_domain`, branding JSON  |
| `reseller_admin`   | Panel owner login accounts                                    |
| `end_user`         | Reseller's customers (panel users)                            |
| `end_token`        | API keys end-users use (sk-* format), hashed at rest          |
| `upstream_channel` | Upstream provider config; BYOK or wholesale                    |
| `plan`             | Public plans the reseller sells (price, rate limit, models)   |
| `order`            | Customer purchases (Alipay / USDT / manual top-up)            |
| `subscription`     | Active monthly subs (links `end_user` ↔ `plan`)               |
| `usage_log`        | Per-request: ts, model, tokens, cost_cents, channel_id        |
| `redemption`       | Top-up codes (marketing tool, optional)                       |

All non-`tenant` tables carry a `tenant_id` FK. Multi-tenant isolation
is enforced **both** by application middleware *and* (in `multi` mode)
by row-level security policies on Postgres (`SET LOCAL app.tenant_id`
per request inside a transaction).

## Tenant modes

### `TENANT_MODE=single` (default for self-host)

- One reseller per panel
- `tenant_id = 1` implicit, no resolver
- Simpler ops; bundled Postgres is overkill but consistent with multi mode
- Domain: reseller's own (e.g. `relay.example.com`)

### `TENANT_MODE=multi` (hosted SaaS at 3api.pro)

- Many resellers per panel instance
- PostgreSQL required (RLS on)
- Every table has `tenant_id` enforced via middleware
- Subdomain routing: `<slug>.3api.pro`
- Custom domain: bind via CNAME; Caddy on-demand TLS issues a cert
  automatically on the first HTTPS request to the new host

## Billing modes

End-user can be charged in 3 modes (set per-plan):

1. **Token-billed** — pay per token used, debited from `end_user.quota_cents`
2. **Subscription** — monthly fee for a tier; reseller buys the corresponding
   upstream sub from `api.llmapi.pro/wholesale`
3. **Hybrid** — subscription cap + overage billed per-token

Reseller sets retail price freely. Wholesale cost from `api.llmapi.pro` is
fixed (`Pro 29 / Max5x 149 / Max20x 299 / Ultra 599` RMB per month at the
time of writing). Margin is the reseller's.

## Upstream channels

Default channel preset:

- `base_url`: `https://api.llmapi.pro/wholesale/v1`
- `type`: `wholesale-llmapi`
- Default `models`: `claude-sonnet-4-5, claude-opus-4-1, claude-sonnet-4-7`
- `model_mapping`: aliases like `claude-3-5-sonnet → claude-sonnet-4-5`

Power users add their own channels (direct Anthropic, OpenRouter, LiteLLM,
custom proxy). Multiple channels per tenant are ordered by `priority` and
fail over on 5xx / timeout / no-quota.

## Auth flow

- **Reseller admin** — login → JWT (httpOnly cookie, 7-day TTL) → admin routes
- **End-user** — login → JWT (httpOnly cookie, 7-day TTL) → customer dashboard
- **API call** — `Authorization: Bearer sk-*` on `/v1/*` → tenant resolver
  → token lookup → quota check → upstream proxy
- **Platform operator** — `X-Platform-Token: $PLATFORM_TOKEN` on `/platform/*`
  → tenant CRUD (used by `3api.pro` SaaS frontend only)

JWT secret rotation: bump `JWT_SECRET` in `.env`, redeploy → all logged-in
sessions invalidated. Tokens (`sk-*`) are independent of JWT and unaffected.

## Security boundaries

| Layer             | Trust assumption                                              |
|-------------------|---------------------------------------------------------------|
| Public internet   | Untrusted; rate-limit + CORS + helmet headers on             |
| Reverse proxy     | Trusted; sets `X-Forwarded-For`, terminates TLS              |
| Tenant resolver   | Must run **before** any business middleware                  |
| Auth middleware   | Independent for admin (JWT), end-user (JWT), token (sk-*)    |
| DB connection     | One pool, `SET LOCAL app.tenant_id` per request transaction  |
| Upstream call     | API key never logged, never returned in error bodies         |

The threat model assumes a hostile customer can:

- Forge `X-Tenant-Slug` → mitigated: that header is ignored unless the
  request is from a trusted internal source (platform API or smoke test)
- Replay `sk-*` tokens → mitigated: hash-at-rest + revocable in admin
- Try to escape their tenant → mitigated: RLS + middleware double-check

## Deployment topology

### Self-host (single tenant)

```
[Internet] ── 80/443 ──▶ Caddy ──▶ panel:8080 ──▶ Postgres:5432
                                       │
                                       └────────▶ upstream (Anthropic, etc.)
```

Single host, three containers (panel + postgres + caddy), brought up with
`git clone … && cp .env.example .env && docker compose up -d`. Caddy
issues a Let's Encrypt cert for the reseller's chosen hostname.

### Hosted SaaS (multi-tenant, 3api.pro)

```
[Internet] ── 80/443 ──▶ Cloudflare Tunnel ──▶ panel:3199 ──▶ Postgres:5432
                                                    │
                                                    └─────▶ api.llmapi.pro/wholesale
```

`*.3api.pro` is a wildcard CNAME into the tunnel. Custom domains use
Caddy's on-demand TLS to issue certs lazily on first HTTPS request.

## Tech stack

| Layer            | Choice                                          |
|------------------|-------------------------------------------------|
| Runtime          | Node.js 20+                                     |
| HTTP             | Express 4, TypeScript 5                         |
| Database         | PostgreSQL 16 (multi) / same image (single)     |
| Frontend         | Next.js 14 (static export) + Tailwind CSS       |
| Auth             | `jsonwebtoken` (JWT) + `bcryptjs` (passwords)   |
| Reverse proxy    | Caddy 2 (auto Let's Encrypt)                    |
| Logging          | `pino` (JSON stdout, redacted upstream keys)    |
| Container        | Docker + Docker Compose v2, distroless base     |
| License          | MIT                                             |

## Extension points

If you fork this repo to do something it doesn't currently do, the most
common touch-points are:

- **New upstream type** → `src/services/upstream/<name>.ts`, register in
  `src/services/upstream/index.ts`
- **New payment processor** → `src/services/payment/<name>.ts`,
  expose a webhook route in `src/routes/webhooks.ts`
- **New billing mode** → `src/services/billing.ts`,
  add a `mode` value in the plan migration
- **New notification channel** (Slack, Telegram, …) →
  `src/services/notify/<channel>.ts` listening on the internal event bus

PRs adding extension points (rather than just one-off integrations)
are doubly welcome.