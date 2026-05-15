# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Multi-protocol relay — `POST /v1/chat/completions` (OpenAI Chat Completions)
  and `POST /v1/responses` (OpenAI Responses API, used by Codex CLI `0.130+`)
  now route through the same pipeline as `/v1/messages` (auth, tenancy,
  allowlist, billing, usage logging).
- SSE usage extractor recognises OpenAI Chat Completions terminal-chunk
  `usage.{prompt,completion}_tokens` and Responses-API `response.usage` shapes
  alongside the existing Anthropic `usage.{input,output}_tokens`.

### Notes
- Whether the OpenAI paths actually work end-to-end depends on the upstream
  channel. The bundled wholesale upstream (`llmapi.pro`) supports all three
  protocols as of 2026-05-15. BYOK channels pointed at OpenAI-only or
  Anthropic-only endpoints will surface a 404 on the unsupported paths.

## [0.8.0] — 2026-05-12

- End-user `/dashboard/redeem` page completes the redemption-code flow
  (admin generates → customer pastes → quota credited atomically)
- `/embed/<slug>` SSR mini buy-box (1 KB) for bloggers to iframe a
  3-plan widget on their own sites; CSP allows any frame-ancestor

## [0.7.0] — 2026-05-12

- `/admin/logs` paginated per-request usage log with 4-axis filter
  (status / model / user / time)
- `/admin/redemption` batch generator (1-1000 codes, optional prefix +
  expiry, one-shot reveal + copy-all) plus per-code revoke
- `/models` public model catalogue (11 models × Anthropic / OpenAI /
  Google / DeepSeek / Moonshot / Qwen / MiniMax with wholesale vs BYOK
  badges)
- OpenAPI: 51 → 55 endpoints

## [0.6.1] — 2026-05-12

- Hotfix: admin sidebar overlapped main content on desktop (Tailwind
  has no `md:` variant of `fixed`; added `md:static md:z-auto`)

## [0.6.0] — 2026-05-12

- Mobile-responsive across landing + admin + onboarding (iPhone 14
  captured + visually verified)
- Admin sidebar drawer < md (hamburger toggle, off-canvas, backdrop)
- Landing CSS-only hamburger via checkbox-hack (no JS), hero h1 → 30px
- Onboarding stepper compact "N/5 + title" pill on mobile

## [0.5.1] — 2026-05-12

- OpenAPI: 5 `/platform/*` endpoints exposed (operator API,
  X-Platform-Token security scheme added)
- Webhooks admin pages fully localized (64 new i18n keys, zh/en parity)
- SCREENSHOTS.md documents the zh/en locale capture loop

## [0.5.0] — 2026-05-12

- Phase 2: per-tenant shadow `sk-` minted on demand via
  `/platform/tenants/{id}/upgrade-shadow` (consumes wholesale_balance)
- 5 provider real `healthCheck` (Anthropic / OpenAI / Gemini / DeepSeek
  / Moonshot) with `sample_models` + `latency_ms`
- Webhook system: subscribe to `order.paid` / `subscription.expired` /
  `refund.processed` / `wholesale.low`, HMAC SHA256 signed deliveries,
  retry + dead-letter table, admin UI to manage hooks
- OpenAPI auto-generated from `_openapi-meta.ts` → `docs/openapi.yaml`
- Bulk CSV order export (streamed)

## [0.4.0] — 2026-05-12

- Localization: zh + en, 1041 keys × 38 pages parity; cookie + nav
  language detect; LanguageSwitcher in TopBar
- 5 upstream providers wired (Anthropic / OpenAI / Gemini / DeepSeek /
  Moonshot) with channel-aware SSE transcoding for non-Anthropic
- Reseller-to-reseller affiliate (10% lifetime commission on referred
  tenants)
- Public-facing landing copy refresh; emoji → lucide-react icons
- Real Playwright screenshots replace placeholder SVGs

## [0.3.0] — 2026-05-12

- Dual-track billing — subscription plans + token packs in one UI
- Onboarding dual path: "Use recommended (wholesale)" vs BYOK
- Multi-key per channel + new-api parity on channels schema
- "0 inventory · one-click" positioning across marketing pages

## [0.2.0] — 2026-05-12

- shadcn/ui 12-component library + theme switcher (light/dark/auto)
- Sidebar + TopBar shell with 4 workspace groups, collapsible
- TanStack Table v8 across users / orders / channels
- Stat-card sparklines + auto-refresh on visibility-driven polling
- Daily check-in widget for end users
- Cmd+K command palette + driver.js onboarding tour
- Public pricing page on root domain
- Admin lives on root domain (drops subdomain login gate)

## [0.1.0] — 2026-05-12

First public release. MVP storefront for multi-tenant Claude-compatible
relay panel.

### Added

- Multi-tenant routing — subdomain (`<slug>.3api.pro`) plus custom-domain support
- Admin onboarding wizard (5 steps): upstream, branding, plan, test customer, verify
- End-user signup, login, password reset, email verification
- Plans CRUD with seeded defaults (Pro / Max5x / Max20x / Ultra)
- Orders, Subscriptions, API tokens with atomic order engine
- `POST /v1/messages` Anthropic-compatible relay with BYOK and wholesale fallback
- Per-token usage logging with billable cost in cents
- Brand-customizable storefront (logo, primary color, announcement, footer)
- Alipay checkout (sandbox) and USDT (TRC20 / ERC20) confirmation flow
- Resend transactional email integration with 5 templates
- One-process install — single Node container plus Postgres
- Docker compose for self-host
- `bash scripts/smoke-test.sh` covering 13 endpoints
- `bash scripts/smoke-byok.sh` end-to-end BYOK with mock upstream

### Security

- bcrypt password hashing (cost 10)
- JWT secrets required at boot (panel refuses to start with defaults)
- Per-tenant row-level isolation on every storefront query
- Webhook signature validation for Alipay notify

[Unreleased]: https://github.com/3api-pro/relay-panel/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.8.0
[0.7.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.7.0
[0.6.1]: https://github.com/3api-pro/relay-panel/releases/tag/v0.6.1
[0.6.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.6.0
[0.5.1]: https://github.com/3api-pro/relay-panel/releases/tag/v0.5.1
[0.5.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.5.0
[0.4.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.4.0
[0.3.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.3.0
[0.2.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.2.0
[0.1.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.1.0
