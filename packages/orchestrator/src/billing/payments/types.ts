/**
 * 收款网关抽象（P4 支付接入）。三个内置实现：alipay（当面付扫码/页面跳转）、
 * wxpay（Native 扫码，APIv3）、usdt（ChainPay 托管收银台）。
 *
 * 安全模型（零信任 webhook）：webhook 只做「验签 + 定位订单」，入账一律由
 * confirmOrder 主动向渠道查单核实后才发生 —— 验签实现的任何瑕疵都不会
 * 变成免费开通订阅的洞。轮询与 webhook 汇聚到同一条幂等入账路径。
 *
 * config 形状与 sub2api 的 payment provider 完全同形（键名一致），
 * 已有 sub2api 站点的收款配置可原样拷贝复用（notifyUrl 换成面板域名即可）。
 */

export interface GatewayCreateInput {
  /** 面板订单号（out_trade_no / externalId） */
  orderNo: string;
  /** 人民币金额，两位小数 */
  amountCny: number;
  /** 订单标题（套餐名） */
  subject: string;
}

export interface GatewayCreateResult {
  /** 跳转支付页 URL（redirect 模式 / 移动端） */
  payUrl?: string;
  /** 可扫码字符串（alipay precreate qr_code / wxpay code_url）；前端渲染成二维码 */
  qrCode?: string;
  /** 渠道侧订单号（查单用；alipay/wxpay 用我们的 orderNo 查，可不回） */
  tradeNo?: string;
}

export type GatewayOrderStatus = 'pending' | 'paid' | 'expired' | 'failed';

export interface WebhookHeaders {
  [name: string]: string | string[] | undefined;
}

export interface WebhookResult {
  /** 通知定位到的面板订单号 */
  orderNo: string;
  /** 渠道要求的应答体（alipay 要纯文本 "success"；缺省 JSON {ok:true}） */
  ack?: { contentType: string; body: string };
}

export interface PaymentGateway {
  readonly key: string;
  create(input: GatewayCreateInput): Promise<GatewayCreateResult>;
  /** 主动查单 —— 入账唯一依据 */
  query(orderNo: string, tradeNo?: string | null): Promise<GatewayOrderStatus>;
  /** 验签并解析 webhook；验签失败必须抛错（外层回 4xx，渠道会重试） */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookResult>;
}

/** 每种渠道的必填 config 键（保存时校验，避免坏配置到建单才炸） */
export const PROVIDER_REQUIRED_KEYS: Record<string, string[]> = {
  alipay: ['appId', 'privateKey', 'alipayPublicKey', 'notifyUrl'],
  wxpay: ['appId', 'mchId', 'privateKey', 'apiV3Key', 'certSerial', 'notifyUrl'],
  usdt: ['apiKey', 'appId', 'webhookSecret'],
};

export const KNOWN_PROVIDER_KEYS = Object.keys(PROVIDER_REQUIRED_KEYS);

/** 裸 base64 单行密钥 → PEM（sub2api 同款存法；已带 PEM 头则原样返回） */
export function formatPem(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function headerValue(headers: WebhookHeaders, name: string): string {
  const v = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}
