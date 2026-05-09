# Build Your Own Claude API Reseller Panel in 5 Minutes (Open Source)

> Keywords: open-source Claude proxy, self-hosted AI API reseller, Claude-compatible relay, one-click VPS install

Want to start an AI API reseller business but don't want to negotiate
upstream provider keys, manage credit balances, or handle bans? Then
read on.

**3API Panel** is an open-source self-hostable platform with a
**built-in upstream**. You install it in 5 minutes, set your retail
price, and start selling. We handle the upstream provider relationships;
you handle customer acquisition.

## How it differs from one-api / new-api

| | one-api / new-api | 3API Panel |
|---|---|---|
| Upstream API keys | Bring your own | Bundled |
| Cross-border payments | DIY | Handled by us |
| Risk of upstream bans | Yours | Ours |
| Setup complexity | Moderate | **5-minute one-liner** |
| Multi-tenant hosted mode | No | **Yes** (TENANT_MODE=multi) |
| License | Apache-2.0 | MIT |

## Quick install

Tested on Ubuntu 22.04, Debian 12, CentOS Stream 9. 1 GB RAM minimum:

```bash
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
```

The script:
1. Detects OS and installs Docker if missing
2. Fetches `docker-compose.yml` + `Caddyfile`
3. Prompts for your domain + 3API wholesale key (`wsk-...`)
4. Generates random admin password + JWT secret
5. Brings up the stack with `docker compose up -d`

Five minutes later, `https://your-domain` is a fully-functioning
Claude-compatible API reseller panel.

## Business model: multiplexing arbitrage

We sell you wholesale subscriptions (same price as our direct retail):
- Pro $4.10/month per slot (¥29)
- Max5x $21/month per slot (¥149)
- Max20x $42/month per slot (¥299)
- Ultra $84/month per slot (¥599)

You multiplex one slot across multiple end customers:
- 5 light customers @ $1.4 each → $7 revenue, $4.10 cost → **70%+ margin**
- 30 capped-monthly customers @ $2 each → $60 revenue, $42 cost
- One Ultra slot serving 50 mixed customers → $80+ profit

Billing flexibility: per-token, monthly subscription, or hybrid — toggle
in the admin dashboard.

## Three deployment modes

1. **Self-host** — your VPS, your domain, your brand
2. **Hosted SaaS** — sign up free at [3api.pro](https://3api.pro), get
   a `<your-name>.3api.pro` subdomain (or bind your own custom domain)
3. **Affiliate-only** — just refer customers, we handle everything

## Why open source?

We do the heavy lifting (upstream, key pool, protocol compatibility);
you do the customer-facing work (community, SEO, support). Open source
keeps everything transparent and lets you fork if you outgrow us. We
make money from wholesale volume, not lock-in.

## GitHub

[github.com/3api-pro/relay-panel](https://github.com/3api-pro/relay-panel)

License: MIT. Architecture borrows ideas from `one-api` (Apache-2.0).
