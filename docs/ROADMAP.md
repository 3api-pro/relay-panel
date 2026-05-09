# 3API Panel — Execution Roadmap

> Single source of truth for "what's next, in what order, why, and how do
> we know it's done." Phases are sized to one shippable outcome each and
> are ordered so each phase makes the previous one user-visible.
>
> Status legend:  `[ ]` not started  `[~]` in progress  `[x]` done
>
> Source: PID v8 (`memory/project_llmapi_oss_resell.md`) + ARCHITECTURE.md
> + actual repo state on 5/9. Earlier "P0…P8" labels in the PID memo are
> retained for traceability but reorganized below into outcome-shaped
> phases.

## North-star

A distributor visits **3api.pro** and **within an hour**:

1. Self-onboards a panel at `<slug>.3api.pro`
2. Configures an upstream (their own sk-key, or our wholesale plan)
3. Creates an end-customer account, issues an sk-relay-* key
4. Customer uses the key to call `/v1/messages`, gets a real Claude
   response, and is billed correctly
5. Distributor sees usage / revenue in their admin dashboard

Until all five steps work end-to-end on the public domain, the SaaS is
**not done**. Every phase below pushes one more of the five into "really
works" territory.

---

## P0 — LIVE Infrastructure  `[x]` done 5/9

**Outcome**: 3api.pro is publicly reachable. Operator can create tenants
via the platform API. A new tenant can self-signup at /create/ and log
into their subdomain.

| Task | Commit | Status |
|---|---|---|
| 3api.pro DNS + Cloudflare tunnel ingress | (CF API direct) | `[x]` |
| Multi-tenant schema (8 tables) + tenant resolver | 5/8 | `[x]` |
| Operator-only POST /platform/tenants (X-Platform-Token) | a7f5f39 | `[x]` |
| Marketing landing on root domain (inline HTML) | 3ded8b2 | `[x]` |
| install.sh real-VPS path verified (mocked + real-build) | 2b286c0 | `[x]` |
| Next.js UI built + served via Express static | 43275b5 | `[x]` |
| Public POST /api/signup-tenant + /create/ form | 41b9583 | `[x]` |

**Smoke**:
```bash
# Anyone can run this and see the SaaS works at the onboarding layer
curl -X POST https://3api.pro/api/signup-tenant \
  -d '{"slug":"acme","admin_email":"x@y","admin_password":"longpw1234"}'
# → 201, then https://acme.3api.pro/admin/login/ renders
```

---

## P1 — BYOK Relay  `[ ]` next

**Outcome**: A distributor can paste their own sk-key + base_url into
the admin panel and immediately have a working Claude relay for their
customers — no wholesale dependency, no operator action needed.

This is the smallest cut of "the panel actually serves /v1/messages",
unblocking real revenue without waiting on wholesale prod-deploy.

### Tasks

- [ ] **P1.1** Schema: `upstream_channel.api_key_hash` not stored
      cleartext, `is_default` flag, `priority` for failover ordering
      (additive migration `db/migrations/002-upstream-channel-flags.sql`)
- [ ] **P1.2** Admin API: `POST/GET/PATCH/DELETE /admin/channels`
      (file `src/routes/admin-channels.ts`, mounted under existing
      adminRouter)
- [ ] **P1.3** `src/services/upstream.ts` — change `callUpstream` /
      `callUpstreamStream` to accept a resolved channel object (not
      env), keep env as fallback for self-host single-tenant
- [ ] **P1.4** `src/routes/relay.ts` — at request time, look up the
      tenant's active default channel; pass it to upstream client
- [ ] **P1.5** `src/services/billing.ts` — record channel id on
      usage_log so admin can see per-channel cost breakdown
- [ ] **P1.6** Admin UI: `ui/app/admin/channels/page.tsx` — list, add,
      edit, delete channels (inline form, no routing yet)
- [ ] **P1.7** smoke-byok.sh: full e2e
      - signup tenant → admin login → POST channel with real upstream
      - admin creates end-user → end-user logs in → issues token
      - curl `/v1/messages` with that token → response flows from real upstream → usage_log row written → end_user.used_quota_cents incremented

### Exit

Public smoke: a fresh tenant on auto-XXX.3api.pro relays a real
`/v1/messages` request through to llmapi.pro using a sk-* the operator
configured, and the response comes back. usage_log row exists.

**Estimated effort**: 1-2 days.

---

## P2 — Admin Dashboard usable without curl  `[ ]`

**Outcome**: A distributor can run their entire panel through the
browser. Today the Next.js admin/dashboard is 58 lines that lists
end-users and nothing else. After P2 the admin can manage every primary
object via UI.

### Tasks

- [ ] **P2.1** end-user CRUD UI (`/admin/end-users/` list +
      `/admin/end-users/[id]/` detail with topup, suspend, edit)
- [ ] **P2.2** token-issuance UI (per-end-user, on detail page)
- [ ] **P2.3** redemption-code generator UI (`/admin/redemption/`)
- [ ] **P2.4** usage-stats chart (`/admin/usage/` — `/admin/usage/summary`
      already returns daily aggregates, just chart with Recharts)
- [ ] **P2.5** sidebar layout component shared across admin pages
      (`ui/components/AdminLayout.tsx`)
- [ ] **P2.6** smoke-admin-ui.sh: Playwright-style synthetic walking the
      whole UI flow end-to-end

### Exit

Distributor admin signs up via /create/, logs in, creates an end-user,
tops them up ¥10, issues a key, and sees the usage dashboard — all from
the browser, zero curl.

**Estimated effort**: 2-3 days.

---

## P3 — Multi-mode billing + markup  `[ ]`

**Outcome**: Distributors can bill customers in 4 modes and the panel
defaults retail = wholesale × 1.3 (per user direction 5/9).

### Tasks

- [ ] **P3.1** Schema additive (`db/migrations/003-billing-modes.sql`):
      - `end_token.billing_mode` enum: `subscription | burst_5h |
        weekly_requests | per_token`
      - `end_token.billing_config` JSONB (mode-specific limits)
      - `end_token.price_per_unit_cents` (for per_token mode)
      - `tenant.config.default_markup_pct` defaults 30
- [ ] **P3.2** `src/middleware/quota-guard.ts` — branch on billing_mode
      - `subscription`: existing flat quota_cents
      - `burst_5h`: count requests in trailing 5h window vs
        billing_config.max_requests; reset on hour roll
      - `weekly_requests`: similar but trailing 7d
      - `per_token`: deduct price_per_unit_cents × tokens
- [ ] **P3.3** Admin UI: per-token billing-mode picker + thresholds
- [ ] **P3.4** Customer dashboard: show current usage in mode units
      (e.g., "你已用 312/500 请求 (本周)")
- [ ] **P3.5** Tenant settings page: default markup pct, applies to
      future channel/end_user defaults
- [ ] **P3.6** smoke-modes.sh: 4 token rows, 4 modes, 4 quota verdicts

### Exit

Distributor can configure an end-user with "5h burst, 100 requests / 5h"
mode. End-user calls /v1/messages 100 times in 4h → 101st returns
429 quota_exceeded. After 5h rolls, allowed again.

**Estimated effort**: 3-4 days.

---

## P4 — Payment intake  `[ ]`

**Outcome**: End customers can pay through the panel without manual
intervention. Distributor receives funds; we take a small platform fee.

### Tasks

- [ ] **P4.1** Pick rails (decision needed: 支付宝个人收款 / Stripe /
      Paddle / 都接 — out-of-scope here, depends on tenant residency)
- [ ] **P4.2** Schema: `payment_order` table (id, tenant_id, end_user_id,
      amount_cents, provider, provider_ref, status, created_at,
      paid_at)
- [ ] **P4.3** Provider abstraction: `src/services/payment/{alipay,
      stripe,paddle}.ts`
- [ ] **P4.4** Webhook handlers: `src/routes/webhook-{alipay,stripe,
      paddle}.ts` with signature verification
- [ ] **P4.5** Customer dashboard: "充值" button → choose amount →
      provider checkout → webhook lands → quota_cents incremented
- [ ] **P4.6** Admin UI: payment list page; manual refund button
- [ ] **P4.7** Reconciliation cron: nightly check provider records vs
      our payment_order rows for drift

### Exit

A real human (not me) on a real device pays ¥10 via the panel; their
quota_cents goes from 0 to 1000; usage_log starts producing rows when
they use the key.

**Estimated effort**: 2-3 days per provider.

---

## P5 — Wholesale upstream deployed  `[ ]`

**Outcome**: Distributors can opt out of BYOK and use our wholesale
plans (Pro ¥29 / Max5x ¥149 / Max20x ¥299 / Ultra ¥599) directly through
the panel. They buy a plan via wholesale API → panel stores returned
sk-* in upstream_channel → P1.4 already routes through it.

### Tasks

- [ ] **P5.1** Merge master into feat/wholesale-resell (audit at
      `/root/llmapi-resell/WHOLESALE_DEPLOY_READINESS.md`) — currently
      blocked by missing l3/l4-telemetry files on feat branch
- [ ] **P5.2** Build llmapi container off merged branch
- [ ] **P5.3** Deploy to **hot** container first; 24h smoke
- [ ] **P5.4** Swap to prod via existing canary-drain script
- [ ] **P5.5** Panel admin UI: "use wholesale" toggle. When on, a
      tenant's wsk-key + balance is shown; admin can buy plans → panel
      auto-creates upstream_channel rows from returned sk-*
- [ ] **P5.6** smoke-wholesale.sh: full e2e
      - admin enables wholesale
      - admin top-up reseller balance via operator API (or stripe-paid)
      - admin buys Pro monthly plan via UI
      - upstream_channel row appears with sk-* from wholesale response
      - end-user calls /v1/messages → flows through wholesale-issued key

### Exit

Distributor doesn't have to bring their own sk-key. They put money in,
buy plans through panel UI, and get working channels.

**Estimated effort**: 1 day for deploy + 1 day for panel toggle.

---

## P6 — Terminal experience polish  `[ ]`

**Outcome**: The panel feels like a real product per-tenant, not "3api
panel pretending to be acme.com".

### Tasks

- [ ] **P6.1** Branding: tenant.branding JSONB schema; admin can set
      logo URL + brand_name + primary color; UI reads on every page
- [ ] **P6.2** Email: SMTP config in tenant.config; transactional
      emails (welcome, password reset, payment receipt, low-balance
      warning); templates per-language
- [ ] **P6.3** Custom domain binding via Caddy on-demand TLS (the
      Caddyfile already has the structure commented out)
- [ ] **P6.4** Per-tenant pricing page (`/pricing/`) generated from
      end-user billing modes admin enabled
- [ ] **P6.5** i18n full sweep — already mostly bilingual but spotcheck

### Exit

A distributor can set up acme.3api.pro to look like ACME's brand, with
ACME's logo, ACME's pricing, ACME's emails. End customer never sees
"3api" anywhere.

**Estimated effort**: 3-4 days.

---

## P7 — Flagship brand site #1  `[ ]`

**Outcome**: We run our own first hosted brand on top of the panel,
targeting Cursor / Claude Code users (per user direction 5/9). It's
indistinguishable from a hand-built SaaS.

### Tasks

- [ ] **P7.1** Brand decision (name, domain, visual identity) — needs
      user input
- [ ] **P7.2** Provision the tenant via /api/signup-tenant
- [ ] **P7.3** Apply brand assets (P6.1 dependency)
- [ ] **P7.4** SEO content tuned to Cursor/CC audience, leaning on
      existing 11 drafts in `docs/articles/_roadmap.md`
- [ ] **P7.5** Cursor/X outreach plan, separate from the OSS panel
      outreach (P8)

### Exit

The brand site is live, ranks for one Cursor-related long-tail in 30
days, has its first 10 paid end-customers.

**Estimated effort**: 1 week of work + DAU acquisition takes longer.

---

## P8 — OSS launch / outreach  `[ ]`

**Outcome**: The OSS panel itself reaches developers who self-host. We
get feedback, contributors, and a reputation.

### Tasks

- [ ] **P8.1** Polish demo screenshots / README hero
- [ ] **P8.2** Submit to HN / V2EX / Reddit r/SelfHosted / Linux.do
      (drafts already in `docs/launch/hn-show.md`)
- [ ] **P8.3** Tag v0.1.0 release on GitHub with changelog
- [ ] **P8.4** Reach out to 5-10 known distributors via private channels
- [ ] **P8.5** Watch issue tracker; turn first 3 issues into PRs
      promptly to seed maintainer-trust

### Exit

100+ stars on GitHub, 3+ external contributors, 1+ PR merged, 5+
mentions in independent posts.

**Estimated effort**: 1-2 weeks active outreach.

---

## Rules of engagement

1. **One phase at a time.** Don't half-finish P3 to chase P5. Each
   phase has a single Exit criterion that gets verified before
   starting the next.
2. **No phase ships without its smoke test.** Tests live in `scripts/`
   and run against the real panel container.
3. **Memory updates per phase.** When a phase ships, update
   `memory/project_llmapi_oss_resell.md` + the index entry in
   `MEMORY.md`. Don't leave stale "in progress" claims.
4. **User-visible URL always works.** Each phase ends with the public
   URL still serving everything earlier phases delivered.
5. **Rebuild + restart on every behavioral change.** `docker restart`
   uses the OLD image — must `docker rm -f && docker run`.
6. **Capture-replay before prod-y ops.** Wholesale deploy especially:
   no canary without offline replay.

---

## Current blockers (5/9)

- **Blocking next phase (P1)**: nothing. I can start it now.
- **Blocks P5**: feat/wholesale-resell missing l3/l4-telemetry — needs
  master merge before deploy will compile.
- **Blocks P4**: payment provider choice (yiun收款 / 闪电付 / Paddle /
  Stripe) — depends on whether we want China-mainland or
  international rails first.
- **Blocks P7**: brand name + visual + domain decision.
- **Blocks P8**: only "we want to commit to maintaining the OSS in
  public" — drafts and infra are ready.
