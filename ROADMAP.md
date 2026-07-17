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
- [x] HTTP Basic Auth gate

**Acceptance:** ✅ four production sites onboarded read-only via one admin key each; one-command provision brings up a fresh sub2api site and the adapter drives it end-to-end.

---

## 🚧 P2 — Engine breadth + Channel Marketplace

Two tracks. The marketplace is the commercial core; the second engine is the ecosystem play.

### P2.1 — `adapter-newapi`
- [x] Map new-api admin API to `EngineAdapter` (session + access-token dual-header auth, channels/groups/users/settings/usage)
- [x] Compose template for new-api provisioning (`newapiCompose.ts`)
- [x] Capability flags where new-api and sub2api diverge
- [x] E2E verified against a live new-api instance (channels create/list/status-toggle/remove, groups, users, branding, usage)
- [ ] Wire new-api into the provisioning state machine (`NewapiLifecycle`) alongside sub2api

**Acceptance:** ✅ adapter drives a live new-api instance through the same interface as sub2api; both engines now selectable in dashboard + marketplace.

### P2.2 — Channel Marketplace (commercial core)
- [ ] `ChannelTemplate` model: upstream product (models, protocol, suggested ratio, param schema)
- [ ] `ChannelGrant` flow: operator enables a template → adapter injects a channel into the target site pointing at a per-site metering key
- [ ] Metering + settlement ledger (`UsageLedger`): attribute usage per grant, reconcile against upstream cost
- [ ] Marketplace is an optional, disableable plugin in the self-hosted build
- [ ] Operators can always configure their own upstreams — the marketplace is a recommendation, not a lock-in

**Acceptance:** enable a channel from the marketplace onto a test site, drive real traffic through the metering key, and see attributed usage + margin in the ledger.

### P2.3 — Dogfood
- [ ] Run P2 against our own fleet; validate settlement math on real traffic

---

## ⬜ P3 — Admin backend (write operations)

Turn the read-only dashboard into a real control panel.

- [ ] Operator accounts, sessions, RBAC
- [ ] Site management UI: provision / upgrade / start / stop / destroy from the panel
- [ ] Channel marketplace UI: browse templates, grant/revoke, view settlement
- [ ] Per-site drill-down: users, channels, usage trends
- [ ] Alerting: upstream down, low upstream balance, site unhealthy
- [ ] **One-command Docker deployment** for self-hosters (`docker compose up`)
- [ ] (Optional) `NssmLifecycle` — bare-metal Windows provisioning backend for operators who prefer no containers

**Acceptance:** a self-hoster deploys with one command and runs the full open/upgrade/monitor loop from the web UI without touching a shell.

---

## ⬜ P4 — Hosted SaaS

The managed offering. Same codebase, orchestrator runs on our infra.

- [ ] Multi-operator tenancy with strong isolation (per-operator network + data separation)
- [ ] Sign-up → automatic site provisioning
- [ ] Billing: operator subscription / usage plans, quotas
- [ ] Custom domain automation (add domain → TLS via Caddy → live)
- [ ] Operator-facing onboarding, docs, support surfaces

**Acceptance:** a new user signs up and has a branded, custom-domain relay station live without ever touching a server.

---

## ⬜ v1.0 — General Availability

Hardening across everything above.

- [ ] Observability: structured logs, metrics, audit trail on every write
- [ ] Backup / restore for orchestrator state and per-site data
- [ ] Security review: credential handling, tenant isolation, upstream ToS boundaries
- [ ] Documentation: self-host guide, adapter authoring guide, operations runbook
- [ ] Migration tooling: import an existing bare engine instance into a managed site

**Acceptance:** an operator can run relay-panel in production with confidence — provision, bill, fail over, back up, and recover — and a contributor can add a new engine adapter by following the docs.

---

## Cross-cutting principles (apply to every milestone)

- **Engines never modified** — all value through public admin APIs ([why](docs/LICENSE-COMPLIANCE.md)).
- **Credentials never in logs, errors, or commits.**
- **Additive on shared infrastructure** — never disrupt a running production service.
- **Read-only first** — new capabilities prove out read-only before any production write.
