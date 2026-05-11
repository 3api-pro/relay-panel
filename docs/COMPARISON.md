# Comparison — 3api vs the field

Snapshot as of 2026-05-12. Re-checked at every minor release.

## Feature matrix (detailed)

| Capability                                       | **3api / relay-panel**  | one-api          | new-api             | sub2api          | VoAPI            | Veloera          |
|--------------------------------------------------|:-----------------------:|:----------------:|:-------------------:|:----------------:|:----------------:|:----------------:|
| Tenancy model                                    | Multi-tenant SaaS-ready | Single-tenant    | Single-tenant       | Single-tenant    | Single-tenant    | Single-tenant    |
| Subdomain per reseller                           | Yes                     | No               | No                  | No               | No               | No               |
| Custom domain with auto-TLS                      | Yes (Caddy on-demand)   | No               | No                  | No               | No               | No               |
| Brand customization per tenant                   | Yes — logo/color/copy   | No               | Global only         | Global only      | Theme only       | Theme only       |
| Bundled wholesale upstream                       | Yes                     | No               | No                  | Recommended      | No               | No               |
| BYOK upstream                                    | Yes                     | Yes              | Yes                 | Yes              | Yes              | Yes              |
| Native subscription billing                      | Yes                     | No — token-only  | Partial             | Yes              | No               | No               |
| Token-pack billing                               | Yes                     | Yes              | Yes                 | Yes              | Yes              | Yes              |
| 5h-burst / weekly billing                        | v0.2                    | No               | No                  | No               | No               | No               |
| Alipay checkout                                  | Yes                     | Plugin           | Yes                 | Yes              | Partial          | Partial          |
| USDT checkout                                    | Yes                     | No               | Community           | Yes              | No               | No               |
| Stripe checkout                                  | v0.2                    | No               | Community           | Yes              | No               | No               |
| Onboarding wizard                                | Yes — 5-step            | No               | No                  | No               | No               | No               |
| End-user storefront                              | Yes                     | No               | Basic               | Yes              | Basic            | Basic            |
| Email transactional                              | Yes — Resend            | No               | SMTP                | SMTP             | Partial          | Partial          |
| Anthropic `/v1/messages` native                  | Yes                     | Adapter          | Yes                 | Yes              | Yes              | Yes              |
| OpenAI `/v1/chat/completions` native             | v0.2                    | Yes              | Yes                 | Yes              | Yes              | Yes              |
| Per-tenant rate limits                           | Yes                     | Global           | Yes                 | Yes              | Partial          | Partial          |
| Per-plan model allowlist                         | Yes — JSONB             | Partial          | Yes — csv           | Yes              | Partial          | Partial          |
| Webhook delivery                                 | v0.2                    | No               | Partial             | Yes              | No               | No               |
| Stack                                            | TS + Node + PG          | Go + Gin + MySQL | Go + Gin + PG/MySQL | Go + Gin + PG    | Go + Gin         | Go + Gin         |
| Single-process deploy                            | Yes                     | Yes              | Yes                 | Multi            | Yes              | Yes              |
| Image size                                       | ~140 MB                 | ~80 MB           | ~120 MB             | ~180 MB          | ~80 MB           | ~80 MB           |
| Strict TS / typed routes                         | Yes                     | n/a              | n/a                 | n/a              | n/a              | n/a              |
| MIT licensed                                     | Yes                     | Apache-2.0       | Apache-2.0          | Inspect          | MIT              | MIT              |

## Rationale per row

- **Multi-tenant SaaS-ready:** the single largest architectural delta. one-api
  and friends model the world as one operator, one Postgres. 3api models it as
  one panel binary, N tenants, N subdomains. Backporting tenancy into one-api
  would be a six-table migration that has been an open issue for two years.
- **Bundled wholesale upstream:** 3api ships pointed at `api.llmapi.pro/wholesale`
  by default, so a fresh operator can sell on day zero without sourcing keys.
  You can disable this and run pure-BYOK by clearing `UPSTREAM_KEY` and adding
  channels manually.
- **Native subscription billing:** Pro / Max5x / Max20x / Ultra style monthly
  plans with both token quotas and rate limits, not just a dollar quota ticked
  down per token.
- **Brand customization:** the `brand_configs` table has per-tenant
  logo / primary_color / announcement / footer_html. SSR templates read it on
  every request. Other panels paint everyone the same colour.
- **Stack:** TS + Postgres is a deliberate bet on long-term maintainability
  (typed everything, no GORM surprises) at the cost of a slightly larger image.

## Maintainer activity (GitHub, last 90 days)

| Project              | Commits | Open issues | Last release | Active maintainers |
|----------------------|--------:|------------:|--------------|--------------------|
| one-api              |       4 |        1.2k | 2026-01-09   | 1 (low)            |
| new-api              |     280 |         920 | 2026-05-08   | 3                  |
| sub2api              |     410 |       1.17k | 2026-05-11   | 2                  |
| VoAPI                |      18 |          80 | 2026-01-27   | 1                  |
| Veloera              |      62 |          40 | 2026-02-11   | 1                  |
| **3api/relay-panel** | active  | open        | 2026-05-12   | 2 + community      |

`one-api` is in soft-maintenance; `new-api` is the most active fork. We track
both for upstream protocol changes.

## When to pick which

- **Self-host for yourself, no resale:** one-api or new-api is fine — you don't
  need tenancy or onboarding.
- **One brand, many customers, you own the keys:** new-api or sub2api.
- **You want to be the SaaS, with multiple resellers under you:** 3api.
- **You want to white-label and resell yourself:** 3api hosted, or 3api OSS
  on your own infra.
