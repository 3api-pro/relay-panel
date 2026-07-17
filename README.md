<div align="center">

# relay-panel

**One control plane for many LLM API relay stations.**

Provision, upgrade, and monitor any number of self-hosted [sub2api](https://github.com/Wei-Shaw/sub2api) / [new-api](https://github.com/QuantumNous/new-api) instances — engines stay unmodified, everything is driven from a single panel.

[![License: MIT](https://img.shields.io/badge/License-MIT-3d5afe.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43d17f.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-f0b74a.svg)](CONTRIBUTING.md)

**English** · [简体中文](README.zh-CN.md)

</div>

---

## Why

Running an API relay station on top of an open-source engine (sub2api / new-api) has a low barrier: get upstream channels, deploy the engine, set your markup, done. But **running several of them** — different brands, different audiences, different domains — turns into repetitive manual work: deploy, upgrade, configure, fail over, all multiplied by every instance and every engine release.

relay-panel collapses that into one control plane:

```
┌────────────────── relay-panel (control plane) ──────────────────┐
│   site lifecycle    domains + TLS    unified dashboard    channels │
├────────────────────── engine adapter layer ────────────────────┤
│        sub2api adapter        │        new-api adapter           │
├──────────────────── data plane (isolated per site) ─────────────┤
│   site A: sub2api + PG   │  site B: new-api + MySQL  │   …        │
└─────────────────────────────────────────────────────────────────┘
```

## Core principles

1. **Engines are never modified.** sub2api / new-api always run their official releases. All added value lives in the orchestration layer and is applied through each engine's own admin API. This keeps upgrades cheap and licensing clean (see [docs/LICENSE-COMPLIANCE.md](docs/LICENSE-COMPLIANCE.md)).
2. **One isolated instance per site.** No shared multi-tenancy at the data layer — clean isolation, independent upgrades, and any site can be exported as a stock engine instance at any time.
3. **Hosted and self-hosted share one codebase.** The only difference is whose server runs the orchestrator.

## How you run it

- **Self-hosted (open source):** manage your own fleet on your own servers.
- **Hosted SaaS** *(planned):* sign up and get a station, no server required.

## Architecture

Full design and rationale in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- **`packages/adapter-core`** — engine-agnostic domain types + the `EngineAdapter` / `EngineLifecycle` interfaces.
- **`packages/adapter-sub2api`** — sub2api implementation (admin bootstrap, channels/groups/users/settings/usage).
- **`packages/orchestrator`** — Fastify + Drizzle control plane: site registry, provisioning state machine, aggregate dashboard.

## Status & roadmap

Early development. This is a v2 rewrite; it is **not** compatible with the original relay-panel (a self-built relay engine), which is preserved on the [`legacy`](https://github.com/3api-pro/relay-panel/tree/legacy) branch.

- [x] **P1 — Fleet manager:** orchestrator + sub2api adapter + site lifecycle (one-click provision / upgrade-with-rollback / destroy) + read-only unified dashboard (health / upstreams / usage / cost across all sites)
- [ ] **P2 — More engines + channel marketplace:** new-api adapter; one-click upstream-channel injection with revenue split
- [ ] **P3 — Admin backend:** write operations on top of the dashboard (provision / configure / users / channels)
- [ ] **P4 — Hosted SaaS:** sign-up provisioning, billing, quotas

> Today the project ships a **read-only dashboard and a CLI orchestrator only** — there is no web admin backend yet. Follow the `main` branch for updates.

## Quick start

```bash
npm install
npm run typecheck
npm test
```

> A one-command Docker deployment for self-hosters lands with P3. For now the orchestrator is driven via its CLI and a site registry file.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The **engine adapter layer (`packages/adapter-*`) is the recommended entry point** for outside contributors — it contains no billing, upstream-routing, or credential logic, is self-contained and independently testable, and breaking it cannot touch production billing or tenant isolation. The highest-value standalone task right now is implementing **`adapter-newapi`**.

## License

MIT for the orchestrator itself (see [LICENSE](LICENSE)). Orchestrated engines keep their own licenses — new-api ([AGPL-3.0](https://github.com/QuantumNous/new-api)), sub2api ([LGPL-3.0](https://github.com/Wei-Shaw/sub2api)); relay-panel invokes them only through their public admin APIs and never bundles or modifies them.
