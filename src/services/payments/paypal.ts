/**
 * PayPal v2 Orders API (CAPTURE intent). Server-side flow:
 *   1. createPaypalOrder() — call /v2/checkout/orders, return approval URL
 *   2. user redirects to PayPal, approves
 *   3. PayPal redirects back to our return_url with ?token=<paypalOrderId>
 *   4. capturePaypalOrder(token) — call /v2/checkout/orders/{id}/capture
 *   5. on COMPLETED, our route maps custom_id → our order id, calls confirmPaid
 *
 * Credentials live in app_config (not env): paypal_client_id,
 * paypal_client_secret, paypal_environment ('sandbox' | 'live').
 *
 * Outbound: undici ProxyAgent if outbound_https_proxy configured.
 */
import { ProxyAgent } from 'undici';
import { getConfig } from '../app-config';
import { logger } from '../logger';

let _disp: ProxyAgent | undefined;
let _dispUrl: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispUrl) { _disp = new ProxyAgent(proxy); _dispUrl = proxy; }
  else if (!proxy) { _disp = undefined; _dispUrl = undefined; }
  return _disp;
}

function baseUrl(): string {
  const env = (getConfig('paypal_environment', 'sandbox') || 'sandbox').toLowerCase();
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export function isPaypalConfigured(): boolean {
  return Boolean(getConfig('paypal_client_id') && getConfig('paypal_client_secret'));
}

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (_tokenCache && _tokenCache.expiresAt - 60_000 > Date.now()) return _tokenCache.token;
  const id = getConfig('paypal_client_id', '');
  const sec = getConfig('paypal_client_secret', '');
  if (!id || !sec) throw new Error('paypal_not_configured');
  const basic = Buffer.from(`${id}:${sec}`).toString('base64');
  const r = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    dispatcher: dispatcher(),
  } as any);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`paypal_oauth_${r.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await r.json();
  _tokenCache = { token: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tokenCache.token;
}

export interface PaypalCreateResult {
  paypal_order_id: string;
  approve_url: string;
}

export async function createPaypalOrder(opts: {
  orderId: number;
  amountCents: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
}): Promise<PaypalCreateResult> {
  const tok = await getAccessToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: opts.currency, value: (opts.amountCents / 100).toFixed(2) },
      custom_id: String(opts.orderId),
    }],
    application_context: {
      return_url: opts.returnUrl,
      cancel_url: opts.cancelUrl,
      brand_name: opts.brandName || '3API',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
    },
  };
  const r = await fetch(`${baseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher: dispatcher(),
  } as any);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`paypal_create_${r.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await r.json();
  const approval = (d.links || []).find((l: any) => l.rel === 'approve')?.href;
  if (!approval) throw new Error('paypal_no_approval_link');
  return { paypal_order_id: d.id, approve_url: approval };
}

export interface PaypalCaptureResult {
  status: string;          // 'COMPLETED' on success
  capture_id: string;
  custom_id: string;       // our order id (string)
  amount_value: string;    // dollar/decimal string
  amount_currency: string;
}

export async function capturePaypalOrder(ppOrderId: string): Promise<PaypalCaptureResult> {
  const tok = await getAccessToken();
  const r = await fetch(`${baseUrl()}/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: '{}',
    dispatcher: dispatcher(),
  } as any);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`paypal_capture_${r.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await r.json();
  const pu = d.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  if (!cap) throw new Error('paypal_capture_missing_payments');
  return {
    status: d.status || cap.status,
    capture_id: cap.id,
    custom_id: pu.custom_id ?? '',
    amount_value: cap.amount?.value ?? '',
    amount_currency: cap.amount?.currency_code ?? '',
  };
}
