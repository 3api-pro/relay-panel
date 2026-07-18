# Payments

Self-serve subscription payments for the hosted SaaS. Three built-in providers: **Alipay** (direct merchant, QR / hosted page), **WeChat Pay** (APIv3 Native QR), and **USDT** (ChainPay-compatible crypto checkout). All are optional — with none configured, subscriptions are granted manually by root.

## Security model

- **Zero-trust webhooks.** A webhook only (1) verifies the channel signature and (2) points at an order. Crediting happens exclusively in `confirmOrder`, which re-queries the channel's order status directly and claims the order with a conditional `UPDATE … WHERE status='pending'`. Replayed webhooks, concurrent polls, and even a flawed signature check cannot double-credit or forge an activation.
- **Config encryption.** Provider configs are stored AES-256-GCM-encrypted in the credentials store (`RP_SECRET_KEY`), write-only via the API: responses expose configured key *names*, never values.
- Frontend polling (3s, per-order rate-limited server-side) makes webhooks an accelerator, not a dependency — orders complete even if your webhook endpoint is unreachable.

## Order lifecycle

```
pending ──(channel confirms paid)──▶ paid ──(subscription activated)──▶ completed
   │
   ├─▶ expired    (30 min TTL, or channel-side expiry)
   ├─▶ failed     (channel create/close failure)
   └─▶ cancelled  (user cancelled while pending)
```

An order stuck in `paid` means money arrived but activation failed — visible in root's order list (`GET /api/billing/orders?all=1`) and the audit trail; grant manually and investigate.

## Provider configuration

Root-only: **Billing → Payment providers**, or `POST /api/billing/providers` with `{key, name, enabled, sortOrder, paymentMode, config}`. `paymentMode: "redirect"` switches Alipay from scan-QR (precreate) to a hosted checkout page.

The config shapes are intentionally identical to sub2api's payment provider instances — if you already operate a sub2api site with payments, you can reuse the same merchant credentials (point `notifyUrl` at the panel instead).

### alipay

| key | value |
|---|---|
| `appId` | Open-platform app id |
| `privateKey` | Merchant RSA2 private key (PEM or bare base64) |
| `alipayPublicKey` | Alipay public key (for response/notify verification) |
| `notifyUrl` | `https://<panel-domain>/webhooks/payment/alipay` |
| `returnUrl` | optional, browser return after hosted-page payment |

Uses `alipay.trade.precreate` (FACE_TO_FACE_PAYMENT) for a scannable QR; falls back to `alipay.trade.page.pay` when precreate is unavailable or `paymentMode=redirect`.

### wxpay

| key | value |
|---|---|
| `appId` / `mchId` | App id / merchant id |
| `privateKey` | Merchant API private key (PEM or bare base64) |
| `apiV3Key` | 32-byte APIv3 key (webhook resource decryption) |
| `certSerial` | Merchant certificate serial (request signing) |
| `notifyUrl` | `https://<panel-domain>/webhooks/payment/wxpay` |
| `publicKey` + `publicKeyId` | optional pair: WeChat Pay public-key mode; omit both for platform-certificate mode (auto-download) |

Native (QR) transactions only. Webhook signatures are verified against the platform certificate / public key; the resource is AES-256-GCM-decrypted with `apiV3Key`.

### usdt (ChainPay-compatible)

| key | value |
|---|---|
| `apiKey` | Gateway API key (Bearer) |
| `appId` | Gateway app id |
| `webhookSecret` | HMAC-SHA256 secret for `x-chainpay-signature` |
| `baseUrl` | Gateway base URL |
| `chain` | optional, `erc20` (default) or `trc20` |
| `fxBuffer` / `fxFallbackRate` | optional CNY→USDT conversion tuning (defaults 0.97 / 6.78) |

CNY amounts convert to USDT at a live FX rate (1 h cache) times `fxBuffer`, rounded up — the buffer absorbs gas, fees and FX drift. Create your gateway app with the webhook pointed at `https://<panel-domain>/webhooks/payment/usdt`.

## Webhook endpoints

`POST /webhooks/payment/:provider` — unauthenticated (channel servers call it), raw-body parsed for signature verification, CSRF-exempt (outside `/api/*`). Invalid signatures get `400` and are logged; channels retry per their own policy.

## Extending

`PaymentGateway` (`src/billing/payments/types.ts`) is the seam: implement `create` / `query` / `parseWebhook`, register the key in `PaymentsService.gatewayFor` and `PROVIDER_REQUIRED_KEYS`. PayPal/Stripe-style redirect providers fit the same shape.
