# Hosted SaaS Guide

How to run relay-panel as a hosted, multi-tenant SaaS — and what the operator experience looks like. For single-tenant self-hosting, see [SELF-HOST.md](SELF-HOST.md).

## What operators get

An operator (your customer) signs up, then can:

1. **Launch new sites** — one-click provisioning of a relay site (sub2api or new-api), with an isolated database, pinned engine version, and admin account. No server access needed.
2. **Connect existing sites** — bring sites they already run under unified management by entering the site URL and an admin credential (API key, or admin email + password). The panel verifies the credential against the live site before accepting it. Nothing is migrated or modified.
3. **See everything in one place** — health, upstream status, usage and cost aggregated across all their sites.
4. **Subscribe self-serve** — pick a plan, pay (Alipay / WeChat Pay / USDT), and the site quota applies immediately.
5. **Custom domains** — add a domain and get automatic TLS (requires [Caddy integration](CADDY.md)).

### Connected (external) sites: the safety model

- Connecting stores the admin credential AES-256-GCM-encrypted; it is verified once at connect time and never shown again.
- The panel talks to a connected site **only through its public admin API**. Container lifecycle (start/stop/upgrade/destroy) is refused for connected sites at the code level.
- Each site has a **read-only fuse** (recommended ON for production sites at connect time): while enabled, the panel refuses every engine write (channels, users, branding, marketplace grants) for that site. Monitoring keeps working. Toggle it in site settings.
- Connected sites count toward the operator's site quota, same as provisioned ones.

## Enabling the SaaS surface

```bash
RP_SIGNUP_MODE=open        # or 'invite' for invite-only onboarding
RP_SECRET_KEY=<64-hex>     # required: credential + payment-config encryption
```

Plans are seeded (`free` / `pro` / `scale`) and editable in the `plans` table. Quota semantics: an operator with no active subscription falls back to the `free` tier.

### Payments (self-serve subscriptions)

Configure at least one payment provider as root: **Billing → Payment providers → Add provider**, or via `POST /api/billing/providers`. See [PAYMENTS.md](PAYMENTS.md) for provider config shapes, webhook URLs, and the settlement model. With no provider configured, the panel falls back to manual granting (root opens subscriptions by hand) — nothing breaks.

### Support surface

Set your support email / ticket portal / docs link as root under **Help & Support → Edit** (stored in `app_settings['support_contact']`). Operators see these on their Help page.

## Operator onboarding flow

1. Sign up (open mode) or redeem an invite link (invite mode).
2. Land on the panel; the Help page and the empty Sites page both offer the two paths: **launch a new site** or **connect an existing one**.
3. Free tier allows 1 site; the Billing page offers self-serve subscription for more.

## Root operations

- `GET /api/billing/orders?all=1` — all payment orders (an order stuck in `paid` means money arrived but activation failed; re-check with the order number, then grant manually if needed).
- Manual grant / cancel — Billing → Subscriptions (unchanged from before payments existed).
- Audit trail records every checkout, payment completion, provider config change, site adoption, and read-only toggle.

## Dogfooding checklist (bringing your own fleet in)

1. Connect each production site with **read-only ON**.
2. Watch aggregation/alerting for a few days; validate usage and settlement numbers against the engines' own dashboards.
3. Lift read-only one non-critical site at a time when you want panel-side management.
4. Keep the orchestrator itself off the public internet or behind your access layer until the security review (ROADMAP v1.0) is complete — it holds admin credentials for every connected site.
