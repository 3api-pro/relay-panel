# P4 readiness — revised SaaS scope

Scope revised 2026-10-22: **customer self-deployment and existing-site connection only**. Platform hardware/server rental/provisioning are removed. The self-hosted application manager installs engines on the customer’s machine and manages their environment and lifecycle. SaaS does not supply that machine; customers remain responsible for infrastructure and backups.

| Area | Implemented | Acceptance boundary |
| --- | --- | --- |
| Accounts | Verification, recovery, MFA, one-use recovery codes, session revocation and persistent limits | Automated replay/expiry/session tests. Administrator phone enrollment remains a personal action. |
| Tenancy | Owner sites, workspace reader/editor roles, tab-local workspace selection, email-bound invites and revocation | Both-engine route matrix checks authorized and denied reads/writes, personal versus team context, membership revocation and disabled owners. Specialist tests cover external grants, finance, support, refunds and settlements; browser tab/request isolation is checked separately. Not an independent penetration test. |
| Delivery | Self-deployment guide, adoption, automatic IDs, nicknames and onboarding | Actual administrator browser acceptance required for each target release. No new platform hardware. |
| Billing | Verified payment recovery, prorated upgrades, scheduled downgrades, reviewed refunds and statements | Refunds happen in provider consoles. Controlled real-provider transactions remain necessary; tests do not prove settlement. |
| Customer operations | Preferences, notification retry, support tickets and audit export | SMTP configuration is not inbox delivery proof; crash retries can duplicate mail. |
| Operations | Readiness, online scheduled panel backups, retained history and file checks, durable lifecycle jobs and interrupted-job review | PGlite and isolated PostgreSQL backup/restore, file checks and process coordination tested; record target upgrade/restore and rollout evidence per release. Real Docker lifecycle acceptance still needs a test host. Remote engine backups/off-machine copies are separate. |
| Finance | Persistent request scans, supplier invoice comparison, historical rates and correction history | Sub2API evidence only; no customer debits. New API request evidence and recharge timezone remain unsupported/unverified. |

Commercial software workflows are present. P4 acceptance still requires actual provider purchase/renewal/change/refund journeys, controlled inbox delivery, personal administrator MFA enrollment and a target recovery record. Feature counts do not imply an accepted service or a reliable completion percentage. There is no remaining requirement to build or rent relay hardware.

See [SAAS-OPERATIONS.md](SAAS-OPERATIONS.md) and [FINANCE-COVERAGE.md](FINANCE-COVERAGE.md). Release evidence must distinguish tests, isolated database exercises, actual administrator checks and real provider transactions.
