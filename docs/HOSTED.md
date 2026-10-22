# Hosted management panel

The SaaS hosts the panel, not relay hardware. Customers deploy Sub2API / New API on their own servers or connect engines they already operate. Hardware, server rental and platform-managed relay provisioning are outside the product scope.

1. Register, verify email and configure account security.
2. Run the self-hosted panel on your machine to install/manage engines through **Self-hosting & applications**, or deploy an engine yourself.
3. Choose **Connect existing site**, enter its URL/admin credential and an optional nickname. IDs are automatic; nicknames stay editable. Live verification does not migrate engine data. Keep read-only enabled for initial monitoring.
4. Subscribe for site quotas. Upgrades charge a prorated difference; downgrades apply at the current term boundary. See [BILLING.md](BILLING.md).
5. Invite team readers/editors, choose notification preferences and use support or billing aftercare.

Credentials are encrypted. Connected engines expose only their admin API: container lifecycle operations are refused. Disabling read-only enables channels/users/branding management, not server management. Customer engine DNS/TLS and backups remain the customer's responsibility. Existing local managed sites keep legacy lifecycle support.

Public operation requires `RP_DEPLOYMENT_MODE=saas`, HTTPS `RP_PUBLIC_URL`, `RP_SECRET_KEY`, SMTP and backups. Verification defaults on. Enroll every root before enforcing MFA. Expired subscriptions fall back to free quotas; existing sites are not destroyed.

[Operations, security and API details](SAAS-OPERATIONS.md) · [P4 acceptance](P4-READINESS.md) · [Self-hosting](SELF-HOST.md).
