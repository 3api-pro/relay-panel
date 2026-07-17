# Roadmap — to v1.0

This is the full plan from the current state to the first stable release. Milestones ship in order; each is independently useful. Checkboxes track granular tasks. Acceptance criteria define "done".

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## ✅ P1 — Fleet Manager (MVP) · shipped

Manage an existing fleet from one place, without migrating anything.

- [x] Monorepo + `EngineAdapter` / `EngineLifecycle` interfaces (`adapter-core`)
- [x] sub2api adapter: admin bootstrap (login → compliance → admin-api-key), channels/groups/users/settings/usage
- [x] Site lifecycle: one-click provision, upgrade with auto-rollback, start/stop/destroy (Docker Compose, pinned engine images)
- [x] Site registry + credential resolution (`db:` / `devfile:` schemes, credentials never in repo)
- [x] Read-only unified dashboard: health / upstreams / usage / cost aggregated across all sites
- [x] HTTP Basic Auth gate *(superseded in P3 by session auth + RBAC; see [docs/SELF-HOST.md](docs/SELF-HOST.md) for migration)*

**Acceptance:** ✅ four production sites onboarded read-only via one admin key each; one-command provision brings up a fresh sub2api site and the adapter drives it end-to-end.

---

## ✅ P2 — Engine breadth + Channel Marketplace · shipped

Two tracks. The marketplace is the commercial core; the second engine is the ecosystem play.

### ✅ P2.1 — `adapter-newapi`
- [x] Map new-api admin API to `EngineAdapter` (session + access-token dual-header auth, channels/groups/users/settings/usage)
- [x] Compose template for new-api provisioning (`newapiCompose.ts`)
- [x] Capability flags where new-api and sub2api diverge
- [x] E2E verified against a live new-api instance (channels create/list/status-toggle/remove, groups, users, branding, usage)
- [x] Wire new-api into the provisioning state machine (`NewapiLifecycle` + `makeLifecycles` registry) alongside sub2api

**Acceptance:** ✅ `provision --engine newapi` brings up a fresh new-api site end-to-end (render → compose up → health → root init → credential), and the adapter drives it through the same interface as sub2api. Both engines selectable in dashboard, marketplace, and provisioner.

### ✅ P2.2 — Channel Marketplace (commercial core)
- [x] `ChannelTemplate` model: upstream product (models, protocol, suggested ratio, param schema)
- [x] `ChannelGrant` flow: operator enables a template → adapter injects a channel into the target site pointing at a per-site metering key
- [x] Metering + settlement ledger (`UsageLedger`): attribute usage per grant, reconcile against upstream cost (gateway pull loop + manual import; gateway HTTP contract in [docs/METERING-GATEWAY.md](docs/METERING-GATEWAY.md))
- [x] Marketplace is an optional, disableable plugin in the self-hosted build (managed mode inert unless a metering gateway is configured)
- [x] Operators can always configure their own upstreams — the marketplace is a recommendation, not a lock-in (`byo` templates + direct channel CRUD per site)

**Acceptance:** enable a channel from the marketplace onto a test site, drive real traffic through the metering key, and see attributed usage + margin in the ledger.

### ⬜ P2.3 — Dogfood
- [ ] Run P2 against our own fleet; validate settlement math on real traffic

---

## ✅ P3 — Admin backend (write operations) · shipped

Turn the read-only dashboard into a real control panel.

- [x] Operator accounts, sessions, RBAC (root / operator / viewer, invite signup, audit on every write)
- [x] Site management UI: provision / upgrade / start / stop / destroy from the panel (job engine with per-step timelines)
- [x] Channel marketplace UI: browse templates, grant/revoke, view settlement
- [x] Per-site drill-down: users, channels, usage trends
- [x] Alerting: site unhealthy, job failed, channel disabled, low upstream balance — with webhook notifications
- [x] **One-command Docker deployment** for self-hosters (`docker compose up`, see [docs/SELF-HOST.md](docs/SELF-HOST.md))
- [ ] (Optional, not planned for v1.0) `NssmLifecycle` — bare-metal Windows provisioning backend for operators who prefer no containers

**Acceptance:** a self-hoster deploys with one command and runs the full open/upgrade/monitor loop from the web UI without touching a shell.

---

## 🚧 P4 — Hosted SaaS

The managed offering. Same codebase, orchestrator runs on our infra. The platform core is done; payments and hosted operations remain.

- [x] Multi-operator tenancy: RBAC + per-operator site ownership on top of per-site container/data isolation
- [x] Sign-up (open / invite modes) → operators provision their own sites from the panel within quota
- [x] Billing core: plans, subscriptions, per-operator site quotas (manual provisioning by root; `PaymentProvider` interface as the extension point)
- [x] Custom domain automation (add domain → routes pushed to Caddy admin API → auto TLS, see [docs/CADDY.md](docs/CADDY.md))
- [ ] Payment integration (Stripe / other gateways) on the `PaymentProvider` extension point
- [ ] Operator-facing onboarding, docs, support surfaces for the hosted offering

**Acceptance:** a new user signs up and has a branded, custom-domain relay station live without ever touching a server.

---

## 🚧 v1.0 — General Availability

Hardening across everything above.

- [x] Observability: structured logs, Prometheus metrics, audit trail on every write
- [x] Backup / restore for orchestrator state and per-site data (`backup` / `restore` CLI, runbook in [docs/OPERATIONS.md](docs/OPERATIONS.md))
- [ ] 🚧 Security review: credential handling, tenant isolation, upstream ToS boundaries (design doc shipped in [docs/SECURITY.md](docs/SECURITY.md); external review in progress)
- [x] Documentation: self-host guide, API reference, adapter authoring guide, operations runbook, security design
- [x] Migration tooling: import an existing registry (`import-registry`) or adopt a bare engine instance into a managed site (`adopt`)

**Acceptance:** an operator can run relay-panel in production with confidence — provision, bill, fail over, back up, and recover — and a contributor can add a new engine adapter by following the docs.

---

## Cross-cutting principles (apply to every milestone)

- **Engines never modified** — all value through public admin APIs ([why](docs/LICENSE-COMPLIANCE.md)).
- **Credentials never in logs, errors, or commits.**
- **Additive on shared infrastructure** — never disrupt a running production service.
- **Read-only first** — new capabilities prove out read-only before any production write.
