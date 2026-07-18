import { createDecipheriv, createSign, createVerify, randomBytes, X509Certificate } from 'node:crypto';
import {
  formatPem,
  headerValue,
  type GatewayCreateInput,
  type GatewayCreateResult,
  type GatewayOrderStatus,
  type PaymentGateway,
  type WebhookHeaders,
  type WebhookResult,
} from './types.js';

/**
 * 微信支付 APIv3 直连（Native 扫码，无 SDK 依赖）。
 * config 键与 sub2api 同形：appId / mchId / privateKey / apiV3Key / certSerial / notifyUrl，
 * 可选 publicKey + publicKeyId（微信支付公钥模式；缺省走平台证书自动下载模式）。
 * webhook：AES-256-GCM 解密 resource + 平台签名验证；入账仍以查单为准。
 */

const WXPAY_BASE = 'https://api.mch.weixin.qq.com';

export class WxpayGateway implements PaymentGateway {
  readonly key = 'wxpay';
  private readonly privateKeyPem: string;
  /** serial -> 平台证书/公钥 PEM（验 webhook 签名用） */
  private platformKeys = new Map<string, string>();
  private platformKeysAt = 0;

  constructor(
    private readonly config: Record<string, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.privateKeyPem = formatPem(config.privateKey ?? '', 'PRIVATE KEY');
    if (config.publicKey && config.publicKeyId) {
      this.platformKeys.set(config.publicKeyId, formatPem(config.publicKey, 'PUBLIC KEY'));
      this.platformKeysAt = Number.MAX_SAFE_INTEGER; // 公钥模式无须刷新
    }
  }

  /** APIv3 请求签名头：SHA256-RSA2048(method\npath\nts\nnonce\nbody\n) */
  private authHeader(method: string, pathWithQuery: string, body: string): string {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message, 'utf8').sign(this.privateKeyPem, 'base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",` +
      `nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${this.config.certSerial}"`
    );
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const bodyText = body !== undefined ? JSON.stringify(body) : '';
    const resp = await this.fetchFn(`${WXPAY_BASE}${path}`, {
      method,
      headers: {
        authorization: this.authHeader(method, path, bodyText),
        accept: 'application/json',
        'user-agent': 'relay-panel',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: bodyText } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let code = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code) code = parsed.code;
      } catch {
        // 非 JSON 错误体，用 HTTP 状态
      }
      throw new Error(`微信支付接口错误: ${code}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(input: GatewayCreateInput): Promise<GatewayCreateResult> {
    const resp = await this.call<{ code_url?: string }>('POST', '/v3/pay/transactions/native', {
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: input.subject,
      out_trade_no: input.orderNo,
      notify_url: this.config.notifyUrl,
      amount: { total: Math.round(input.amountCny * 100), currency: 'CNY' },
    });
    if (!resp.code_url) throw new Error('微信支付未返回 code_url');
    return { qrCode: resp.code_url, tradeNo: input.orderNo };
  }

  async query(orderNo: string): Promise<GatewayOrderStatus> {
    let resp: { trade_state?: string };
    try {
      resp = await this.call<{ trade_state?: string }>(
        'GET',
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.config.mchId ?? '')}`,
      );
    } catch (err) {
      // ORDER_NOT_EXIST：用户尚未扫码时微信侧还没有交易
      if (err instanceof Error && /ORDER_?NOT_?EXIST|404/.test(err.message)) return 'pending';
      throw err;
    }
    switch (resp.trade_state) {
      case 'SUCCESS':
        return 'paid';
      case 'CLOSED':
      case 'REVOKED':
      case 'PAYERROR':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /** 平台证书模式：GET /v3/certificates → apiV3Key 解密证书 → serial -> PEM 缓存（12h） */
  private async ensurePlatformKeys(): Promise<void> {
    if (this.platformKeys.size > 0 && Date.now() - this.platformKeysAt < 12 * 3600_000) return;
    interface CertEntry {
      serial_no: string;
      encrypt_certificate: { ciphertext: string; nonce: string; associated_data: string };
    }
    const resp = await this.call<{ data?: CertEntry[] }>('GET', '/v3/certificates');
    const next = new Map<string, string>();
    for (const entry of resp.data ?? []) {
      const pem = this.decryptResource(
        entry.encrypt_certificate.ciphertext,
        entry.encrypt_certificate.nonce,
        entry.encrypt_certificate.associated_data,
      );
      next.set(entry.serial_no, new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'pem' }).toString());
    }
    if (next.size === 0) throw new Error('微信支付平台证书列表为空');
    this.platformKeys = next;
    this.platformKeysAt = Date.now();
  }

  /** AEAD_AES_256_GCM：ciphertext 尾 16 字节是 tag */
  private decryptResource(ciphertextB64: string, nonce: string, associatedData: string): string {
    const buf = Buffer.from(ciphertextB64, 'base64');
    const data = buf.subarray(0, buf.length - 16);
    const tag = buf.subarray(buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.apiV3Key ?? '', 'utf8'), Buffer.from(nonce, 'utf8'));
    decipher.setAuthTag(tag);
    if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  async parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookResult> {
    const timestamp = headerValue(headers, 'wechatpay-timestamp');
    const nonce = headerValue(headers, 'wechatpay-nonce');
    const signature = headerValue(headers, 'wechatpay-signature');
    const serial = headerValue(headers, 'wechatpay-serial');
    if (!timestamp || !nonce || !signature || !serial) throw new Error('微信支付通知缺少签名头');
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('微信支付通知时间戳超窗');

    await this.ensurePlatformKeys();
    const keyPem = this.platformKeys.get(serial);
    if (keyPem === undefined) throw new Error('微信支付通知证书序列号未知');
    const message = `${timestamp}\n${nonce}\n${rawBody.toString('utf8')}\n`;
    const ok = createVerify('RSA-SHA256').update(message, 'utf8').verify(keyPem, signature, 'base64');
    if (!ok) throw new Error('微信支付通知验签失败');

    const body = JSON.parse(rawBody.toString('utf8')) as {
      resource?: { ciphertext: string; nonce: string; associated_data?: string };
    };
    if (!body.resource) throw new Error('微信支付通知缺少 resource');
    const decrypted = JSON.parse(
      this.decryptResource(body.resource.ciphertext, body.resource.nonce, body.resource.associated_data ?? ''),
    ) as { out_trade_no?: string; mchid?: string };
    if (decrypted.mchid !== undefined && decrypted.mchid !== this.config.mchId) {
      throw new Error('微信支付通知商户号不匹配');
    }
    if (!decrypted.out_trade_no) throw new Error('微信支付通知缺少 out_trade_no');
    return {
      orderNo: decrypted.out_trade_no,
      ack: { contentType: 'application/json', body: JSON.stringify({ code: 'SUCCESS', message: '成功' }) },
    };
  }
}
