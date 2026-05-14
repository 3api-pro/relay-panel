/**
 * Creem (creem.io) checkout sessions + webhook.
 *
 * Flow:
 *   1. createCreemCheckout() returns hosted checkout URL
 *   2. user pays on creem.io
 *   3. webhook POST /payments/creem/webhook fires with checkout.completed
 *   4. verifyCreemSignature() — HMAC-SHA256 over raw body with shared secret
 *   5. extract metadata.order_id → confirmPaid → wallet credit
 *
 * Credentials in app_config:
 *   creem_api_key, creem_webhook_secret, creem_environment ('live' | 'test')
 */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';
import { getConfig } from '../app-config';
import { query } from '../database';

let _disp: ProxyAgent | undefined;
let _dispUrl: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispUrl) { _disp = new ProxyAgent(proxy); _dispUrl = proxy; }
  else if (!proxy) { _disp = undefined; _dispUrl = undefined; }
  return _disp;
}

export function isCreemConfigured(): boolean {
  return Boolean(getConfig('creem_api_key') && getConfig('creem_webhook_secret'));
}

function baseUrl(): string {
  const env = (getConfig('creem_environment', 'live') || 'live').toLowerCase();
  return env === 'test' ? 'https://test-api.creem.io' : 'https://api.creem.io';
}

export interface CreemCreateResult {
  checkout_id: string;
  checkout_url: string;
}

export async function createCreemCheckout(opts: {
  orderId: number;
  productId: string;            // creem product id (per-tenant config or per-plan)
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  metadata?: Record<string, string | number>;
}): Promise<CreemCreateResult> {
  const key = getConfig('creem_api_key', '');
  if (!key) throw new Error('creem_not_configured');
  const body = {
    product_id: opts.productId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer: opts.customerEmail ? { email: opts.customerEmail } : undefined,
    metadata: { order_id: String(opts.orderId), ...(opts.metadata || {}) },
  };
  const r = await fetch(`${baseUrl()}/v1/checkouts`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher: dispatcher(),
  } as any);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`creem_create_${r.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await r.json();
  return { checkout_id: d.id, checkout_url: d.checkout_url };
}

/**
 * Verify Creem webhook signature. Body must be the RAW request body
 * (string), header is `creem-signature: t=<unix>,v1=<hex>` or similar
 * per Creem docs. We accept the simpler `creem-signature: <hex>` form
 * (HMAC-SHA256 over raw body with secret).
 */
export function verifyCreemSignature(rawBody: string, headerSig: string | undefined): boolean {
  const secret = getConfig('creem_webhook_secret', '');
  if (!secret || !headerSig) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // headerSig may carry prefix or comma-fields; we try both forms.
  const candidates = headerSig.split(',').map((s) => s.trim()).map((s) => {
    const eq = s.indexOf('=');
    return eq > 0 ? s.slice(eq + 1) : s;
  });
  for (const c of candidates) {
    const a = Buffer.from(c, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export interface CreemCredsWithSource {
  api_key: string;
  webhook_secret: string;
  environment: 'test' | 'live';
  fundsHolder: 'tenant' | 'platform';
}

export async function loadCreemCredsWithSource(tenantId: number): Promise<CreemCredsWithSource | null> {
  const rows = await query<any>(
    "SELECT config->'payment_config' AS p FROM tenant WHERE id = $1 LIMIT 1",
    [tenantId],
  );
  const p = rows[0]?.p || {};
  if (p.creem_api_key && p.creem_webhook_secret) {
    return {
      api_key: p.creem_api_key,
      webhook_secret: p.creem_webhook_secret,
      environment: (p.creem_environment === 'live' ? 'live' : 'test'),
      fundsHolder: 'tenant',
    };
  }
  const ak = getConfig('creem_api_key', '');
  const ws = getConfig('creem_webhook_secret', '');
  if (!ak) return null;
  return {
    api_key: ak,
    webhook_secret: ws,
    environment: (getConfig('creem_environment', 'live') === 'live' ? 'live' : 'test'),
    fundsHolder: 'platform',
  };
}
