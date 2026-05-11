# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v0.2.0

- Custom-domain auto-TLS via Caddy on-demand
- Referral program (reseller-to-reseller, recurring commission)
- Public OpenAPI spec generated from route definitions
- Per-plan rate-limit overrides
- en/zh i18n parity for storefront

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

[Unreleased]: https://github.com/3api-pro/relay-panel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/3api-pro/relay-panel/releases/tag/v0.1.0
