# SaaS operations

## Product boundary

Customers use the self-hosted panel to install and manage Sub2API / New API on their own machine, or connect existing installations. SaaS provides panel management and quotas, not hardware, relay hosting or upstream usage. `POST /api/sites` returns 410 in SaaS regardless of the local switch. Self-hosting includes an application catalog, environment checks, local installation, lifecycle and interrupted-install retry. IDs and ports are automatic; names are editable nicknames. See [local environment setup](SELF-HOST.md).

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `RP_DEPLOYMENT_MODE` | `self-hosted` | Set `saas` for a public multi-tenant panel. |
| `RP_PUBLIC_URL` | unset | Canonical HTTP(S) origin for account emails; HTTPS enables Secure cookies. Links never use request Host. |
| `RP_REQUIRE_EMAIL_VERIFICATION` | on in SaaS | New accounts verify before login. Legacy accounts are grandfathered; migration timestamps are not proof of historical verification. |
| `RP_REQUIRE_ADMIN_MFA` | `0` | Enroll every root before enforcing. Save recovery codes outside the panel. |
| `RP_LOCAL_PROVISION_ENABLED` | `1` | Local self-hosted installation; always disabled in SaaS. |
| `RP_BACKUP_DIRECTORY` | `./data/panel-backups` | Private writable backup directory. |
| `RP_BACKUP_INTERVAL_MS` | `0` | Backup cadence; compose defaults to daily. |
| `RP_PG_DUMP_COMMAND` | `pg_dump` | Executable compatible with the database server. |

Account email requires `RP_PUBLIC_URL`, `RP_SECRET_KEY` and existing `RP_SMTP_*` settings. Required-verification signup fails closed if mail is unconfigured. Configuration readiness does not prove inbox delivery. Verify mail with an inbox you control.

## Accounts and workspaces

Verification/reset tokens are hashed, expire after 30 minutes and are consumed atomically. Links use URL fragments that the page clears immediately. Requests have persistent IP/account limits and uniform account-discovery responses. MFA-enabled recovery requires TOTP or a recovery code. TOTP secrets are encrypted; counters prevent replay. Ten hashed recovery codes are each usable once. Setup expires after ten minutes. MFA changes revoke sessions/tokens; password changes revoke other sessions. Database locks coordinate login, recovery and MFA changes.

Platform root/operator/viewer roles remain separate from team membership. Viewer is platform-wide read-only. A workspace selected through `X-Workspace-Id` grants reader/editor access to its owner's sites and quotas, never root authority. Readers cannot write; billing remains owner-only. Security, notifications and support stay personal. Invitations bind a random token to an email, expire after seven days and can be revoked. Owners copy the one-time invite link. Membership is checked on each request; revocation affects subsequent requests, not already-running operations.

From v2.13.1, browser selection is stored per tab and bound to the signed-in account. Requests and file exports use the current page's context, so a different tab cannot silently change the target of an open form. Switching requires a new page load; failed browser storage prevents switching. The old shared selection is ignored on upgrade, so select the desired team again in each tab. Authentication cookies remain shared by the browser; this change does not create separate logins per tab.

References: [RFC 6238](https://www.rfc-editor.org/info/rfc6238/) and [OWASP recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). This is not an independent security certification.

## Refunds, statements and support

Refund requests reserve the refundable balance under an account lock. Customers may cancel pending requests; root approves/rejects. **Refund money in the payment provider console.** Completion requires a unique actual provider receipt and explicit entitlement handling: keep, cancel the matching pending change, or end the current subscription after a fresh preview. The panel does not transfer money. A fully refunded paid-but-unfulfilled order cannot later grant a subscription.

Statements contain CNY orders and confirmed refunds, not tax invoices or bank settlement. Up to 10,000 orders per export; optional `from`/`to` ISO timestamps with offsets filter order creation (`to` exclusive). Support tickets are visible only to their owner and root, with versioned replies/status.

Notifications have personal alert/billing/support preferences, an inbox, deduplication and bounded retry. Security emails bypass optional preferences; secret mail bodies are encrypted and erased after delivery/expiration. SMTP has at-least-once semantics: a crash after SMTP acceptance can cause a duplicate. Failed delivery and paid-but-unfulfilled orders appear in operations. Existing renewal reminders honor the billing email preference.

## Backup, upgrade and restore

`/readyz` checks database access; `/healthz` is process health. Operations reports migrations, mail configuration, administrators without MFA, overdue backups and fulfillment issues. Root can start a backup; a database lease prevents concurrent backup jobs.

Archives contain the **panel database only**, including encrypted credentials and customer/security/payment records. PostgreSQL uses online custom-format `pg_dump`; PGlite uses an online data-directory snapshot. Each archive has a SHA-256 manifest. Engine databases and environment secrets are excluded. Preserve the original `RP_SECRET_KEY` separately. Restrict Windows directory ACLs/POSIX permissions, copy backups off-machine and manage retention externally; old archives are not automatically deleted.

Before upgrading, verify a backup, stage the application, restore into an isolated database, run additive migrations and compare row counts. Apply migrations with a single application owner before exposing the new process. New migrations are 008–022; never edit already-applied migrations.

Restore PostgreSQL into a **new empty database** with `pg_restore --no-owner --no-privileges --dbname=<target> panel.dump`, keeping passwords out of argv. Start with the original encryption key and background mail/monitor/payment workers disabled until verified. For PGlite use `PGlite.create({ dataDir: '<new-empty-directory>', loadDataDir: new Blob([archiveBytes]) })`, close it, then configure `RP_DB=pglite:<directory>`. Never restore over a live database. Verify accounts, sites, orders, subscriptions, MFA and pending changes before switching traffic.

Older binaries ignore MFA/team state: **do not roll back to pre-MFA code after users enroll or use the new security state.** Prefer a forward fix. A failed initial cutover may revert code only before user exposure; never overwrite new business transactions with an old dump.

Connections explicitly use UTC. Historical timestamp-without-time-zone values are preserved: do not bulk-shift mixed legacy explicit-UTC and server-default timestamps. Validate historical reporting against source evidence.

Audit CSV omits payloads/credentials and scopes site records to the selected tenant. Each page returns up to 10,000 ascending IDs; pass `afterId` from `X-Next-After-Id` until an empty page. Spreadsheet formula prefixes are escaped.

## Supplier reconciliation

Root can compare a USD invoice over closed Beijing calendar dates, up to 31 days. Sub2API logs are scanned page by page, saved and deduplicated; scans resume after interruption. Changed totals or missing unique rows prevent completion. Unfinished scans can restart with a recorded reason. Split intervals over 100,000 records.

Cost coverage/account filters are displayed. Invoice differences require a complete scan with known costs for selected records. Historical rates require exact user/model/time scope and evidence notes. Active overlaps are rejected; erroneous rates can be voided with a reason and retained history. Estimates/CSVs never adjust balances or prove wallet settlement. Complete scans cover returned logs only, not unlogged requests or retention gaps.

New API equivalent request-level evidence is not supported. Recharge totals preserve the upstream calendar: Sub2API's dashboard day-count interface does not establish an authoritative timezone contract. This remains labeled unverified; cash dates are not relabeled as Beijing time. Supplier statements and wallet settlement need external verification.

## API surface

| Area | Routes |
| --- | --- |
| Recovery | `POST /api/auth/recovery/request`, `/complete` |
| MFA / sessions | `GET /api/auth/security`, `POST /api/auth/mfa/{setup,enable,disable,login}`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` |
| Teams | `GET /api/team/workspaces`, `GET/PUT /api/team`, `POST /api/team/invites`, `/accept`, `DELETE /api/team/invites/:id`, `PATCH /api/team/members/:id` |
| Notifications | `GET/PUT /api/notifications/preferences`, `GET /api/notifications`, `POST /api/notifications/:id/read` |
| Aftercare | `GET /api/billing/refunds`, `POST /api/billing/orders/:orderNo/refunds`, `PATCH /api/billing/refunds/:id`, `GET /api/billing/refunds/:id/preview`, `GET /api/billing/statement.csv` |
| Support | `GET/POST /api/support/tickets`, `GET /api/support/tickets/:id`, `POST /api/support/tickets/:id/messages` |
| Operations | `GET /api/onboarding`, `GET /api/admin/operations`, `POST /api/admin/operations/backup`, `GET /api/audit/export.csv` |
| Reconciliation | Under `/api/admin/reconciliation`: `GET/POST /`, `GET /:id`, `POST /:id/scan`, `POST /:id/restart`, `GET /:id/export.csv`, `GET/POST /rates`, `POST /rates/:id/void` |

## Restricted legacy maintenance archives

If an installation retains maintenance archive tables that the application role intentionally cannot read, `RP_BACKUP_EXCLUDE_TABLES` can list their exact `public.ops_backup_<name>` names, separated by commas. It defaults empty. Wildcards, other schemas and core application tables are rejected. This does not grant the panel access to old archived credentials. Exclusions appear in the administrator operations page and backup manifest; retain those archives separately if needed.


## Backup history and integrity checks (v2.13.0)

The root operations page records every new panel backup as running, succeeded, failed or interrupted, with cursor pagination and status filters. The latest successful creation is retained independently of the last attempt. Its most recent file check is displayed separately; freshness and scheduling use database time. Existing v1 manifests and archives are left in place, and the prior single-result summary remains a fallback until a new backup succeeds. Older files are not scanned or imported automatically.

Migration 022 adds `backup_runs` and `backup_checks`. Backup creation holds a database lease, renews it during long work and bounds the command/hash operation to ten minutes. Expired records retain interruption evidence; late results cannot publish success. PGlite snapshot generation itself has no cancellation API: a stalled snapshot can finish later, but its expired execution cannot publish a successful record. A database snapshot contains history as it existed at snapshot time, so its own attempt may still appear running after restoration; recheck the target host and files.

Each new archive has a v2 manifest. The database anchors both archive and manifest SHA-256 values. Root can verify a registered successful backup; the server bounds reads, rejects symlinks/non-regular files and arbitrary API paths, and records matching, missing, mismatched, unavailable or interrupted checks. Concurrent checks of the same archive are serialized, and stale checks cannot overwrite later evidence. Check results and their audit event commit together. The API exposes metadata only, never the archive body, credentials or private execution tokens.

A matching checksum means the file matched its creation record at check time. It does not prove a successful restore, an available encryption key, external engine backups or an off-machine copy. Continue isolated restoration drills before traffic switches. Failed/partial archives and older backups are not deleted automatically; filesystem permissions, Windows ACLs, off-machine copies and retention remain operator responsibilities. Stop old application/backup workers before upgrading; mixed old/new workers are unsupported.

New root routes: `GET /api/admin/operations/backups` (`status`, `beforeId`, `limit`), `GET /api/admin/operations/backups/:id/checks` (`beforeId`, `limit`), and `POST /api/admin/operations/backups/:id/verify` with no path or file input. The existing `POST /api/admin/operations/backup` remains available.
