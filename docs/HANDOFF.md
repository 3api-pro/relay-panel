# 3API Project — State & Handoff

> 5/9/2026 snapshot. What's done, what's blocked on user-side action.

## ✅ What's done (verified)

### Backend — `llmapi-v2` `feat/wholesale-resell` branch (P1 + P1.6)

In `/root/llmapi-v2` worktree at `/root/llmapi-resell`:

| Task | Commits | Status |
|---|---|---|
| Schema (reseller / wholesale_key / wholesale_purchase / wholesale_deposit) | c5966d5 | applied to prod DB |
| wholesale-auth middleware (`wsk-*` Bearer) | 25d8894 | typecheck clean |
| /v1/wholesale routes (purchase/balance/purchases/plans) | 25d8894 | |
| wholesale-fulfillment service (atomic txn) | 25d8894 | E2E SQL pass |
| Admin reseller management (10 endpoints) | c34ba14 | |
| E2E SQL test | 1e796a6 | atomicity + idempotency + balance lock all pass |
| Leak audit | — | 0 hits in code, only in design doc red-line statements |

**Not deployed to prod** — branch exists, code works locally, deployment
gated on integration test with 3api panel (P2d).

### Frontend — `github.com/3api-pro/relay-panel` (P2a + P2b)

Repo PUBLIC. 11 commits.

| Layer | Files | Status |
|---|---|---|
| Schema (8 tables) | `db/migrations/001-init.sql` | runs on startup |
| pg pool + tx + migration runner | `src/services/database.ts` | |
| tenant resolver (single + multi) | `src/middleware/tenant-resolver.ts` | |
| auth: token / admin / customer | `src/middleware/auth-*.ts` | |
| upstream client (JSON + SSE) | `src/services/upstream.ts` | |
| billing (quota cents) | `src/services/billing.ts` | |
| relay (POST /v1/messages) | `src/routes/relay.ts` | streaming + non-streaming |
| Admin routes (11 endpoints) | `src/routes/admin.ts` | |
| Customer routes (8 endpoints) | `src/routes/customer.ts` | |
| Default admin auto-creation | `src/services/auth.ts` | |
| smoke-test.sh (13 checks) | `scripts/smoke-test.sh` | **all PASS** |
| UI: Next.js + Tailwind | `ui/` (5 functional pages) | |
| One-click installer | `install.sh` | logic written, real VPS test pending |
| docker-compose (with bundled PG) | `docker-compose.yml` | |
| Caddy auto-HTTPS | `Caddyfile` | on-demand TLS for custom domains |
| SEO articles (zh + en) | `docs/articles/` | 2 published, 11 drafts roadmap |
| Launch posts (HN/V2EX/Reddit/Linux.do) | `docs/launch/hn-show.md` | ready to paste |
| Marketing red-line audit | — | 0 hits |

## ⏳ Blocked on you (user actions only)

### 1. DNS records for `*.3api.pro` (5 min, Cloudflare)

To enable hosted SaaS multi-tenant subdomains:

1. Cloudflare → 3api.pro → DNS
2. Add records (proxied):
   - A `@`     → server IP (where you'll deploy panel)
   - A `www`   → same
   - A `*`     → same (wildcard for `<reseller>.3api.pro`)
   - A `api`   → same (for `api.3api.pro` if needed)
3. Verify: `dig anything.3api.pro` returns Cloudflare IPs

### 2. Choose a deployment target for hosted SaaS

Options:
- **Existing infra**: deploy to one of your llmapi.pro servers (a separate
  container, since panel is independent of llmapi-v2 codebase)
- **New VPS**: $5-10/month VPS (Vultr/Hetzner/DigitalOcean), 1G RAM enough

After picking, run on the target:
```
git clone git@github.com:3api-pro/relay-panel.git
cd relay-panel
cp .env.example .env
# edit .env — set TENANT_MODE=multi, SAAS_DOMAIN=3api.pro,
#   PUBLIC_URL=https://3api.pro,
#   UPSTREAM_KEY=wsk-... (your wholesale key, get from llmapi-v2 admin
#   after deploying feat/wholesale-resell)
docker compose up -d
```

### 3. Deploy `feat/wholesale-resell` to llmapi.pro prod

For 3api panel to actually fulfill purchases against wholesale, the
wholesale endpoint needs to be live on `api.llmapi.pro/wholesale/v1`.

Steps (manually, after backup):
1. `cd /root/llmapi-v2 && git checkout feat/wholesale-resell` (or merge to master)
2. Build llmapi container: `bash scripts/build-image.sh` (or whatever your build flow is)
3. Deploy via your existing canary/drain script
4. Smoke check: `curl -X POST https://api.llmapi.pro/wholesale/v1/purchase \
     -H 'Authorization: Bearer wsk-test...' \
     -d '{"plan":"pro","cycle":"monthly","request_id":"smoke-1"}'`

### 4. Submit launch posts

Drafts ready in `docs/launch/hn-show.md`. Submit when you're satisfied
with the demo site:
- HackerNews: https://news.ycombinator.com/submit
- Reddit r/selfhosted: https://www.reddit.com/r/selfhosted/submit
- V2EX 分享创造: https://www.v2ex.com/new/create
- Linux.do 开发调优: https://linux.do/c/dev/4

### 5. P2c — fresh VPS install真演练

Before launching publicly, prove the one-liner install works:

```
# On a brand-new Ubuntu 22.04 VPS:
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
```

Expected: working panel at https://your-domain in <5 min, with
docker-compose stack up (panel + postgres + caddy), default admin
auto-created, /health returning OK.

If anything fails, file an issue + I'll fix.

## Quick verification commands

### Verify backend code compiles + passes test:
```
cd /root/llmapi-resell
docker exec postgres psql -U admin -d llmapi -f /tmp/e2e.sql
# (regenerate /tmp/e2e.sql from scripts/test-e2e-wholesale.sql)
```

### Verify panel runs locally:
```
cd /root/3api-relay-panel
DATABASE_URL=postgresql://admin:pg_yhn_2026_secure_x7k9m2@127.0.0.1:5432/relay_panel_test \
PORT=3199 TENANT_MODE=single \
UPSTREAM_KEY=wsk-test JWT_SECRET=x123y456z789a012b345c678d901e234f \
ADMIN_DEFAULT_PASSWORD=admin123 \
./node_modules/.bin/tsx src/index.ts
# In another shell:
bash scripts/smoke-test.sh
```

## What I cannot do

These need physical world / business decisions:

- **P5 multi-brand sites**: needs you to pick brand names, audiences,
  pricing. (1-2 hour business decision, then deployment is mechanical.)
- **P6 真招募 outreach**: drafts are ready in `docs/launch/`; submission
  is your call (you know the venues / your audience best).
- **P2c real VPS test**: needs a VPS provisioned by you (any provider).
- **P2d real DNS + deploy**: needs your DNS access + server choice.
