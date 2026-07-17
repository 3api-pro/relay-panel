<div align="center">

# relay-panel

**One control plane for many LLM API relay stations.**

Provision, upgrade, and monitor any number of self-hosted [sub2api](https://github.com/Wei-Shaw/sub2api) / [new-api](https://github.com/QuantumNous/new-api) instances — engines stay unmodified, everything is driven from a single panel.

[![License: MIT](https://img.shields.io/badge/License-MIT-3d5afe.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43d17f.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Live demo](https://img.shields.io/badge/live%20demo-demo.3api.pro-6d8bff.svg)](https://demo.3api.pro)

**English** · [简体中文](README.zh-CN.md) — [**Live demo →**](https://demo.3api.pro)

<br/>

<img src="docs/media/overview-dark.png" alt="relay-panel — fleet overview" width="880" />

</div>

---

## Why

Running an API relay station on top of an open-source engine (sub2api / new-api) has a low barrier: get upstream channels, deploy the engine, set your markup, done. But **running several of them** — different brands, different audiences, different domains — turns into repetitive manual work: deploy, upgrade, configure, fail over, all multiplied by every instance and every engine release.

relay-panel collapses that into one control plane:

```
┌───────────────────── relay-panel (control plane) ─────────────────────┐
│  web admin (Vue SPA) · auth / RBAC / audit · job engine · alerts      │
│  site lifecycle · channel marketplace + ledger · billing · domains    │
├───────────────────────── engine adapter layer ────────────────────────┤
│         sub2api adapter          │          new-api adapter           │
├───────────────────── data plane (isolated per site) ──────────────────┤
│   site A: sub2api + PG   │   site B: new-api + DB   │       …         │
└───────────────────────────────────────────────────────────────────────┘
```

## Features

- **Site lifecycle** — one-click provision / pinned-version upgrade with auto-rollback / start / stop / destroy, driven by a job engine with per-step timelines.
- **Web admin backend** — Vue 3 SPA: fleet overview, per-site drill-down (channels / users / usage / domains / audit), job timelines. Liquid-glass UI with light/dark themes and **10-language i18n** (English / 中文 / 日本語 / 한국어 / Français / Deutsch / Español / Português / Italiano / Bahasa Indonesia).
- **Multi-engine, zero modification** — sub2api and new-api behind one adapter interface; engines always run official releases.
- **Channel marketplace** — upstream channel templates, one-click injection into any site (bring-your-own upstream, or managed keys issued by a metering gateway), with a usage/settlement ledger.
- **Alerting** — site down / job failed / channel disabled / low balance, with webhook notifications.
- **Multi-tenant RBAC** — root / operator / viewer roles, invite-based signup, session auth, full audit trail on every write.
- **Billing & quotas** — plans and subscriptions gate how many sites an operator can run (manual provisioning built in; payment gateways are an extension point).
- **Domain automation** — bind a domain in the panel, routes are pushed to Caddy's admin API, TLS is automatic.
- **Observability** — Prometheus `/metrics`, health probes, structured audit log.
- **Backup / restore** — one command dumps orchestrator state plus every site's database.
- **One-command deploy** — `docker compose up -d` from `deploy/`.

## Screenshots

> Try it live at **[demo.3api.pro](https://demo.3api.pro)** — read-only demo, sample data, resets periodically.

<table>
<tr>
<td width="50%"><img src="docs/media/site-detail.png" alt="Per-site drill-down with usage trends" /><br/><sub>Per-site drill-down — channels, users, usage trends, domains, audit</sub></td>
<td width="50%"><img src="docs/media/marketplace.png" alt="Channel marketplace" /><br/><sub>Channel marketplace — templates, grants, settlement</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/ledger.png" alt="Settlement ledger" /><br/><sub>Settlement ledger — usage, upstream cost, margin</sub></td>
<td width="50%"><img src="docs/media/alerts.png" alt="Alerting" /><br/><sub>Alerting — site down / job failed / channel disabled / low balance</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/overview-light.png" alt="Light theme" /><br/><sub>Light theme</sub></td>
<td width="50%"><img src="docs/media/billing-light.png" alt="Billing and quotas" /><br/><sub>Billing &amp; quotas · plans and subscriptions</sub></td>
</tr>
</table>

## Core principles

1. **Engines are never modified.** sub2api / new-api always run their official releases. All added value lives in the orchestration layer and is applied through each engine's own admin API. This keeps upgrades cheap and licensing clean (see [docs/LICENSE-COMPLIANCE.md](docs/LICENSE-COMPLIANCE.md)).
2. **One isolated instance per site.** No shared multi-tenancy at the data layer — clean isolation, independent upgrades, and any site can be exported as a stock engine instance at any time.
3. **Hosted and self-hosted share one codebase.** The only difference is whose server runs the orchestrator.

## Quick start

```bash
git clone https://github.com/3api-pro/relay-panel.git
cd relay-panel/deploy
cp .env.example .env   # set RP_SECRET_KEY, RP_ADMIN_EMAIL, RP_ADMIN_PASSWORD
docker compose up -d
```

Then open `http://<server>:7100` and log in. Full guide (env reference, reverse proxy, upgrades, backups, migration from the old Basic-Auth setup): **[docs/SELF-HOST.md](docs/SELF-HOST.md)**.

For development:

```bash
npm install
npm run typecheck
npm test
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/SELF-HOST.md](docs/SELF-HOST.md) | Deploy, configure, upgrade, back up |
| [docs/API.md](docs/API.md) | Full HTTP API reference |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Adapter interfaces + how to add a new engine |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Monitoring, alerting, backup/restore, troubleshooting |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, credential encryption, RBAC, disclosure |
| [docs/METERING-GATEWAY.md](docs/METERING-GATEWAY.md) | HTTP contract for the managed-marketplace metering gateway |
| [docs/CADDY.md](docs/CADDY.md) | Domain automation with Caddy |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design and rationale |

## Architecture

- **`packages/adapter-core`** — engine-agnostic domain types + the `EngineAdapter` / `EngineLifecycle` interfaces.
- **`packages/adapter-sub2api`** / **`packages/adapter-newapi`** — engine implementations (admin auth, channels/groups/users/settings/usage).
- **`packages/orchestrator`** — Fastify + Drizzle control plane: sites, jobs, auth/RBAC, marketplace + ledger, alerts, billing, domains, metrics, CLI.
- **`packages/web`** — Vue 3 + Vite + Tailwind admin SPA.

## Status & roadmap

This is a v2 rewrite; it is **not** compatible with the original relay-panel (a self-built relay engine), which is preserved on the [`legacy`](https://github.com/3api-pro/relay-panel/tree/legacy) branch.

- [x] **P1 — Fleet manager:** orchestrator + sub2api adapter + site lifecycle + read-only unified dashboard
- [x] **P2 — More engines + channel marketplace:** new-api adapter; channel templates, grants, metering/settlement ledger
- [x] **P3 — Admin backend:** operator accounts + RBAC, full write UI, alerting, one-command Docker deployment
- [ ] **P4 — Hosted SaaS:** multi-tenant RBAC, invite signup, quota/billing core, and domain automation are done; payment integration and hosted operations are extension points in progress

Full milestone plan through v1.0: [ROADMAP.md](ROADMAP.md).

## Sponsors

relay-panel's development is backed by these LLM API relay platforms — production users of the engines this project orchestrates:

<table align="center">
<tr><td align="center" width="520">
<a href="https://llmapi.pro"><b>llmapi.pro</b></a> — Unified multi-model LLM API · Claude · GPT · Gemini and more
</td></tr>
<tr><td align="center" width="520">
<a href="https://tieapi.com"><b>tieapi.com</b></a> — High-availability API gateway for teams and developers
</td></tr>
<tr><td align="center" width="520">
<a href="https://vipapi.ai"><b>vipapi.ai</b></a> — Premium LLM API access with flexible plans
</td></tr>
</table>

Interested in sponsoring? Open an [issue](https://github.com/3api-pro/relay-panel/issues).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The **engine adapter layer (`packages/adapter-*`) is the recommended entry point** for outside contributors — it contains no billing, upstream-routing, or credential logic, is self-contained and independently testable, and breaking it cannot touch production billing or tenant isolation. Want to bring a new engine? Follow [docs/ADAPTERS.md](docs/ADAPTERS.md).

## License

MIT for the orchestrator itself (see [LICENSE](LICENSE)). Orchestrated engines keep their own licenses — new-api ([AGPL-3.0](https://github.com/QuantumNous/new-api)), sub2api ([LGPL-3.0](https://github.com/Wei-Shaw/sub2api)); relay-panel invokes them only through their public admin APIs and never bundles or modifies them.
