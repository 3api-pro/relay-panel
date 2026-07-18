import { createServer, type Server } from 'node:http';
import { createCipheriv, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentOrders, subscriptions } from '../src/db/schema.js';
import { AlipayGateway, extractResponseNode } from '../src/billing/payments/alipay.js';
import { WxpayGateway } from '../src/billing/payments/wxpay.js';
import { ChainpayGateway } from '../src/billing/payments/chainpay.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 收款模块测试：三网关单测（真密钥对签验回路）+ ChainPay 全链路 E2E
 * （root 配渠道 → operator 下单 → webhook 验签 → 查单入账 → 订阅开通幂等）。
 */

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// 网关单测
// ---------------------------------------------------------------------------

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPrivPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const merchantPubPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
// “支付宝侧”密钥对（模拟渠道给响应/通知签名）
const aliRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const aliPrivPem = aliRsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const aliPubPem = aliRsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('AlipayGateway', () => {
  const config = {
    appId: 'app-1001',
    privateKey: merchantPrivPem,
    alipayPublicKey: aliPubPem,
    notifyUrl: 'https://panel.example.com/webhooks/payment/alipay',
  };

  function signedGatewayResponse(nodeKey: string, node: Record<string, unknown>): string {
    const nodeJson = JSON.stringify(node);
    const sign = createSign('RSA-SHA256').update(nodeJson, 'utf8').sign(aliPrivPem, 'base64');
    return `{"${nodeKey}":${nodeJson},"sign":"${sign}"}`;
  }

  it('precreate 成功 → qrCode；响应验签通过', async () => {
    const fetchFn = mockFetch(() => ({
      body: signedGatewayResponse('alipay_trade_precreate_response', {
        code: '10000',
        qr_code: 'https://qr.alipay.com/x123',
      }),
    }));
    const gw = new AlipayGateway(config, '', fetchFn);
    const out = await gw.create({ orderNo: 'RP1', amountCny: 29, subject: 'pro x1' });
    expect(out.qrCode).toBe('https://qr.alipay.com/x123');
  });

  it('响应签名被篡改 → precreate 抛错 → 回落 page.pay URL', async () => {
    const fetchFn = mockFetch(() => ({
      body: `{"alipay_trade_precreate_response":{"code":"10000","qr_code":"https://qr.alipay.com/evil"},"sign":"${Buffer.from('bad').toString('base64')}"}`,
    }));
    const gw = new AlipayGateway(config, '', fetchFn);
    const out = await gw.create({ orderNo: 'RP2', amountCny: 29, subject: 'pro x1' });
    expect(out.qrCode).toBeUndefined();
    expect(out.payUrl).toContain('alipay.trade.page.pay');
  });

  it('redirect 模式直接给收银台 URL（含签名参数）', async () => {
    const gw = new AlipayGateway(config, 'redirect');
    const out = await gw.create({ orderNo: 'RP3', amountCny: 58, subject: 'pro x2' });
    expect(out.payUrl).toContain('https://openapi.alipay.com/gateway.do?');
    expect(out.payUrl).toContain('sign=');
  });

  it('请求签名把 sign_type 计入签名内容（7/18 生产回落根因，防回归）', async () => {
    const gw = new AlipayGateway(config, 'redirect');
    const out = await gw.create({ orderNo: 'RP4', amountCny: 29, subject: 'pro x1' });
    const qs = new URL(out.payUrl!).searchParams;
    const params: Record<string, string> = {};
    for (const [k, v] of qs) params[k] = v;
    const content = Object.keys(params)
      .filter((k) => params[k] !== '' && k !== 'sign') // 请求签名规则：只排 sign
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const { createVerify } = await import('node:crypto');
    expect(content).toContain('sign_type=RSA2');
    expect(createVerify('RSA-SHA256').update(content, 'utf8').verify(merchantPubPem, params.sign!, 'base64')).toBe(true);
  });

  it('查单状态映射', async () => {
    const byStatus = (s: string): typeof fetch =>
      mockFetch(() => ({
        body: signedGatewayResponse('alipay_trade_query_response', {
          code: '10000',
          trade_status: s,
          total_amount: '29.00',
        }),
      }));
    expect(await new AlipayGateway(config, '', byStatus('TRADE_SUCCESS')).query('RP1')).toBe('paid');
    expect(await new AlipayGateway(config, '', byStatus('WAIT_BUYER_PAY')).query('RP1')).toBe('pending');
    expect(await new AlipayGateway(config, '', byStatus('TRADE_CLOSED')).query('RP1')).toBe('failed');
  });

  it('webhook 验签回路：正签通过、篡改拒绝、app_id 不符拒绝', async () => {
    const gw = new AlipayGateway(config, '');
    const params: Record<string, string> = {
      app_id: 'app-1001',
      out_trade_no: 'RP9',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '29.00',
      sign_type: 'RSA2',
    };
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    params.sign = createSign('RSA-SHA256').update(content, 'utf8').sign(aliPrivPem, 'base64');
    const raw = Buffer.from(new URLSearchParams(params).toString(), 'utf8');

    const out = await gw.parseWebhook(raw, {});
    expect(out.orderNo).toBe('RP9');
    expect(out.ack?.body).toBe('success');

    const tampered = Buffer.from(new URLSearchParams({ ...params, total_amount: '0.01' }).toString(), 'utf8');
    await expect(gw.parseWebhook(tampered, {})).rejects.toThrow('验签失败');

    const wrongApp: Record<string, string> = { ...params, app_id: 'app-evil' };
    const wrongContent = Object.keys(wrongApp)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && wrongApp[k] !== '')
      .sort()
      .map((k) => `${k}=${wrongApp[k]}`)
      .join('&');
    wrongApp.sign = createSign('RSA-SHA256').update(wrongContent, 'utf8').sign(aliPrivPem, 'base64');
    await expect(gw.parseWebhook(Buffer.from(new URLSearchParams(wrongApp).toString(), 'utf8'), {})).rejects.toThrow(
      'app_id',
    );
  });

  it('extractResponseNode 提取嵌套/含转义字符串的精确子串', () => {
    const text = '{"x_response":{"a":"b{\\"c}","n":{"d":1}},"sign":"s"}';
    expect(extractResponseNode(text, 'x_response')).toBe('{"a":"b{\\"c}","n":{"d":1}}');
  });
});

describe('WxpayGateway', () => {
  const apiV3Key = 'k'.repeat(32);
  const config = {
    appId: 'wxappid',
    mchId: '190000',
    privateKey: merchantPrivPem,
    apiV3Key,
    certSerial: 'MERCHSERIAL',
    notifyUrl: 'https://panel.example.com/webhooks/payment/wxpay',
    // 公钥模式：平台验签用我们生成的“微信侧”公钥
    publicKey: merchantPubPem,
    publicKeyId: 'PUB_KEY_ID_1',
  };

  it('native 建单：带 APIv3 签名头，返回 code_url', async () => {
    let authHeader = '';
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain('/v3/pay/transactions/native');
      authHeader = String((init?.headers as Record<string, string>).authorization);
      const body = JSON.parse(String(init?.body)) as { amount: { total: number }; out_trade_no: string };
      expect(body.amount.total).toBe(2900); // 分
      return { body: { code_url: 'weixin://wxpay/bizpayurl?pr=abc' } };
    });
    const gw = new WxpayGateway(config, fetchFn);
    const out = await gw.create({ orderNo: 'RPW1', amountCny: 29, subject: 'pro x1' });
    expect(out.qrCode).toBe('weixin://wxpay/bizpayurl?pr=abc');
    expect(authHeader).toContain('WECHATPAY2-SHA256-RSA2048');
    expect(authHeader).toContain('serial_no="MERCHSERIAL"');
  });

  it('查单状态映射 + ORDER_NOT_EXIST 视为 pending', async () => {
    const byState = (s: string): typeof fetch => mockFetch(() => ({ body: { trade_state: s } }));
    expect(await new WxpayGateway(config, byState('SUCCESS')).query('RPW1')).toBe('paid');
    expect(await new WxpayGateway(config, byState('NOTPAY')).query('RPW1')).toBe('pending');
    expect(await new WxpayGateway(config, byState('CLOSED')).query('RPW1')).toBe('failed');
    const notExist = mockFetch(() => ({ status: 404, body: { code: 'ORDER_NOT_EXIST' } }));
    expect(await new WxpayGateway(config, notExist).query('RPW1')).toBe('pending');
  });

  it('webhook：AES-256-GCM 解密 + 平台签名验证回路；坏签名拒绝', async () => {
    const gw = new WxpayGateway(config);
    const transaction = JSON.stringify({ out_trade_no: 'RPW9', mchid: '190000', trade_state: 'SUCCESS' });
    const nonce12 = randomBytes(6).toString('hex');
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce12, 'utf8'));
    cipher.setAAD(Buffer.from('transaction', 'utf8'));
    const ct = Buffer.concat([cipher.update(transaction, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const body = JSON.stringify({
      resource: { ciphertext: ct.toString('base64'), nonce: nonce12, associated_data: 'transaction' },
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = 'nonce-1';
    const signature = createSign('RSA-SHA256').update(`${ts}\n${nonce}\n${body}\n`, 'utf8').sign(merchantPrivPem, 'base64');
    const headers = {
      'wechatpay-timestamp': ts,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PUB_KEY_ID_1',
    };
    const out = await gw.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(out.orderNo).toBe('RPW9');
    expect(out.ack?.body).toContain('SUCCESS');

    // 篡改外层 body（签名覆盖的原文）→ 验签必须失败
    const tamperedBody = body.replace('"associated_data":"transaction"', '"associated_data":"tampering!!"');
    expect(tamperedBody).not.toBe(body);
    await expect(gw.parseWebhook(Buffer.from(tamperedBody, 'utf8'), headers)).rejects.toThrow('验签失败');
  });
});

describe('ChainpayGateway', () => {
  const config = { apiKey: 'sk_live_x', appId: 'appid-1', webhookSecret: 'whsec-1', baseUrl: 'http://cp.local' };

  it('建单：CNY→USDT 换算（兜底汇率×buffer 向上取 2 位），返回 checkoutUrl', async () => {
    let created: { amount: number; externalId: string } | null = null;
    const fetchFn = mockFetch((url, init) => {
      if (url.includes('er-api.com')) return { status: 500, body: {} }; // 汇率源失败走兜底 6.78
      created = JSON.parse(String(init?.body)) as { amount: number; externalId: string };
      return { body: { orderId: 'cp-1', checkoutUrl: 'http://cp.local/checkout/cp-1', status: 'pending' } };
    });
    const gw = new ChainpayGateway(config, fetchFn);
    const out = await gw.create({ orderNo: 'RPC1', amountCny: 29, subject: 'pro x1' });
    expect(out.payUrl).toBe('http://cp.local/checkout/cp-1');
    expect(out.tradeNo).toBe('cp-1');
    expect(created!.amount).toBe(Math.ceil((29 / (6.78 * 0.97)) * 100) / 100);
    expect(created!.externalId).toBe('RPC1');
  });

  it('查单映射 + webhook HMAC 回路', async () => {
    const fetchFn = mockFetch(() => ({ body: { status: 'completed' } }));
    const gw = new ChainpayGateway(config, fetchFn);
    expect(await gw.query('RPC1', 'cp-1')).toBe('paid');
    expect(await gw.query('RPC1', null)).toBe('pending'); // 无渠道单号

    const payload = Buffer.from(JSON.stringify({ event: 'completed', externalId: 'RPC1' }), 'utf8');
    const sig = createHmac('sha256', 'whsec-1').update(payload).digest('hex');
    const out = await gw.parseWebhook(payload, { 'x-chainpay-signature': sig });
    expect(out.orderNo).toBe('RPC1');
    await expect(gw.parseWebhook(payload, { 'x-chainpay-signature': 'deadbeef' })).rejects.toThrow('验签失败');
  });
});

// ---------------------------------------------------------------------------
// 全链路 E2E（usdt 渠道 + 本地 mock ChainPay 服务）
// ---------------------------------------------------------------------------

describe('payments E2E（routes + webhook + 入账幂等）', () => {
  let ts: TestServer;
  let rootCookie: string;
  let opCookie: string;
  let opId: number;
  let viewerCookie: string;
  let mockServer: Server;
  let mockBaseUrl: string;
  /** mock ChainPay 的单状态机：orderId -> status */
  const cpOrders = new Map<string, string>();

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/v1/orders') {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { externalId: string };
          const orderId = `cp-${body.externalId}`;
          if (!cpOrders.has(orderId)) cpOrders.set(orderId, 'pending');
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({ orderId, checkoutUrl: `${mockBaseUrl}/checkout/${orderId}`, status: 'pending' }),
          );
          return;
        }
        const m = req.url?.match(/^\/api\/v1\/orders\/(.+)$/);
        if (req.method === 'GET' && m) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ status: cpOrders.get(decodeURIComponent(m[1]!)) ?? 'pending' }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock server address unavailable');
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    ts = await makeTestServer();
    const root = await ts.seedLogin({ email: 'pay-root@example.com', password: 'root-pass-1234', role: 'root' });
    rootCookie = root.cookie;
    const op = await ts.seedLogin({ email: 'pay-op@example.com', password: 'op-pass-1234', role: 'operator' });
    opCookie = op.cookie;
    opId = op.operatorId;
    const viewer = await ts.seedLogin({ email: 'pay-viewer@example.com', password: 'v-pass-1234', role: 'viewer' });
    viewerCookie = viewer.cookie;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('root 配置 usdt 渠道；operator 可见支付方式；config 值绝不回读', async () => {
    // operator 配渠道 → 403
    const forbidden = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/providers',
      cookies: { rp_session: opCookie },
      payload: { key: 'usdt', name: 'USDT', config: { apiKey: 'a', appId: 'b', webhookSecret: 'c' } },
    });
    expect(forbidden.statusCode).toBe(403);

    // 缺必填键 → 400
    const missing = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/providers',
      cookies: { rp_session: rootCookie },
      payload: { key: 'usdt', name: 'USDT', config: { apiKey: 'a' } },
    });
    expect(missing.statusCode).toBe(400);

    const ok = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/providers',
      cookies: { rp_session: rootCookie },
      payload: {
        key: 'usdt',
        name: 'USDT (TRC20)',
        paymentMode: 'redirect',
        config: { apiKey: 'sk_live_e2e', appId: 'app-e2e', webhookSecret: 'whsec-e2e', baseUrl: mockBaseUrl },
      },
    });
    expect(ok.statusCode).toBe(200);

    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/providers',
      cookies: { rp_session: rootCookie },
    });
    const providers = (list.json() as { providers: Array<Record<string, unknown>> }).providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]!.configKeys).toEqual(expect.arrayContaining(['apiKey', 'appId', 'webhookSecret']));
    expect(JSON.stringify(providers)).not.toContain('sk_live_e2e');
    expect(JSON.stringify(providers)).not.toContain('whsec-e2e');

    const methods = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/payment-methods',
      cookies: { rp_session: opCookie },
    });
    expect((methods.json() as { methods: unknown[] }).methods).toEqual([
      { key: 'usdt', name: 'USDT (TRC20)', paymentMode: 'redirect' },
    ]);
  });

  let orderNo = '';

  it('operator 下单 → 201 + payUrl；viewer 403；免费套餐 400', async () => {
    const viewer = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      cookies: { rp_session: viewerCookie },
      payload: { planKey: 'pro', months: 1, providerKey: 'usdt' },
    });
    expect(viewer.statusCode).toBe(403);

    const free = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      cookies: { rp_session: opCookie },
      payload: { planKey: 'free', months: 1, providerKey: 'usdt' },
    });
    expect(free.statusCode).toBe(400);

    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      cookies: { rp_session: opCookie },
      payload: { planKey: 'pro', months: 2, providerKey: 'usdt' },
    });
    expect(res.statusCode).toBe(201);
    const order = (res.json() as { order: { orderNo: string; amount: number; payUrl: string; status: string } }).order;
    expect(order.amount).toBe(58);
    expect(order.payUrl).toContain('/checkout/cp-');
    expect(order.status).toBe('pending');
    orderNo = order.orderNo;
  });

  it('未付时轮询保持 pending；他人订单 404', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/billing/orders/${orderNo}`,
      cookies: { rp_session: opCookie },
    });
    expect((res.json() as { order: { status: string } }).order.status).toBe('pending');

    const other = await ts.app.inject({
      method: 'GET',
      url: `/api/billing/orders/${orderNo}`,
      cookies: { rp_session: viewerCookie },
    });
    expect(other.statusCode).toBe(404);
  });

  it('坏签名 webhook → 400 且不入账', async () => {
    cpOrders.set(`cp-${orderNo}`, 'completed'); // 渠道侧已付
    const payload = JSON.stringify({ event: 'completed', externalId: orderNo });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/webhooks/payment/usdt',
      headers: { 'content-type': 'application/json', 'x-chainpay-signature': 'bad' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    const subs = await ts.db.orm.select().from(subscriptions).where(eq(subscriptions.operatorId, opId));
    expect(subs).toHaveLength(0);
  });

  it('正签 webhook → 查单核实 → 订阅开通；重放幂等不双开', async () => {
    const payload = JSON.stringify({ event: 'completed', externalId: orderNo });
    const sig = createHmac('sha256', 'whsec-e2e').update(Buffer.from(payload, 'utf8')).digest('hex');
    const fire = (): ReturnType<TestServer['app']['inject']> =>
      ts.app.inject({
        method: 'POST',
        url: '/webhooks/payment/usdt',
        headers: { 'content-type': 'application/json', 'x-chainpay-signature': sig },
        payload,
      });
    const first = await fire();
    expect(first.statusCode).toBe(200);
    const replay = await fire();
    expect(replay.statusCode).toBe(200);

    const subs = await ts.db.orm.select().from(subscriptions).where(eq(subscriptions.operatorId, opId));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.planKey).toBe('pro');
    // 2 个月 = +60 天
    const periodEnd = new Date(subs[0]!.currentPeriodEnd).getTime();
    expect(periodEnd).toBeGreaterThan(Date.now() + 59 * 86_400_000);

    const rows = await ts.db.orm.select().from(paymentOrders).where(eq(paymentOrders.orderNo, orderNo));
    expect(rows[0]!.status).toBe('completed');
  });

  it('root 全量订单可见 operator 邮箱；operator 只见自己的', async () => {
    const all = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/orders?all=1',
      cookies: { rp_session: rootCookie },
    });
    const allOrders = (all.json() as { orders: Array<{ operatorEmail?: string }> }).orders;
    expect(allOrders.some((o) => o.operatorEmail === 'pay-op@example.com')).toBe(true);

    const mineForbidden = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/orders?all=1',
      cookies: { rp_session: opCookie },
    });
    expect(mineForbidden.statusCode).toBe(403);
  });

  it('取消 pending 单；已完成单取消无效', async () => {
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      cookies: { rp_session: opCookie },
      payload: { planKey: 'pro', months: 1, providerKey: 'usdt' },
    });
    const pendingNo = (created.json() as { order: { orderNo: string } }).order.orderNo;
    const cancel = await ts.app.inject({
      method: 'POST',
      url: `/api/billing/orders/${pendingNo}/cancel`,
      cookies: { rp_session: opCookie },
    });
    expect((cancel.json() as { order: { status: string } }).order.status).toBe('cancelled');

    const cancelDone = await ts.app.inject({
      method: 'POST',
      url: `/api/billing/orders/${orderNo}/cancel`,
      cookies: { rp_session: opCookie },
    });
    expect((cancelDone.json() as { order: { status: string } }).order.status).toBe('completed');
  });
});
