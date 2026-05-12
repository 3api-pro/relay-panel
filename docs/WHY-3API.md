# Why 3api — over new-api / sub2api / VoAPI

You can run any open-source relay panel. So why pick 3api?

## TL;DR

**Other panels are software. 3api is a platform with upstream baked in.**

|                                   | new-api          | sub2api              | VoAPI            | **3api**                                  |
|-----------------------------------|------------------|----------------------|------------------|-------------------------------------------|
| You bring API keys                | Required         | Required (or 拼车)   | Required         | **Optional — built-in wholesale upstream** |
| Multi-tenant SaaS                 | No               | No                   | No               | Yes                                        |
| Subdomain per reseller            | No               | No                   | No               | Yes (Caddy on-demand TLS)                  |
| Upstream failure recovery         | Your problem     | Your problem         | Your problem     | Platform handles                           |
| Start-to-first-sale               | Hours–days       | Hours                | Hours            | **30 minutes**                             |
| Native subscription billing       | Partial          | Yes                  | No               | Yes                                        |
| Modern stack                      | Go               | Go                   | PHP/Laravel      | TypeScript + Postgres + Next.js            |

## The "zero inventory" model

Traditional reseller economics — the same drudgery for every OSS panel:

1. **Buy / negotiate Anthropic Console quota** — needs $$, takes days to weeks,
   often requires English correspondence with vendor sales.
2. **Buy / negotiate OpenAI org keys** — same.
3. **Pool, rotate, monitor for bans** — ongoing pain, especially on Anthropic
   where flagged keys vanish overnight.
4. **Mark up, sell** — the only fun part.

Steps 1-3 are infrastructure work you do *before* you can talk to a customer.
That's weeks of capital outlay and stress before the first ¥1 of revenue.

**3api model:**

1. Register → `llmapi.pro` wholesale upstream is pre-wired.
2. Top up your wholesale balance (¥10 minimum) — pay-as-you-go.
3. Each customer sale → wholesale balance debits face value, you keep the
   markup.
4. **Upstream fails? `llmapi.pro` reroutes. Anthropic bans a key? We rotate.
   You don't see it.**

The cognitive load delta is what matters: you stop thinking about base
models, key bans, and rate limits. You think about pricing, branding,
customer experience — the actual reseller job.

## BYOK is fully supported

If you already have a juicy Anthropic Console org or cheap OpenAI keys, you
can still bring them. In `/admin/channels`:

- Add a BYOK channel with your own `sk-ant-*` / OpenAI key.
- Set priority (lower = preferred).
- Restrict to specific models if you want (e.g. send Sonnet through your key,
  fall back to wholesale for everything else).

The relay picks the cheapest channel that supports the requested model and
fails over automatically. Wholesale + BYOK + LiteLLM + a friend's OpenRouter
account can all coexist in the same channel pool.

## What you actually do as a reseller

| Concern   | What you configure                                                  |
|-----------|---------------------------------------------------------------------|
| Pricing   | Markup over face value (3api default is +0% — you set retail prices) |
| Branding  | Logo, primary color, announcement, custom domain                     |
| Customers | Invite, refund, ban, view usage                                      |
| Money     | Alipay merchant ID + USDT addresses, withdraw                        |

Three of those (pricing, customers, money) are universal across all panels.
**Branding + zero-inventory upstream + multi-tenant subdomains** is what
makes 3api different.

## When 3api is *wrong* for you

Be honest with yourself before adopting it:

- **You need to sell access to a *specific* Anthropic Console org** (e.g.
  for compliance, billing transparency, or because you negotiated a private
  rate) → use a single BYOK channel, don't touch the wholesale upstream.
- **You don't want any wholesale dependency** → set `UPSTREAM_KEY=` to empty
  in your `.env` and rely 100% on BYOK channels. 3api still gives you the
  multi-tenant + subdomain + storefront layer.
- **You're building a single-tenant SaaS for one customer** → `new-api` /
  `sub2api` are leaner. 3api's multi-tenant routing is overhead you
  won't use.
- **You want a Go binary you can drop on a 1-CPU VPS** → `new-api` is the
  established option. We're TypeScript + Postgres + Caddy + Next.js, which
  needs ~512MB RAM minimum.

For most resellers, the math wins:

- **Zero capital outlay** — no upfront key buying.
- **Zero upstream operations pain** — no 3am ban incidents.
- **30 minutes to first sale** — register, configure payments, share link.

That's the wedge. Everything else (modern UI, native subscription billing,
multi-tenant, custom domains, MIT license) is supporting cast.
