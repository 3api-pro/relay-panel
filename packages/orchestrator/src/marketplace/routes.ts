import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { EngineAdapter, EngineKind } from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { channelGrants, channelTemplates, sites, type ChannelTemplateRow } from '../db/schema.js';
import { ApiError, canAccessSite, requireRoot, requireWrite } from '../auth/rbac.js';
import { redact, writeAudit } from '../audit.js';
import type { MeteringGateway } from './gateway.js';
import {
  applyGrant,
  listGrants,
  revokeGrant,
  templateInputSchema,
  type GrantDeps,
} from './grant.js';
import { settlement, upsertRows, type LedgerRowInput, type SettlementRow } from './ledger.js';
import type { GrantInput } from './types.js';

/**
 * 渠道市场路由（规格 §7）：模板 CRUD(root) / 授权增删查 / 账本查询与手工补账。
 * 全部写操作 requireWrite（模板与补账 requireRoot）+ writeAudit；
 * 响应绝不含 apiKey/meterKeyRef 等凭据或内部引用。
 */

export interface MarketplaceRoutesDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  gateway: MeteringGateway | null;
}

const protocolEnum = z.enum(['anthropic', 'openai', 'openai-responses', 'gemini']);

/** PATCH 专用：不复用 templateInputSchema.partial()（其 default 会把缺省字段重置） */
const templatePatchBody = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  protocol: protocolEnum.optional(),
  models: z.array(z.string().min(1)).min(1).optional(),
  suggestedRatio: z.number().positive().nullable().optional(),
  modelMapping: z.record(z.string()).nullable().optional(),
  source: z.enum(['byo', 'managed']).optional(),
  paramsSchema: z.record(z.unknown()).nullable().optional(),
  raw: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
});

const grantCreateBody = z.object({
  siteSlug: z.string().min(1),
  templateKey: z.string().min(1),
  channelName: z.string().min(1).max(100).optional(),
  byo: z
    .object({
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
    })
    .optional(),
  groupIds: z.array(z.string().min(1)).optional(),
  priority: z.number().int().min(0).optional(),
});

const ledgerImportBody = z.object({
  grantId: z.number().int().positive(),
  rows: z
    .array(
      z.object({
        periodStart: z.string().min(1),
        periodEnd: z.string().min(1),
        requests: z.number().int().min(0).default(0),
        promptTokens: z.number().int().min(0).default(0),
        completionTokens: z.number().int().min(0).default(0),
        upstreamCost: z.number().min(0).default(0),
        billedCost: z.number().min(0).default(0),
      }),
    )
    .min(1),
});

const ledgerQuerySchema = z.object({
  siteSlug: z.string().min(1).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, '格式应为 YYYY-MM')
    .optional(),
});

/** zod 校验失败统一 400；issue 文案不含请求原值（apiKey 等不回显） */
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

function parseId(raw: string, notFoundMsg: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, notFoundMsg);
  return id;
}

/** 模板对外视图：raw 里的敏感 key 值统一抹除（模板本不该存凭据，防御性兜底） */
function templateView(row: ChannelTemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    protocol: row.protocol,
    models: row.models,
    suggestedRatio: row.suggestedRatio,
    modelMapping: row.modelMapping,
    source: row.source,
    paramsSchema: row.paramsSchema,
    raw: row.raw ? redact(row.raw) : null,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const text = `${err.message} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  return /duplicate|unique/i.test(text);
}

export function registerMarketplaceRoutes(app: FastifyInstance, deps: MarketplaceRoutesDeps): void {
  const { db } = deps;
  const grantDeps: GrantDeps = {
    config: deps.config,
    db: deps.db,
    adapters: deps.adapters,
    gateway: deps.gateway,
  };

  // ---- 模板 ----

  app.get<{ Querystring: { all?: string } }>('/api/marketplace/templates', async (req) => {
    const ctx = requireCtx(req);
    // root 可带 ?all=1 连同已停用模板一起看（管理页）；其余角色只见 enabled
    const includeDisabled = req.query.all === '1' && ctx.role === 'root';
    const rows = await db.orm
      .select()
      .from(channelTemplates)
      .where(includeDisabled ? undefined : eq(channelTemplates.enabled, true))
      .orderBy(channelTemplates.id);
    return { templates: rows.map(templateView) };
  });

  app.post('/api/marketplace/templates', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const body = parseBody(templateInputSchema, req.body);
    let row: ChannelTemplateRow;
    try {
      const inserted = await db.orm
        .insert(channelTemplates)
        .values({
          key: body.key,
          title: body.title,
          protocol: body.protocol,
          models: body.models,
          source: body.source,
          enabled: body.enabled,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.suggestedRatio !== undefined ? { suggestedRatio: body.suggestedRatio } : {}),
          ...(body.modelMapping !== undefined ? { modelMapping: body.modelMapping } : {}),
          ...(body.paramsSchema !== undefined ? { paramsSchema: body.paramsSchema } : {}),
          ...(body.raw !== undefined ? { raw: body.raw } : {}),
        })
        .returning();
      row = inserted[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, '模板 key 已存在');
      throw err;
    }
    await writeAudit(db, {
      actor: ctx.email,
      action: 'marketplace.template.create',
      payload: { template: row.key, title: row.title, source: row.source },
      ok: true,
    });
    return templateView(row);
  });

  app.patch<{ Params: { id: string } }>('/api/marketplace/templates/:id', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const id = parseId(req.params.id, '模板不存在');
    const body = parseBody(templatePatchBody, req.body);

    // 显式区分「缺省=不动」与「null=清空」；key 不可改（授权记账依赖其稳定性）
    const set: Partial<typeof channelTemplates.$inferInsert> = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.models !== undefined ? { models: body.models } : {}),
      ...(body.suggestedRatio !== undefined ? { suggestedRatio: body.suggestedRatio } : {}),
      ...(body.modelMapping !== undefined ? { modelMapping: body.modelMapping } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.paramsSchema !== undefined ? { paramsSchema: body.paramsSchema } : {}),
      ...(body.raw !== undefined ? { raw: body.raw } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };
    if (Object.keys(set).length === 0) throw new ApiError(400, '没有可更新的字段');

    const updated = await db.orm
      .update(channelTemplates)
      .set(set)
      .where(eq(channelTemplates.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiError(404, '模板不存在');
    await writeAudit(db, {
      actor: ctx.email,
      action: 'marketplace.template.update',
      payload: { template: row.key, fields: Object.keys(set) },
      ok: true,
    });
    return templateView(row);
  });

  app.delete<{ Params: { id: string } }>('/api/marketplace/templates/:id', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const id = parseId(req.params.id, '模板不存在');
    const rows = await db.orm.select().from(channelTemplates).where(eq(channelTemplates.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiError(404, '模板不存在');
    const referenced = await db.orm
      .select({ id: channelGrants.id })
      .from(channelGrants)
      .where(eq(channelGrants.templateId, id))
      .limit(1);
    if (referenced.length > 0) throw new ApiError(400, '模板已有授权记录，不可删除（可改为停用）');
    await db.orm.delete(channelTemplates).where(eq(channelTemplates.id, id));
    await writeAudit(db, {
      actor: ctx.email,
      action: 'marketplace.template.delete',
      payload: { template: row.key },
      ok: true,
    });
    return { ok: true };
  });

  // ---- 授权 ----

  app.get<{ Querystring: { siteSlug?: string } }>('/api/marketplace/grants', async (req) => {
    const ctx = requireCtx(req);
    const siteSlug = req.query.siteSlug;
    const grants = await listGrants(grantDeps, ctx, {
      ...(siteSlug !== undefined && siteSlug !== '' ? { siteSlug } : {}),
    });
    return { grants };
  });

  app.post('/api/marketplace/grants', async (req) => {
    const ctx = requireCtx(req);
    requireWrite(ctx);
    const body = parseBody(grantCreateBody, req.body);
    const input: GrantInput = {
      siteSlug: body.siteSlug,
      templateKey: body.templateKey,
      ...(body.channelName !== undefined ? { channelName: body.channelName } : {}),
      ...(body.byo !== undefined ? { byo: body.byo } : {}),
      ...(body.groupIds !== undefined ? { groupIds: body.groupIds } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    };
    return applyGrant(grantDeps, ctx, input);
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/marketplace/grants/:id',
    async (req) => {
      const ctx = requireCtx(req);
      requireWrite(ctx);
      const id = parseId(req.params.id, '授权不存在');
      return revokeGrant(grantDeps, ctx, id, { force: req.query.force === '1' });
    },
  );

  // ---- 账本 ----

  app.get<{ Querystring: { siteSlug?: string; month?: string } }>(
    '/api/marketplace/ledger',
    async (req) => {
      const ctx = requireCtx(req);
      const query = parseBody(ledgerQuerySchema, req.query);

      let siteId: number | undefined;
      if (query.siteSlug !== undefined) {
        const siteRows = await db.orm.select().from(sites).where(eq(sites.slug, query.siteSlug)).limit(1);
        const site = siteRows[0];
        if (!site || !canAccessSite(ctx, site)) throw new ApiError(404, '站点不存在');
        siteId = site.id;
      }

      const all = await settlement(db, {
        ...(siteId !== undefined ? { siteId } : {}),
        ...(query.month !== undefined ? { month: query.month } : {}),
      });
      const visible = all.filter((r) => canAccessSite(ctx, { operatorId: r.operatorId }));
      // operatorId 只用于可见性过滤，不进响应
      const rows = visible.map(({ operatorId: _operatorId, ...rest }: SettlementRow) => rest);
      const totals = rows.reduce(
        (acc, r) => ({
          requests: acc.requests + r.requests,
          promptTokens: acc.promptTokens + r.promptTokens,
          completionTokens: acc.completionTokens + r.completionTokens,
          tokens: acc.tokens + r.tokens,
          upstreamCost: acc.upstreamCost + r.upstreamCost,
          billedCost: acc.billedCost + r.billedCost,
          margin: acc.margin + r.margin,
        }),
        { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0, upstreamCost: 0, billedCost: 0, margin: 0 },
      );
      return { rows, totals };
    },
  );

  app.post('/api/marketplace/ledger/import', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const body = parseBody(ledgerImportBody, req.body);
    const grantRows = await db.orm
      .select({ id: channelGrants.id, siteId: channelGrants.siteId })
      .from(channelGrants)
      .where(eq(channelGrants.id, body.grantId))
      .limit(1);
    const grant = grantRows[0];
    if (!grant) throw new ApiError(404, '授权不存在');
    const imported = await upsertRows(db, grant.id, body.rows as LedgerRowInput[], 'manual');
    await writeAudit(db, {
      siteId: grant.siteId,
      actor: ctx.email,
      action: 'marketplace.ledger.import',
      payload: { grantId: grant.id, count: imported },
      ok: true,
    });
    return { imported };
  });
}
