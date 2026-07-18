import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChannelSpec, SiteBranding } from '@relay-panel/adapter-core';
import { ApiError } from '../auth/rbac.js';
import { SitesService, type SitesServiceDeps } from './service.js';

/**
 * 站点路由（规格 §6，G1 完整版）。业务规则都在 SitesService，这里只做
 * 参数校验（zod）与形状组装。业务错误统一 ApiError(status, 中文消息)。
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const notLatest = (v: string): boolean => v !== 'latest';

const brandingSchema = z.object({
  siteName: z.string().min(1).max(64).optional(),
  logoUrl: z.string().url().optional(),
  announcement: z.string().max(500).optional(),
});

const createSiteBody = z.object({
  slug: z.string().regex(SLUG_RE, '需为 2-32 位小写字母/数字/连字符，且以字母或数字开头'),
  label: z.string().min(1).max(64),
  engine: z.enum(['sub2api', 'newapi']),
  version: z.string().min(1).refine(notLatest, '版本必须钉住，不允许 latest'),
  hostPort: z.number().int().min(1).max(65535).optional(),
  adminEmail: z.string().email(),
  branding: brandingSchema
    .extend({ siteName: z.string().min(1).max(64) }) // 建站时品牌名必填
    .optional(),
});

const adoptSiteBody = z
  .object({
    slug: z.string().regex(SLUG_RE, '需为 2-32 位小写字母/数字/连字符，且以字母或数字开头'),
    label: z.string().min(1).max(64).optional(),
    baseUrl: z.string().url(),
    engine: z.enum(['sub2api', 'newapi']),
    adminApiKey: z.string().min(1).optional(),
    adminEmail: z.string().email().optional(),
    adminPassword: z.string().min(1).optional(),
    readonly: z.boolean().optional(),
  })
  .refine(
    (v) => Boolean(v.adminApiKey) || (Boolean(v.adminEmail) && Boolean(v.adminPassword)),
    '需要提供 admin API key，或 admin 邮箱+密码',
  );

const siteFlagsBody = z
  .object({
    readonly: z.boolean().optional(),
    label: z.string().min(1).max(64).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '至少提供一个字段');

const upgradeBody = z.object({
  toVersion: z.string().min(1).refine(notLatest, '版本必须钉住，不允许 latest'),
});

const destroyBody = z.object({
  confirm: z.string().min(1),
  keepData: z.boolean().optional(),
});

const protocolEnum = z.enum(['anthropic', 'openai', 'openai-responses', 'gemini']);

const channelCreateBody = z.object({
  name: z.string().min(1).max(64),
  protocol: protocolEnum,
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  modelMapping: z.record(z.string()).optional(),
  groups: z.array(z.string().min(1)).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().optional(),
  raw: z.record(z.unknown()).optional(),
});

const channelPatchBody = z.object({
  name: z.string().min(1).max(64).optional(),
  protocol: protocolEnum.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).min(1).optional(),
  modelMapping: z.record(z.string()).optional(),
  groups: z.array(z.string().min(1)).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().optional(),
  raw: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const channelTestBody = z.object({
  model: z.string().min(1).optional(),
});

const userStatusBody = z.object({
  status: z.enum(['active', 'disabled']),
});

/** zod 校验失败统一 400；issue 文案不含请求原值（key 等不回显） */
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

type SlugParams = { Params: { slug: string } };
type SlugIdParams = { Params: { slug: string; id: string } };

export function registerSitesRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const service = new SitesService(deps);

  // ---- 读 ----

  app.get('/api/sites', async (req) => {
    const ctx = requireCtx(req);
    const list = await service.listSites(ctx);
    return { sites: list, generatedAt: new Date().toISOString() };
  });

  app.get<SlugParams>('/api/sites/:slug', async (req) => {
    const ctx = requireCtx(req);
    return service.getSite(ctx, req.params.slug);
  });

  app.get<SlugParams>('/api/sites/:slug/channels', async (req) => {
    const ctx = requireCtx(req);
    return { channels: await service.listChannels(ctx, req.params.slug) };
  });

  app.get<SlugParams>('/api/sites/:slug/groups', async (req) => {
    const ctx = requireCtx(req);
    return { groups: await service.listGroups(ctx, req.params.slug) };
  });

  app.get<SlugParams & { Querystring: { search?: string } }>('/api/sites/:slug/users', async (req) => {
    const ctx = requireCtx(req);
    return { users: await service.listUsers(ctx, req.params.slug, req.query.search) };
  });

  app.get<SlugParams>('/api/sites/:slug/branding', async (req) => {
    const ctx = requireCtx(req);
    return { branding: await service.getBranding(ctx, req.params.slug) };
  });

  app.get<SlugParams & { Querystring: { days?: string } }>('/api/sites/:slug/usage', async (req) => {
    const ctx = requireCtx(req);
    const raw = req.query.days;
    const days = raw === undefined ? 7 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new ApiError(400, '参数 days 须为 1-30 的整数');
    }
    return service.usageSeries(ctx, req.params.slug, days);
  });

  app.get<SlugParams & { Querystring: { limit?: string } }>('/api/sites/:slug/audit', async (req) => {
    const ctx = requireCtx(req);
    const raw = req.query.limit;
    const limit = raw === undefined ? 50 : Number(raw);
    return { events: await service.auditTrail(ctx, req.params.slug, Number.isFinite(limit) ? limit : 50) };
  });

  // ---- 写：站点生命周期 ----

  app.post('/api/sites', async (req, reply) => {
    const ctx = requireCtx(req);
    const body = parseBody(createSiteBody, req.body);
    const out = await service.createSite(ctx, {
      slug: body.slug,
      label: body.label,
      engine: body.engine,
      version: body.version,
      adminEmail: body.adminEmail,
      ...(body.hostPort !== undefined ? { hostPort: body.hostPort } : {}),
      ...(body.branding !== undefined ? { branding: body.branding as SiteBranding } : {}),
    });
    return reply.code(201).send(out);
  });

  // 接管存量站（自助 adopt）：凭据入 body（TLS 内传输，绝不回显）
  app.post('/api/sites/adopt', async (req, reply) => {
    const ctx = requireCtx(req);
    const body = parseBody(adoptSiteBody, req.body);
    const out = await service.adoptSite(ctx, {
      slug: body.slug,
      baseUrl: body.baseUrl,
      engine: body.engine,
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.adminApiKey !== undefined ? { adminApiKey: body.adminApiKey } : {}),
      ...(body.adminEmail !== undefined ? { adminEmail: body.adminEmail } : {}),
      ...(body.adminPassword !== undefined ? { adminPassword: body.adminPassword } : {}),
      ...(body.readonly !== undefined ? { readonly: body.readonly } : {}),
    });
    return reply.code(201).send(out);
  });

  // 站点标记（readonly 保险丝 / 展示名 / 备注）
  app.patch<SlugParams>('/api/sites/:slug', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(siteFlagsBody, req.body);
    await service.setSiteFlags(ctx, req.params.slug, {
      ...(body.readonly !== undefined ? { readonly: body.readonly } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
    return { ok: true };
  });

  app.post<SlugParams>('/api/sites/:slug/upgrade', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(upgradeBody, req.body);
    return service.upgradeSite(ctx, req.params.slug, body.toVersion);
  });

  app.post<SlugParams>('/api/sites/:slug/start', async (req) => {
    const ctx = requireCtx(req);
    return service.startSite(ctx, req.params.slug);
  });

  app.post<SlugParams>('/api/sites/:slug/stop', async (req) => {
    const ctx = requireCtx(req);
    return service.stopSite(ctx, req.params.slug);
  });

  app.delete<SlugParams>('/api/sites/:slug', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(destroyBody, req.body);
    return service.destroySite(ctx, req.params.slug, body.confirm, body.keepData === true);
  });

  // ---- 写：渠道 / 用户 / 品牌 ----

  app.post<SlugParams>('/api/sites/:slug/channels', async (req, reply) => {
    const ctx = requireCtx(req);
    const b = parseBody(channelCreateBody, req.body);
    const spec: ChannelSpec = {
      name: b.name,
      protocol: b.protocol,
      baseUrl: b.baseUrl,
      apiKey: b.apiKey,
      models: b.models,
      ...(b.modelMapping !== undefined ? { modelMapping: b.modelMapping } : {}),
      ...(b.groups !== undefined ? { groups: b.groups } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.weight !== undefined ? { weight: b.weight } : {}),
      ...(b.raw !== undefined ? { raw: b.raw as Record<string, unknown> } : {}),
    };
    const channel = await service.createChannel(ctx, req.params.slug, spec);
    return reply.code(201).send({ channel });
  });

  app.patch<SlugIdParams>('/api/sites/:slug/channels/:id', async (req) => {
    const ctx = requireCtx(req);
    const b = parseBody(channelPatchBody, req.body);
    const patch = {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.protocol !== undefined ? { protocol: b.protocol } : {}),
      ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}),
      ...(b.apiKey !== undefined ? { apiKey: b.apiKey } : {}),
      ...(b.models !== undefined ? { models: b.models } : {}),
      ...(b.modelMapping !== undefined ? { modelMapping: b.modelMapping } : {}),
      ...(b.groups !== undefined ? { groups: b.groups } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.weight !== undefined ? { weight: b.weight } : {}),
      ...(b.raw !== undefined ? { raw: b.raw as Record<string, unknown> } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    };
    if (Object.keys(patch).length === 0) throw new ApiError(400, '没有可更新的字段');
    const channel = await service.updateChannel(ctx, req.params.slug, req.params.id, patch);
    return { channel };
  });

  app.delete<SlugIdParams>('/api/sites/:slug/channels/:id', async (req) => {
    const ctx = requireCtx(req);
    await service.deleteChannel(ctx, req.params.slug, req.params.id);
    return { ok: true };
  });

  app.post<SlugIdParams>('/api/sites/:slug/channels/:id/test', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(channelTestBody, req.body);
    const result = await service.testChannel(ctx, req.params.slug, req.params.id, body.model);
    return { result };
  });

  app.patch<SlugIdParams>('/api/sites/:slug/users/:id', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(userStatusBody, req.body);
    await service.setUserStatus(ctx, req.params.slug, req.params.id, body.status);
    return { ok: true };
  });

  app.put<SlugParams>('/api/sites/:slug/branding', async (req) => {
    const ctx = requireCtx(req);
    const b = parseBody(brandingSchema, req.body);
    const patch: Partial<SiteBranding> = {
      ...(b.siteName !== undefined ? { siteName: b.siteName } : {}),
      ...(b.logoUrl !== undefined ? { logoUrl: b.logoUrl } : {}),
      ...(b.announcement !== undefined ? { announcement: b.announcement } : {}),
    };
    if (Object.keys(patch).length === 0) throw new ApiError(400, '没有可更新的字段');
    await service.setBranding(ctx, req.params.slug, patch);
    return { ok: true };
  });
}
