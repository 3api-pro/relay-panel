import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  headerValue,
  type GatewayCreateInput,
  type GatewayCreateResult,
  type GatewayOrderStatus,
  type PaymentGateway,
  type WebhookHeaders,
  type WebhookResult,
} from './types.js';

/**
 * ChainPay（自有 USDT 收款网关）对接，契约与 sub2api 的 ChainPay provider 一致：
 *   POST {baseUrl}/api/v1/orders   Authorization: Bearer <apiKey>
 *     { amount(USDT), currency, chain, appId, externalId, metadata } -> { orderId, checkoutUrl, ... }
 *   GET  {baseUrl}/api/v1/orders/:id -> { status: pending|confirming|completed|expired|failed }
 *   Webhook 头 x-chainpay-signature = hex HMAC-SHA256(rawBody, webhookSecret)，payload 带 externalId。
 * 人民币 → USDT：实时汇率(1h 缓存) × fxBuffer(默认 0.97，对我方有利)，向上取 2 位，兜底 fxFallbackRate。
 * config：apiKey / appId / webhookSecret / baseUrl? / chain? / fxBuffer? / fxFallbackRate?
 */

const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_TTL_MS = 3600_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:3101';

const fxCache = { rate: 0, at: 0 };

export class ChainpayGateway implements PaymentGateway {
  readonly key = 'usdt';

  constructor(
    private readonly config: Record<string, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private baseUrl(): string {
    return (this.config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private num(key: string, fallback: number): number {
    const v = Number.parseFloat(this.config[key] ?? '');
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  private async cnyPerUsd(): Promise<number> {
    if (fxCache.rate > 0 && Date.now() - fxCache.at < FX_TTL_MS) return fxCache.rate;
    try {
      const resp = await this.fetchFn(FX_URL, { signal: AbortSignal.timeout(6000) });
      const data = (await resp.json()) as { result?: string; rates?: Record<string, number> };
      const cny = data.rates?.CNY ?? 0;
      if (data.result === 'success' && cny > 0) {
        fxCache.rate = cny;
        fxCache.at = Date.now();
        return cny;
      }
    } catch {
      // 汇率源失败走兜底
    }
    return this.num('fxFallbackRate', 6.78);
  }

  async create(input: GatewayCreateInput): Promise<GatewayCreateResult> {
    const effective = (await this.cnyPerUsd()) * this.num('fxBuffer', 0.97);
    const usdt = Math.ceil((input.amountCny / effective) * 100) / 100;
    const resp = await this.fetchFn(`${this.baseUrl()}/api/v1/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: usdt,
        currency: 'USDT',
        chain: this.config.chain?.trim() || 'erc20',
        appId: this.config.appId,
        externalId: input.orderNo,
        metadata: { order_no: input.orderNo, subject: input.subject },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const order = (await resp.json()) as { orderId?: string; checkoutUrl?: string; error?: string };
    if (!resp.ok) throw new Error(`ChainPay 建单失败: ${order.error ?? `HTTP ${resp.status}`}`);
    if (!order.orderId || !order.checkoutUrl) throw new Error('ChainPay 建单响应不完整');
    return { payUrl: order.checkoutUrl, tradeNo: order.orderId };
  }

  async query(_orderNo: string, tradeNo?: string | null): Promise<GatewayOrderStatus> {
    if (!tradeNo) return 'pending';
    const resp = await this.fetchFn(`${this.baseUrl()}/api/v1/orders/${encodeURIComponent(tradeNo)}`, {
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`ChainPay 查单失败: HTTP ${resp.status}`);
    const data = (await resp.json()) as { status?: string };
    switch (data.status) {
      case 'completed':
        return 'paid';
      case 'expired':
        return 'expired';
      case 'failed':
        return 'failed';
      default:
        return 'pending'; // pending | confirming
    }
  }

  async parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookResult> {
    const given = headerValue(headers, 'x-chainpay-signature').trim();
    if (!given) throw new Error('ChainPay 通知缺少签名头');
    const expected = createHmac('sha256', this.config.webhookSecret ?? '').update(rawBody).digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('ChainPay 通知验签失败');
    const payload = JSON.parse(rawBody.toString('utf8')) as { externalId?: string };
    if (!payload.externalId) throw new Error('ChainPay 通知缺少 externalId');
    return { orderNo: payload.externalId };
  }
}
