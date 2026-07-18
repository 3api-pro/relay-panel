import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChannelSpec } from '@relay-panel/adapter-core';
import { ApiError } from '../auth/rbac.js';
import { BatchService, type BatchAction, type BatchServiceDeps } from './service.js';

/**
 * 批量操作路由。POST /api/sites/batch —— 多选站点，一次操作扇出到全部。
 * 逐站结果返回，整体 200（partial 是常态）；权限/只读/审计由单站写路径保证。
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const slugsField = z.array(z.string().regex(SLUG_RE)).min(1).max(50);

const protocolEnum = z.enum(['anthropic', 'openai', 'openai-responses', 'gemini']);
const channelSpecSchema = z.object({
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

const batchBody = z.discriminatedUnion('kind', [
  z.object({ slugs: slugsField, kind: z.literal('announcement'), announcement: z.string().max(500) }),
  z.object({
    slugs: slugsField,
    kind: z.literal('branding'),
    siteName: z.string().min(1).max(64).optional(),
    logoUrl: z.string().url().optional(),
    announcement: z.string().max(500).optional(),
  }),
  z.object({ slugs: slugsField, kind: z.literal('channel.create'), channel: channelSpecSchema }),
  z.object({
    slugs: slugsField,
    kind: z.literal('channel.toggle'),
    channelName: z.string().min(1).max(64),
    enabled: z.boolean(),
  }),
  z.object({
    slugs: slugsField,
    kind: z.literal('grant'),
    templateKey: z.string().min(1),
    channelName: z.string().min(1).max(64).optional(),
    byo: z.object({ baseUrl: z.string().url(), apiKey: z.string().min(1) }).optional(),
    groupIds: z.array(z.string().min(1)).optional(),
    priority: z.number().int().optional(),
  }),
]);

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

/** zod 校验结果 → BatchAction（丢掉 slugs） */
function toAction(body: z.infer<typeof batchBody>): BatchAction {
  switch (body.kind) {
    case 'announcement':
      return { kind: 'announcement', announcement: body.announcement };
    case 'branding':
      return {
        kind: 'branding',
        ...(body.siteName !== undefined ? { siteName: body.siteName } : {}),
        ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
        ...(body.announcement !== undefined ? { announcement: body.announcement } : {}),
      };
    case 'channel.create':
      return { kind: 'channel.create', channel: body.channel as ChannelSpec };
    case 'channel.toggle':
      return { kind: 'channel.toggle', channelName: body.channelName, enabled: body.enabled };
    case 'grant':
      return {
        kind: 'grant',
        templateKey: body.templateKey,
        ...(body.channelName !== undefined ? { channelName: body.channelName } : {}),
        ...(body.byo !== undefined ? { byo: body.byo } : {}),
        ...(body.groupIds !== undefined ? { groupIds: body.groupIds } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      };
  }
}

export function registerBatchRoutes(app: FastifyInstance, deps: BatchServiceDeps): void {
  const service = new BatchService(deps);

  app.post('/api/sites/batch', async (req) => {
    const ctx = requireCtx(req);
    const body = parseBody(batchBody, req.body);
    const results = await service.run(ctx, body.slugs, toAction(body));
    const okCount = results.filter((r) => r.ok).length;
    return { total: results.length, ok: okCount, failed: results.length - okCount, results };
  });
}
