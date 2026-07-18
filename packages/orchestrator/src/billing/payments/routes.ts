import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../auth/rbac.js';
import { PaymentsService } from './service.js';
import { KNOWN_PROVIDER_KEYS } from './types.js';

/**
 * 收款路由。认证由 server.ts 全局钩子保证；webhook 单独走 registerPaymentWebhooks
 * （/webhooks/* 不在 /api/* 认证与 CSRF 范围内，且需要原始 body 验签）。
 */

export interface PaymentRoutesDeps {
  config: Config;
  db: Db;
}

const checkoutBody = z.object({
  planKey: z.string().min(1),
  months: z.number().int().min(1).max(120),
  providerKey: z.string().min(1),
});

const providerUpsertBody = z.object({
  key: z.enum(KNOWN_PROVIDER_KEYS as [string, ...string[]]),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
  paymentMode: z.enum(['', 'redirect']).default(''),
  config: z.record(z.string()).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ApiError(400, `请求参数无效: ${issues}`);
  }
  return r.data;
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentRoutesDeps): void {
  const service = new PaymentsService(deps);

  // ---- 全员：可用支付方式 ----
  app.get('/api/billing/payment-methods', async (req) => {
    requireCtx(req);
    return { methods: await service.listMethods() };
  });

  // ---- 自助购买 ----
  app.post('/api/billing/checkout', async (req, reply) => {
    const ctx = requireCtx(req);
    const body = parseBody(checkoutBody, req.body);
    const order = await service.createCheckout(ctx, body);
    return reply.code(201).send({ order });
  });

  app.get<{ Params: { orderNo: string } }>('/api/billing/orders/:orderNo', async (req) => {
    const ctx = requireCtx(req);
    return { order: await service.getOrder(ctx, req.params.orderNo) };
  });

  app.post<{ Params: { orderNo: string } }>('/api/billing/orders/:orderNo/cancel', async (req) => {
    const ctx = requireCtx(req);
    return { order: await service.cancelOrder(ctx, req.params.orderNo) };
  });

  // 我的订单；root 加 ?all=1 看全量
  app.get<{ Querystring: { all?: string } }>('/api/billing/orders', async (req) => {
    const ctx = requireCtx(req);
    return { orders: await service.listOrders(ctx, req.query.all === '1') };
  });

  // ---- root：渠道配置（config 只写不读） ----
  app.get('/api/billing/providers', async (req) => {
    const ctx = requireCtx(req);
    return { providers: await service.listProviders(ctx) };
  });

  app.post('/api/billing/providers', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(providerUpsertBody, req.body);
    await service.upsertProvider(ctx, {
      key: body.key,
      name: body.name,
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 0,
      paymentMode: body.paymentMode ?? '',
      ...(body.config !== undefined ? { config: body.config } : {}),
    });
    return { ok: true };
  });

  app.delete<{ Params: { key: string } }>('/api/billing/providers/:key', async (req) => {
    const ctx = requireCtx(req);
    await service.deleteProvider(ctx, req.params.key);
    return { ok: true };
  });
}

/**
 * webhook 挂载：独立封装 scope，body 一律按原始 Buffer 接收（验签必须逐字节原文）。
 * 免认证（渠道服务器回调）；验签失败回 400，渠道会按各自策略重试。
 */
export function registerPaymentWebhooks(app: FastifyInstance, deps: PaymentRoutesDeps): void {
  const service = new PaymentsService(deps);

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post<{ Params: { provider: string } }>('/webhooks/payment/:provider', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
      try {
        const ack = await service.handleWebhook(req.params.provider, raw, req.headers);
        return reply.type(ack.contentType).send(ack.body);
      } catch (err) {
        // 不回显细节（避免给探测者反馈面）；服务端日志走 fastify logger
        req.log.warn({ err }, 'payment webhook rejected');
        return reply.code(400).send({ error: 'webhook rejected' });
      }
    });
  });
}
