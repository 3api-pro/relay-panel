import { createSign, createVerify } from 'node:crypto';
import {
  formatPem,
  type GatewayCreateInput,
  type GatewayCreateResult,
  type GatewayOrderStatus,
  type PaymentGateway,
  type WebhookHeaders,
  type WebhookResult,
} from './types.js';

/**
 * 支付宝开放平台直连（RSA2，无 SDK 依赖）。镜像 sub2api 的 Alipay provider 行为：
 *  - 默认走 alipay.trade.precreate（当面付）拿可扫码 qr_code；
 *  - paymentMode==='redirect' 或 precreate 失败时回落 alipay.trade.page.pay 整页跳转；
 *  - 查单 alipay.trade.query；异步通知 RSA2 验签（且入账仍以查单为准）。
 * config 键与 sub2api 同形：appId / privateKey / alipayPublicKey(或 publicKey) / notifyUrl / returnUrl。
 */

const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const TRADE_NOT_EXIST = 'ACQ.TRADE_NOT_EXIST';

/** 支付宝要求北京时间 yyyy-MM-dd HH:mm:ss */
function beijingTimestamp(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 请求签名内容：只排除 sign（sign_type 必须参与签名，排掉会被网关判坏签） */
function requestSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && k !== 'sign')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 异步通知验签内容：按支付宝规则排除 sign 与 sign_type */
function notifySignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && k !== 'sign' && k !== 'sign_type')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export class AlipayGateway implements PaymentGateway {
  readonly key = 'alipay';
  private readonly privateKeyPem: string;
  private readonly alipayPublicKeyPem: string;

  constructor(
    private readonly config: Record<string, string>,
    private readonly paymentMode: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.privateKeyPem = formatPem(config.privateKey ?? '', 'PRIVATE KEY');
    const pub = config.alipayPublicKey || config.publicKey || '';
    this.alipayPublicKeyPem = formatPem(pub, 'PUBLIC KEY');
  }

  private sign(content: string): string {
    return createSign('RSA-SHA256').update(content, 'utf8').sign(this.privateKeyPem, 'base64');
  }

  private verify(content: string, signature: string): boolean {
    try {
      return createVerify('RSA-SHA256').update(content, 'utf8').verify(this.alipayPublicKeyPem, signature, 'base64');
    } catch {
      return false;
    }
  }

  private commonParams(method: string, bizContent: Record<string, unknown>): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.config.appId ?? '',
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: beijingTimestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    };
    if (this.config.notifyUrl) params.notify_url = this.config.notifyUrl;
    return params;
  }

  /** openapi 调用：POST 表单，返回 <method>_response 节点；网关错误抛中文摘要（不含凭据） */
  private async call(method: string, bizContent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const params = this.commonParams(method, bizContent);
    params.sign = this.sign(requestSignContent(params));
    const body = new URLSearchParams(params).toString();
    const resp = await this.fetchFn(ALIPAY_GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await resp.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nodeKey = `${method.replace(/\./g, '_')}_response`;
    const node = (parsed[nodeKey] ?? parsed.error_response) as Record<string, unknown> | undefined;
    if (!node) throw new Error(`支付宝响应缺少 ${nodeKey}`);
    // 响应验签：对原文中该节点的精确子串验签（网关对 JSON 原样签名，不能重序列化）
    const sign = typeof parsed.sign === 'string' ? parsed.sign : '';
    if (sign && parsed[nodeKey] !== undefined) {
      const raw = extractResponseNode(text, nodeKey);
      if (raw === null || !this.verify(raw, sign)) {
        throw new Error('支付宝响应验签失败');
      }
    }
    return node;
  }

  async create(input: GatewayCreateInput): Promise<GatewayCreateResult> {
    const biz = {
      out_trade_no: input.orderNo,
      total_amount: input.amountCny.toFixed(2),
      subject: input.subject,
    };
    if (this.paymentMode !== 'redirect') {
      try {
        const node = await this.call('alipay.trade.precreate', {
          ...biz,
          product_code: 'FACE_TO_FACE_PAYMENT',
        });
        if (node.code === '10000' && typeof node.qr_code === 'string' && node.qr_code) {
          return { qrCode: node.qr_code, tradeNo: input.orderNo };
        }
      } catch {
        // precreate 不可用（商户未开当面付等）→ 回落整页跳转
      }
    }
    return { payUrl: this.pagePayUrl(biz), tradeNo: input.orderNo };
  }

  /** alipay.trade.page.pay 是浏览器打开的收银台 URL（GET 全参拼接） */
  private pagePayUrl(biz: Record<string, unknown>): string {
    const params = this.commonParams('alipay.trade.page.pay', {
      ...biz,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    });
    if (this.config.returnUrl) params.return_url = this.config.returnUrl;
    params.sign = this.sign(requestSignContent(params));
    return `${ALIPAY_GATEWAY}?${new URLSearchParams(params).toString()}`;
  }

  async query(orderNo: string): Promise<GatewayOrderStatus> {
    const node = await this.call('alipay.trade.query', { out_trade_no: orderNo });
    if (node.code !== '10000') {
      if (node.sub_code === TRADE_NOT_EXIST) return 'pending'; // 用户尚未扫码，交易未落
      throw new Error(`支付宝查单失败: ${String(node.sub_code ?? node.code)}`);
    }
    switch (node.trade_status) {
      case 'TRADE_SUCCESS':
      case 'TRADE_FINISHED':
        return 'paid';
      case 'TRADE_CLOSED':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /** 异步通知：form-encoded；RSA2 验签 + app_id 匹配；入账仍走查单 */
  async parseWebhook(rawBody: Buffer, _headers: WebhookHeaders): Promise<WebhookResult> {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody.toString('utf8'))) params[k] = v;
    const sign = params.sign ?? '';
    if (!sign || !this.verify(notifySignContent(params), sign)) {
      throw new Error('支付宝通知验签失败');
    }
    if (params.app_id !== this.config.appId) throw new Error('支付宝通知 app_id 不匹配');
    const orderNo = params.out_trade_no ?? '';
    if (!orderNo) throw new Error('支付宝通知缺少 out_trade_no');
    return { orderNo, ack: { contentType: 'text/plain', body: 'success' } };
  }
}

/** 从响应原文提取 "<nodeKey>":{...} 的精确子串（括号配对，字符串感知） */
export function extractResponseNode(text: string, nodeKey: string): string | null {
  const marker = `"${nodeKey}"`;
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const start = text.indexOf('{', idx + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
