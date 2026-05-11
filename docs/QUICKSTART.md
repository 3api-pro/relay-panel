# Quick Start — Clone to First Paying Customer in 5 Minutes

This guide walks you from a fresh checkout of `relay-panel` to actually billing
a real `/v1/messages` request. Total time: ~5 minutes on a laptop, ~7 minutes
on a fresh VPS.

## 0. Prerequisites

- Docker + `docker compose` v2 (`docker compose version` returns ≥ 2.0)
- 1 GB RAM, 2 GB free disk
- An Anthropic-compatible upstream key (any of):
  - An Anthropic `sk-ant-*` key (BYOK)
  - A `wsk-*` key from a wholesale provider (e.g. `api.llmapi.pro/wholesale`)
  - Anything else that speaks `POST /v1/messages` (LiteLLM, OpenRouter, …)

## 1. Clone and configure

```bash
git clone https://github.com/3api-pro/relay-panel
cd relay-panel
cp .env.example .env
```

Open `.env` and set at minimum:

```ini
POSTGRES_PASSWORD=<a strong random string>
JWT_SECRET=<another strong random string, 32+ chars>
PUBLIC_BASE_URL=http://localhost:8080
```

(Generate two secrets in one go: `openssl rand -hex 32`.)

## 2. Boot it

```bash
docker compose up -d
docker compose ps        # all three services should be "running (healthy)"
docker compose logs -f panel  # optional: tail startup logs
```

The first boot takes 30-60 s — Postgres initialises, the panel applies
schema migrations, the Next.js UI is served from `/app/public`. When the
healthcheck flips to `healthy` you're ready.

## 3. Sign up (you are tenant #1)

Open <http://localhost:8080> in a browser, click **Get Started**, and create
your first tenant:

- **slug**: e.g. `demo` (this becomes `demo.localhost` / `demo.<your-domain>`)
- **admin email + password**: this is the owner login

You land on the **onboarding wizard**. Five steps:

1. **Upstream** — paste your `sk-ant-*` / `wsk-*` key, pick a base_url
2. **Branding** — name, logo URL, primary colour, announcement
3. **First plan** — e.g. "Pro / $19/mo / 50 req/min / Claude Sonnet 4"
4. **Test customer** — creates a sample end-user account with one API token
5. **Verify** — runs a real `/v1/messages` call and shows you billable units

After step 5 you're on the admin dashboard.

## 4. Make a real billed `/v1/messages` call

Copy the `sk-*` token shown at the end of onboarding, then from any shell:

```bash
curl -s http://localhost:8080/v1/messages \
  -H "Authorization: Bearer sk-<your-token>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 64,
    "messages": [{"role":"user","content":"Say hi in one word."}]
  }'
```

You should get a normal Anthropic response. Refresh the admin dashboard —
**usage** ticks up by one request and the corresponding cost in cents
appears under the test customer.

## 5. Sell it

In the admin panel, **Plans → New**:

- Public storefront URL is `http://demo.localhost:8080/store` (or your
  custom domain once DNS is pointed)
- New customers can self-signup, pick a plan, pay via Alipay / USDT, and
  get an `sk-*` token they can use immediately

That's the loop. Everything else (custom domain, branding, referral
program, …) is described in [ARCHITECTURE.md](ARCHITECTURE.md) and
[ROADMAP.md](ROADMAP.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `panel` keeps restarting | bad `POSTGRES_PASSWORD` / `JWT_SECRET` | edit `.env`, `docker compose up -d --force-recreate panel` |
| `/v1/messages` returns 502 | upstream key invalid / no quota | check upstream key in admin → Upstream Channels |
| `/v1/messages` returns 401 | token typo / no `Bearer ` prefix | re-copy from admin |
| `/v1/messages` returns 429 | plan rate limit hit | bump rate limit on the plan |
| Web UI 404 on `/store` | UI bundle missing in image | rebuild: `docker compose build --no-cache panel` |

Still stuck? Open a [Discussion](https://github.com/3api-pro/relay-panel/discussions)
or a [bug issue](https://github.com/3api-pro/relay-panel/issues/new?template=bug_report.md)
with `docker compose logs panel | tail -200`.

## Production deployment

For a real VPS deployment with HTTPS and a custom domain see
[DEPLOY-NOW.md](DEPLOY-NOW.md) (Cloudflare Tunnel) or
[ARCHITECTURE.md#deployment](ARCHITECTURE.md#deployment) (Caddy on-demand TLS).