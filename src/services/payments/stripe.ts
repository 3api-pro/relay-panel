/**
 * Stripe Checkout Session — the global default for credit-card SaaS payments.
 *
 * Flow:
 *   1. createStripeSession() POSTs /v1/checkout/sessions, returns session.url
 *   2. user redirects to Stripe-hosted checkout, pays
 *   3. Stripe sends checkout.session.completed webhook
 *   4. verifyStripeSignature(rawBody, header, secret) — Stripe-Signature
 *      header format: t=<unix>,v1=<hex>; expected = HMAC-SHA256 over
 *      `<t>.<rawBody>` with whsec_*
 *   5. metadata.order_id maps back to our order → confirmPaid → wallet credit
 *
 * Credentials in app_config: stripe_secret_key (sk_live_/sk_test_),
 * stripe_webhook_secret (whsec_*), stripe_mode ('live' | 'test').
 *
 * Currency: defaults USD; storefront can pass currency per order.
 */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';
import { getConfig } from '../app-config';

let _disp: ProxyAgent | undefined;
let _dispUrl: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispUrl) { _disp = new ProxyAgent(proxy); _dispUrl = proxy; }
  else if (!proxy) { _disp = undefined; _dispUrl = undefined; }
  return _disp;
}

const STRIPE_BASE = 'https://api.stripe.com';

export function isStripeConfigured(): boolean {
  return Boolean(getConfig('stripe_secret_key'));
}

export interface StripeCreateResult {
  session_id: string;
  url: string;
}

/**
 * Create a one-shot Checkout Session for a fixed-price purchase.
 * line_items uses inline price_data (no need to pre-create Product/Price).
 */
export async function createStripeSession(opts: {
  orderId: number;
  amountCents: number;
  currency: string;        // 'usd' / 'eur' / etc.
  productName: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}): Promise<StripeCreateResult> {
  const sk = getConfig('stripe_secret_key', '');
  if (!sk) throw new Error('stripe_not_configured');

  // Stripe API uses application/x-www-form-urlencoded with bracketed keys.
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', opts.successUrl);
  params.set('cancel_url', opts.cancelUrl);
  params.set('line_items[0][price_data][currency]', opts.currency.toLowerCase());
  params.set('line_items[0][price_data][unit_amount]', String(opts.amountCents));
  params.set('line_items[0][price_data][product_data][name]', opts.productName);
  params.set('line_items[0][quantity]', '1');
  params.set('metadata[order_id]', String(opts.orderId));
  params.set('client_reference_id', String(opts.orderId));
  if (opts.customerEmail) params.set('customer_email', opts.customerEmail);

  const r = await fetch(`${STRIPE_BASE}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sk}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    dispatcher: dispatcher(),
  } as any);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`stripe_create_${r.status}: ${t.slice(0, 250)}`);
  }
  const d: any = await r.json();
  if (!d.url || !d.id) throw new Error('stripe_session_missing_url');
  return { session_id: d.id, url: d.url };
}

/**
 * Verify Stripe webhook signature. header is the value of `Stripe-Signature`
 * which is `t=<unix>,v1=<hex>[,v1=<hex>...]`. Tolerance defaults to 5min.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, toleranceSec = 300): boolean {
  const secret = getConfig('stripe_webhook_secret', '');
  if (!secret || !header) return false;
  const parts = header.split(',').map((s) => s.trim());
  let t = '';
  const sigs: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!t || sigs.length === 0) return false;
  const ts = parseInt(t, 10);
  if (!isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  for (const sig of sigs) {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
