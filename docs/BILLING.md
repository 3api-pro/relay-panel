# Billing changes and payment recovery

A billing month is 30 days. Existing paid subscriptions keep a monthly-price snapshot; the migration initializes legacy snapshots from the current catalog because historical paid rates were not stored.

- New purchase starts after confirmed payment. Same-plan renewal adds time to the later of now and the current expiry, at the subscription's frozen monthly rate.
- Upgrade charges `(target monthly price − current monthly price) × remaining milliseconds / (30 days)`, rounded up to the nearest cent (minimum ¥0.01). It applies after verified payment and keeps the original expiry, including any prepaid remaining months.
- A lower-priced or equal-priced different plan is scheduled at the current expiry. Paid downgrades prepay the selected following period now. A free downgrade charges nothing. Existing sites are never stopped or deleted by a quota reduction.
- Only one scheduled change may exist. A free scheduled downgrade can be cancelled. Paid scheduled changes require a reviewed refund/correction before removal; there is no automatic refund API.
- Preview quotes are owner-scoped, expire after five minutes (or the current expiry, whichever is earlier), and can create one checkout. Orders retain the immutable quote. Concurrent same-plan renewals stack; conflicting changes or late cross-plan payments remain paid for review without overwriting benefits.
- Manual grants support new subscriptions and same-plan renewals. They cannot silently replace an unexpired plan.

## API

All routes require an authenticated session and normal CSRF checks.

| Route | Role / purpose |
| --- | --- |
| `POST /api/billing/quote` | Operator: `{planKey, months}` → `{quote}` |
| `POST /api/billing/checkout` | Operator: `{planKey, months, providerKey, quoteId}` → `{order}`; legacy calls without `quoteId` support only purchase/renewal |
| `POST /api/billing/changes` | Operator: `{quoteId}` schedules a free downgrade |
| `DELETE /api/billing/changes` | Operator: cancels an unpaid/free scheduled downgrade |
| `POST /api/billing/orders/:orderNo/reconcile` | Order owner or root: recheck, subject to per-order throttling |
| `GET /api/billing/orders?all=1` | Root: latest 200 orders with operator email and reconciliation state |

Subscription responses include `pendingChange`. Order responses include `change`, `reconciliationError` and `lastCheckedAt`. Neither endpoint exposes payment credentials or raw gateway responses.

## Recovery and verification

Payment verification records `paid` first. Under a database operator-row lock, subscription changes, order completion and audit then commit atomically. A failure rolls all entitlement writes back; another worker or process can retry safely. Legacy `paid` orders with `fulfillment_version=0` are ambiguous and must be reviewed rather than granted again.

The worker checks up to 25 orders every `RP_PAYMENT_RECONCILE_INTERVAL_MS` (default 60 seconds; 0 disables it). It retries paid/unfulfilled orders and rechecks other unfinished orders created in the last seven days, including local cancellations and expirations. Older orders remain available for explicit recheck/webhooks. This process queries gateways; it does not create charges or send email. Disabling a payment method blocks new checkouts while retaining reconciliation. A provider with order history cannot be deleted.

Every new order stores an encrypted credential snapshot and, for ChainPay, the exact USDT conversion amount and chain used at creation. Reconciliation does not recompute FX. ChainPay checks authenticated order ID, external ID, amount, currency, chain and live environment; legacy USDT orders without a conversion snapshot require review. Alipay successful query responses require RSA verification and matching order/amount (and seller ID when configured). WeChat query responses require RSA verification, matching app/merchant/order, CNY and exact total in cents. Webhooks only locate a verified notification's order; active query remains the fulfillment authority.

WeChat signature contract: [platform certificate verification](https://pay.wechatpay.cn/doc/v3/merchant/4013053420), [order query](https://pay.wechatpay.cn/doc/v3/merchant/4012791900). ChainPay's authenticated order response was checked against the deployed `20261018-readiness-238a7e5` route; test fixtures contain synthetic values only.

## Deployment and rollback

Migrations 005/006 are additive. Back up the database before applying them. Test with the same PostgreSQL major version and a separate validation database/cluster. Preserve the previous application release and static assets. After any new-format payments or scheduled changes have been accepted, do not switch to an old billing implementation that ignores those records; reconcile the activity and use a compatible release or a forward fix. Never restore an older database over new payment activity.

## SaaS additions (2026-10-22)

Account security, workspaces, reviewed refunds, notifications, support, backups and reconciliation: [SAAS-OPERATIONS.md](SAAS-OPERATIONS.md). SaaS supports customer self-deployment and existing-site connection only; no platform relay hardware.
