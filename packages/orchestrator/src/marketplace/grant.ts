import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { ChannelSpec, EngineAdapter, EngineKind, InstanceInfo } from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  channelGrants,
  channelTemplates,
  sites,
  type ChannelGrantRow,
  type ChannelTemplateRow,
  type SiteRow,
} from '../db/schema.js';
import { ApiError, canAccessSite, type SessionCtx } from '../auth/rbac.js';
import { writeAudit } from '../audit.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { redactText } from '../jobs/engine.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import type { MeteringGateway } from './gateway.js';
import type { GrantInput } from './types.js';

/**
 * 渠道市场授权流程（规格 §7，DB 版）：模板与站点均以 DB 为准（channel_templates/sites），
 * 不再依赖 registry.ts。byo=站长自带上游参数；managed=向计量网关签发 per-site key。
 * 凭据只在内存流转：apiKey 只进目标站引擎，绝不入面板 DB/审计/日志。
 */

export interface GrantDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  gateway: MeteringGateway | null;
}

/** 对外授权视图——不含 meterKeyRef 等内部引用，更不含任何 key 明文 */
export interface GrantView {
  id: number;
  siteSlug: string;
  siteLabel: string;
  templateKey: string;
  templateTitle: string;
  source: string;
  channelName: string | null;
  engineChannelId: string;
  /** 是否托管计量授权（meter_key_ref 非空） */
  managed: boolean;
  status: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

/** 模板导入/创建的统一校验（CLI import-templates 与路由 POST 共用） */
export const templateInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, '仅小写字母/数字/连字符，且以字母或数字开头'),
  title: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  protocol: z.enum(['anthropic', 'openai', 'openai-responses', 'gemini']),
  models: z.array(z.string().min(1)).min(1),
  suggestedRatio: z.number().positive().optional(),
  modelMapping: z.record(z.string()).optional(),
  source: z.enum(['byo', 'managed']).default('byo'),
  paramsSchema: z.record(z.unknown()).optional(),
  raw: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true),
});

export type TemplateInput = z.infer<typeof templateInputSchema>;

function templateInsertValues(item: TemplateInput): typeof channelTemplates.$inferInsert {
  return {
    key: item.key,
    title: item.title,
    protocol: item.protocol,
    models: item.models,
    source: item.source,
    enabled: item.enabled,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.suggestedRatio !== undefined ? { suggestedRatio: item.suggestedRatio } : {}),
    ...(item.modelMapping !== undefined ? { modelMapping: item.modelMapping } : {}),
    ...(item.paramsSchema !== undefined ? { paramsSchema: item.paramsSchema } : {}),
    ...(item.raw !== undefined ? { raw: item.raw } : {}),
  };
}

/**
 * JSON 模板批量 upsert（key 幂等；文件即真相，缺省字段清空旧值）。
 * CLI `import-templates <json>` 的实现主体，也可被测试直调。
 */
export async function importTemplates(
  db: Db,
  input: unknown,
): Promise<{ inserted: number; updated: number }> {
  const parsed = z.array(templateInputSchema).safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    throw new ApiError(400, `模板文件格式无效: ${issues}`);
  }
  const existing = await db.orm.select({ key: channelTemplates.key }).from(channelTemplates);
  const existingKeys = new Set(existing.map((r) => r.key));

  let inserted = 0;
  let updated = 0;
  for (const item of parsed.data) {
    await db.orm
      .insert(channelTemplates)
      .values(templateInsertValues(item))
      .onConflictDoUpdate({
        target: channelTemplates.key,
        set: {
          title: item.title,
          description: item.description ?? null,
          protocol: item.protocol,
          models: item.models,
          suggestedRatio: item.suggestedRatio ?? null,
          modelMapping: item.modelMapping ?? null,
          source: item.source,
          paramsSchema: item.paramsSchema ?? null,
          raw: item.raw ?? null,
          enabled: item.enabled,
        },
      });
    if (existingKeys.has(item.key)) {
      updated += 1;
    } else {
      inserted += 1;
      existingKeys.add(item.key);
    }
  }
  return { inserted, updated };
}

/** SiteRow → adapter 的 InstanceInfo（凭据仍走 credentialRef 引用，不解密到这里） */
function instanceInfoOf(site: SiteRow): InstanceInfo {
  return {
    siteSlug: site.slug,
    engine: site.engine as EngineKind,
    version: site.version,
    baseUrl: site.baseUrl,
    dataDir: site.dataDir,
    composeProject: site.composeProject,
    credentialRef: site.credentialRef,
  };
}

/** 不存在与无权访问统一 404（不向 operator 泄露他人站的存在性，语义同 sites 模块） */
async function loadAccessibleSite(db: Db, ctx: SessionCtx, siteSlug: string): Promise<SiteRow> {
  const rows = await db.orm.select().from(sites).where(eq(sites.slug, siteSlug)).limit(1);
  const site = rows[0];
  if (!site || !canAccessSite(ctx, site)) throw new ApiError(404, '站点不存在');
  return site;
}

function adapterFor(deps: GrantDeps, site: SiteRow): EngineAdapter {
  const adapter = deps.adapters[site.engine as EngineKind];
  if (!adapter) throw new ApiError(400, `不支持的引擎: ${site.engine}`);
  return adapter;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从模板 + 上游接入参数构造引擎无关的 ChannelSpec */
function buildChannelSpec(
  tpl: ChannelTemplateRow,
  input: GrantInput,
  upstream: { baseUrl: string; apiKey: string },
): ChannelSpec {
  return {
    name: input.channelName ?? tpl.title,
    protocol: tpl.protocol as ChannelSpec['protocol'],
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    models: tpl.models,
    ...(tpl.modelMapping ? { modelMapping: tpl.modelMapping } : {}),
    ...(input.groupIds !== undefined ? { groups: input.groupIds } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(tpl.raw ? { raw: tpl.raw } : {}),
  };
}

function toGrantView(grant: ChannelGrantRow, tpl: ChannelTemplateRow, site: SiteRow): GrantView {
  return {
    id: grant.id,
    siteSlug: site.slug,
    siteLabel: site.label,
    templateKey: tpl.key,
    templateTitle: tpl.title,
    source: tpl.source,
    channelName: grant.channelName,
    engineChannelId: grant.engineChannelId,
    managed: grant.meterKeyRef !== null,
    status: grant.status,
    createdBy: grant.createdBy,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  };
}

/**
 * 启用授权：模板校验 → 站点可达性/权限 → (managed: 网关签发 key) → 注入渠道
 * → 落 channel_grants → 审计。managed 注入失败时吊销已签发的 key（不留悬挂计费凭据）。
 */
export async function applyGrant(deps: GrantDeps, ctx: SessionCtx, input: GrantInput): Promise<GrantView> {
  const { db } = deps;

  const tplRows = await db.orm
    .select()
    .from(channelTemplates)
    .where(eq(channelTemplates.key, input.templateKey))
    .limit(1);
  const tpl = tplRows[0];
  if (!tpl) throw new ApiError(404, '模板不存在');
  if (!tpl.enabled) throw new ApiError(400, '模板已停用');
  // source 与入参匹配：byo 必带自带上游参数；managed 不接受（key 由网关签发）
  if (tpl.source === 'byo' && !input.byo) {
    throw new ApiError(400, 'byo 模板需提供自带上游的 baseUrl 与 apiKey');
  }
  if (tpl.source === 'managed' && input.byo) {
    throw new ApiError(400, 'managed 模板由计量网关签发接入参数，不接受自带上游参数');
  }

  const site = await loadAccessibleSite(db, ctx, input.siteSlug);
  if (site.status === 'destroyed') throw new ApiError(400, '站点已销毁，无法启用渠道');
  if (site.readonly) throw new ApiError(403, '该站点已设为只读，无法注入渠道（可在站点设置中关闭只读）');
  const adapter = adapterFor(deps, site);

  const auditFail = async (error: string): Promise<void> => {
    await writeAudit(db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'marketplace.grant',
      // 注意：payload 字段名避开 key/token 等（redact 按 key 名整值抹除），模板键用 'template'
      payload: { template: tpl.key, source: tpl.source },
      ok: false,
      error,
    });
  };

  // 上游接入参数：byo=入参自带；managed=网关签发
  let upstream: { baseUrl: string; apiKey: string };
  let meterKeyRef: string | null = null;
  if (tpl.source === 'managed') {
    if (deps.gateway === null) throw new ApiError(400, '计量网关未配置');
    try {
      const issued = await deps.gateway.issueKey({
        siteSlug: site.slug,
        templateKey: tpl.key,
        models: tpl.models,
      });
      upstream = { baseUrl: issued.baseUrl, apiKey: issued.apiKey };
      meterKeyRef = issued.keyRef;
    } catch (err) {
      const msg = redactText(messageOf(err));
      await auditFail(msg);
      throw new ApiError(502, `计量网关签发失败: ${msg}`);
    }
  } else {
    upstream = input.byo!;
  }

  const spec = buildChannelSpec(tpl, input, upstream);
  let engineChannelId: string;
  try {
    const client = await adapter.connect(instanceInfoOf(site), makeCredentialStoreV2(db, deps.config));
    const created = await client.channels.create(spec);
    engineChannelId = created.id;
  } catch (err) {
    // managed 回滚：注入失败必须吊销已签发的计量 key（吊销自身失败不掩盖原始错误）
    if (meterKeyRef !== null && deps.gateway !== null) {
      await deps.gateway.revokeKey(meterKeyRef).catch(() => undefined);
    }
    const msg = redactText(messageOf(err));
    await auditFail(msg);
    throw new ApiError(502, `渠道注入失败: ${msg}`);
  }

  const inserted = await db.orm
    .insert(channelGrants)
    .values({
      siteId: site.id,
      templateId: tpl.id,
      engineChannelId,
      meterKeyRef,
      channelName: spec.name,
      createdBy: ctx.email,
    })
    .returning();
  const grant = inserted[0]!;

  await writeAudit(db, {
    siteId: site.id,
    actor: ctx.email,
    action: 'marketplace.grant',
    payload: {
      grantId: grant.id,
      template: tpl.key,
      source: tpl.source,
      channelName: spec.name,
      engineChannelId,
    },
    ok: true,
  });

  return toGrantView(grant, tpl, site);
}

/**
 * 撤销授权：站内删除渠道 → (managed: 网关吊销 key) → 状态改 revoked → 审计。
 * 站点不可达等删除失败时，仅当 force 才允许只改状态（渠道残留由站长自行清理）。
 */
export async function revokeGrant(
  deps: GrantDeps,
  ctx: SessionCtx,
  grantId: number,
  opts: { force: boolean },
): Promise<GrantView> {
  const { db } = deps;
  const rows = await db.orm
    .select({ grant: channelGrants, template: channelTemplates, site: sites })
    .from(channelGrants)
    .innerJoin(channelTemplates, eq(channelGrants.templateId, channelTemplates.id))
    .innerJoin(sites, eq(channelGrants.siteId, sites.id))
    .where(eq(channelGrants.id, grantId))
    .limit(1);
  const row = rows[0];
  if (!row || !canAccessSite(ctx, row.site)) throw new ApiError(404, '授权不存在');
  if (row.grant.status !== 'active') throw new ApiError(400, '授权已撤销');
  // readonly 站不动引擎；确需撤销可 force（仅撤记录不碰站内渠道）或先关只读
  if (row.site.readonly && !opts.force) {
    throw new ApiError(403, '该站点已设为只读（可加 ?force=1 仅撤销记录，或先关闭只读）');
  }

  const auditFail = async (error: string): Promise<void> => {
    await writeAudit(db, {
      siteId: row.site.id,
      actor: ctx.email,
      action: 'marketplace.revoke',
      payload: { grantId, template: row.template.key, force: opts.force },
      ok: false,
      error,
    });
  };

  const adapter = adapterFor(deps, row.site);
  if (!row.site.readonly) {
    // readonly+force 时跳过引擎删除（只撤记录），其余情况照常删站内渠道
    try {
      const client = await adapter.connect(instanceInfoOf(row.site), makeCredentialStoreV2(db, deps.config));
      await client.channels.remove(row.grant.engineChannelId);
    } catch (err) {
      if (!opts.force) {
        const msg = redactText(messageOf(err));
        await auditFail(msg);
        throw new ApiError(502, `站点渠道删除失败: ${msg}（站点不可达时可加 ?force=1 仅撤销记录）`);
      }
    }
  }

  if (row.grant.meterKeyRef !== null) {
    if (deps.gateway === null) {
      if (!opts.force) {
        await auditFail('计量网关未配置');
        throw new ApiError(400, '计量网关未配置，无法吊销计量 key（可加 ?force=1 仅撤销记录）');
      }
    } else {
      try {
        await deps.gateway.revokeKey(row.grant.meterKeyRef);
      } catch (err) {
        if (!opts.force) {
          const msg = redactText(messageOf(err));
          await auditFail(msg);
          throw new ApiError(502, `计量 key 吊销失败: ${msg}（可加 ?force=1 仅撤销记录）`);
        }
      }
    }
  }

  const updated = await db.orm
    .update(channelGrants)
    .set({ status: 'revoked', revokedAt: toPgTimestamp(new Date()) })
    .where(eq(channelGrants.id, grantId))
    .returning();

  await writeAudit(db, {
    siteId: row.site.id,
    actor: ctx.email,
    action: 'marketplace.revoke',
    payload: {
      grantId,
      template: row.template.key,
      engineChannelId: row.grant.engineChannelId,
      force: opts.force,
    },
    ok: true,
  });

  return toGrantView(updated[0]!, row.template, row.site);
}

/** 授权列表（含模板/站点信息）；operator 只见自己站的授权 */
export async function listGrants(
  deps: GrantDeps,
  ctx: SessionCtx,
  filter: { siteSlug?: string } = {},
): Promise<GrantView[]> {
  const conds = [];
  if (filter.siteSlug !== undefined) conds.push(eq(sites.slug, filter.siteSlug));
  const rows = await deps.db.orm
    .select({ grant: channelGrants, template: channelTemplates, site: sites })
    .from(channelGrants)
    .innerJoin(channelTemplates, eq(channelGrants.templateId, channelTemplates.id))
    .innerJoin(sites, eq(channelGrants.siteId, sites.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(channelGrants.id));
  return rows
    .filter((r) => canAccessSite(ctx, r.site))
    .map((r) => toGrantView(r.grant, r.template, r.site));
}
