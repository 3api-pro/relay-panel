# P4 readiness — v2.2.0

Reviewed on 2026-10-22 against the current code and available validation records. The original P4 scope is a hosted panel for individual site operators. Its seven core capabilities exist; full release acceptance is still open. This assessment does not treat missing validation as a confirmed defect.

| Original P4 capability | Implementation and evidence | Remaining acceptance |
| --- | --- | --- |
| Operator tenancy | Site ownership, root/operator/viewer guards; owner checks in sites, jobs, alerts and billing | Complete the resource-by-role matrix, including derived records and exports. `viewer` is platform-wide read-only, not tenant-scoped membership. |
| Signup and provisioning | Open/invite signup, quotas, provisioning jobs and both engine adapters | Repeat a fresh operator journey through provisioning success, failure and retry in an isolated deployment. |
| Billing and quotas | Frozen quotes, prorated upgrades, term-end downgrades, quotas; automated and isolated PostgreSQL concurrency/recovery checks | Close the real-provider acceptance matrix for purchase, renewal, upgrade, downgrade, late payment and interrupted fulfillment. |
| Domains and TLS | Domain routes, Caddy integration and routing tests | Verify DNS, TLS issuance and rollback with a controlled domain in the target deployment. |
| Payment integration | Alipay, WeChat Pay and USDT providers; verified queries, credential snapshots and recoverable fulfillment | Provider code and simulated tests do not replace controlled real-payment and refund reconciliation acceptance. |
| Connect existing sites | Live credential verification, encryption, read-only fuse, quotas, automatic IDs and editable nicknames | Administrator desktop/mobile flows are verified; repeat the complete operator-owned flow and cross-operator denials. |
| Onboarding and support | Help, empty-state guidance, configurable support contact and role-specific navigation | Validate onboarding through support, notification delivery/preferences and audit access without administrator intervention. |

## Three gates to close the original P4 acceptance

1. **A complete new-operator journey:** signup → verified payment → provision or adopt → BYO/marketplace → domain/TLS → renewal/change; include failure and retry paths. Use controlled accounts/providers and record outcomes without creating customer charges for testing.
2. **Tenant and role verification:** exercise every customer-visible resource and write path with two separate operators, root and platform viewer. Existing tests cover parts of this matrix; do not imply a complete independent security audit.
3. **Delivery and recovery:** run clean install and v2.1.0 → v2.2.0 upgrade/restore drills for hosted and documented self-hosted deployments; verify SMTP, migrations, interrupted payment recovery and compatible rollback. Isolated PostgreSQL and application backup drills already exist, but do not cover every deployment path.

No reliable percentage or delivery date follows from feature counts alone. Core implementation is substantially present; the remaining P4 work is mostly end-to-end acceptance and any fixes it exposes.

## Additional product scope

These are useful for a broader commercial SaaS, but were not all part of the original seven-item P4 definition:

- Organizations, member invitations and tenant-scoped roles. The current ownership unit is an operator account.
- Automatic refunds, billing documents and a complete refund/reconciliation workflow. Paid scheduled changes currently require reviewed correction.
- Historical-rate underbilling estimates, supplier invoice reconciliation, recharge timezone verification and complete model/customer/channel coverage. Request review currently supports Sub2API page scans; it is not a full financial audit or proof of wallet settlement.
- Per-tenant notification preferences, expanded support workflows and audit export acceptance.

See [BILLING.md](BILLING.md), [FINANCE-COVERAGE.md](FINANCE-COVERAGE.md), [FINANCE-REVIEW.md](FINANCE-REVIEW.md), and [HOSTED.md](HOSTED.md).
