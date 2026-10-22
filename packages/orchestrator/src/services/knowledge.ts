import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { serviceDocuments as documents, serviceDocumentVersions as versions, serviceKnowledgeSpaces as spaces, sites, operators } from '../db/schema.js';
import { ApiError, canAccessSite, requireWrite, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { writeAudit } from '../audit.js';
import type { Orm } from '../db/client.js';
import type { SitesServiceDeps } from '../sites/service.js';
import { capabilityKeys, compatibilityFreshness, documentContentSchema, documentKinds, type DocumentContent } from './knowledge-content.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const queryId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, '请检查必填项、字段长度、日期和模型验证依据');
  return result.data;
};
const esc = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const names: Record<string, string> = { guide: '接入指南', faq: '常见问题', runbook: '操作手册', model: '模型兼容性', streaming: '流式输出', tools: '工具调用', vision: '图像输入', json: '结构化输出', reasoning: '推理参数', caching: '提示缓存', supported: '支持（站长记录）', unsupported: '不支持（站长记录）', unknown: '未验证' };
const label = (value: string) => names[value] ?? value;
const page = (title: string, content: string): string => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.7 system-ui;margin:0;background:#101827;color:#e5e7eb;padding:24px}main{max-width:850px;margin:auto}a{color:#8bdcc3}p,pre,h1,h2,td,small{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;border:1px solid #334155;padding:20px;border-radius:12px}small{color:#a1aec0}article{border-bottom:1px solid #334155;padding:16px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #334155}input,button{font:inherit;padding:8px;border-radius:6px;max-width:100%;box-sizing:border-box}input{width:75%}h1{font-size:1.7rem}</style></head><body><main>${content}</main></body></html>`;
function publicHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow').header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    .header('X-Content-Type-Options', 'nosniff');
}
function renderContent(content: DocumentContent): string {
  const c = content.compatibility, freshness = compatibilityFreshness(content);
  return `<small>${esc(label(content.kind))} · ${esc(content.category)}</small><h1>${esc(content.title)}</h1><p>${esc(content.summary)}</p><pre>${esc(content.body)}</pre>${c ? `<h2>模型能力记录</h2><p>${esc(c.model)} · ${esc(c.protocol)}</p><p>引擎版本：${esc(c.engineVersion || '未填写')} · 验证日期：${esc(c.testedOn || '未验证')}</p><p>${freshness === 'review_due' ? '验证记录已超过 30 天，请向站长确认当前兼容性。' : freshness === 'unverified' ? '尚无已验证能力。' : '以下为站长记录的验证结论。'} 面板未发送探测请求，也不提供兼容性认证。</p><table><thead><tr><th>能力</th><th>记录结果</th></tr></thead><tbody>${capabilityKeys.map(k => `<tr><td>${esc(label(k))}</td><td>${esc(label(c.capabilities[k]))}</td></tr>`).join('')}</tbody></table><h2>验证依据与限制</h2><pre>${esc(c.evidence || '未提供')}</pre>` : ''}`;
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const { db } = deps, base = '/api/services/knowledge';
  const audit = (ctx: SessionCtx, action: string, payload: Record<string, unknown>) => writeAudit(db, { actor: ctx.email, action: `knowledge.${action}`, payload, ok: true });
  async function site(ctx: SessionCtx, siteId: number, orm: Orm = db.orm) {
    const [row] = await orm.select({ site: sites }).from(sites).innerJoin(operators, eq(operators.id, sites.operatorId))
      .where(and(eq(sites.id, siteId), ne(sites.status, 'destroyed'), eq(operators.status, 'active')));
    if (!row || !canAccessSite(ctx, row.site)) throw new ApiError(404, '站点不存在');
    return row.site;
  }
  function requirePublisher(ctx: SessionCtx, ownerId: number): void {
    requireWrite(ctx);
    if (ctx.role !== 'root' && (ctx.operatorId !== ownerId || ctx.teamRole)) throw new ApiError(403, '仅站点所有者或管理员可公开发布与撤回');
  }
  async function document(ctx: SessionCtx, id: number) {
    const [row] = await db.orm.select().from(documents).where(eq(documents.id, id));
    if (!row) throw new ApiError(404, '内容不存在');
    await site(ctx, row.siteId);
    return row;
  }
  app.get(`${base}/space`, async req => {
    const q = parse(z.object({ siteId: queryId }), req.query), s = await site(req.ctx!, q.siteId);
    const [item] = await db.orm.select().from(spaces).where(eq(spaces.siteId, s.id));
    return { item: item ?? null, canPublish: req.ctx!.role === 'root' || (req.ctx!.role === 'operator' && req.ctx!.operatorId === s.operatorId && !req.ctx!.teamRole) };
  });
  app.post(`${base}/space`, async req => {
    const ctx = req.ctx!, b = parse(z.object({ siteId: positive, version: z.number().int().nonnegative(), title: z.string().trim().min(3).max(160), description: z.string().trim().max(1000), published: z.boolean() }).strict(), req.body);
    const s = await site(ctx, b.siteId); requirePublisher(ctx, s.operatorId);
    await securityLimit(db, `knowledge-space:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      if (b.version === 0) {
        const [created] = await orm.insert(spaces).values({ ...b, version: 1, token: randomUUID() }).onConflictDoNothing().returning();
        if (!created) throw new ApiError(409, '客户帮助页已存在，请刷新');
        return created;
      }
      const [updated] = await orm.update(spaces).set({ title: b.title, description: b.description, published: b.published, version: b.version + 1, updatedAt: toPgTimestamp(new Date()) })
        .where(and(eq(spaces.siteId, b.siteId), eq(spaces.version, b.version))).returning();
      if (!updated) throw new ApiError(409, '客户帮助页已更新，请刷新');
      return updated;
    });
    await audit(ctx, 'space.update', { siteId: s.id, published: b.published, version: item.version });
    return { item };
  });
  const listing = z.object({ siteId: queryId, beforeId: queryId.optional(), q: z.string().trim().max(100).default(''), kind: z.enum(documentKinds).optional() });
  const search = (term: string) => '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%';
  app.get(`${base}/documents`, async req => {
    const q = parse(listing, req.query); await site(req.ctx!, q.siteId);
    const rows = await db.orm.select({ id: documents.id, token: documents.token, version: documents.version, publishedRevision: documents.publishedRevision, publishedAt: documents.publishedAt, updatedAt: documents.updatedAt,
      title: sql<string>`${documents.draft}->>'title'`, kind: sql<string>`${documents.draft}->>'kind'`, category: sql<string>`${documents.draft}->>'category'` })
      .from(documents).where(and(eq(documents.siteId, q.siteId), q.beforeId ? sql`${documents.id}<${q.beforeId}` : undefined,
        q.kind ? sql`${documents.draft}->>'kind'=${q.kind}` : undefined,
        q.q ? sql`(${documents.draft}->>'title' ILIKE ${search(q.q)} OR ${documents.draft}->>'summary' ILIKE ${search(q.q)} OR ${documents.draft}->>'category' ILIKE ${search(q.q)})` : undefined)).orderBy(desc(documents.id)).limit(51);
    return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
  });
  app.post(`${base}/documents`, async (req, reply) => {
    const ctx = req.ctx!; requireWrite(ctx);
    const b = parse(z.object({ siteId: positive, content: documentContentSchema }).strict(), req.body); await site(ctx, b.siteId);
    await securityLimit(db, `knowledge-write:${ctx.operatorId}`, 120, 3600000);
    const item = await db.orm.transaction(async orm => {
      // Serialize the per-site document limit across independent API processes.
      await orm.select({ id: sites.id }).from(sites).where(eq(sites.id, b.siteId)).for('update');
      await site(ctx, b.siteId, orm);
      const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(documents).where(eq(documents.siteId, b.siteId));
      if (count!.n >= 500) throw new ApiError(409, '每站最多 500 篇内容，请更新现有内容');
      const [created] = await orm.insert(documents).values({ siteId: b.siteId, token: randomUUID(), draft: b.content }).returning();
      await orm.insert(versions).values({ documentId: created!.id, version: 1, action: 'created', content: b.content, actorId: ctx.operatorId });
      return created!;
    });
    await audit(ctx, 'document.create', { id: item.id, siteId: item.siteId }); return reply.code(201).send({ item });
  });
  app.get<{ Params: { id: string } }>(`${base}/documents/:id`, async req => ({ item: await document(req.ctx!, parse(queryId, req.params.id)) }));
  app.get<{ Params: { id: string } }>(`${base}/documents/:id/history`, async req => {
    const item = await document(req.ctx!, parse(queryId, req.params.id));
    const q = parse(z.object({ beforeVersion: queryId.optional() }), req.query);
    const rows = await db.orm.select({ version: versions.version, action: versions.action, content: versions.content, createdAt: versions.createdAt }).from(versions)
      .where(and(eq(versions.documentId, item.id), q.beforeVersion ? sql`${versions.version}<${q.beforeVersion}` : undefined)).orderBy(desc(versions.version)).limit(21);
    return { items: rows.slice(0, 20), hasMore: rows.length > 20 };
  });
  app.post<{ Params: { id: string } }>(`${base}/documents/:id`, async req => {
    const ctx = req.ctx!; requireWrite(ctx);
    const b = parse(z.discriminatedUnion('action', [
      z.object({ action: z.literal('save'), version: positive, content: documentContentSchema }).strict(),
      z.object({ action: z.literal('publish'), version: positive }).strict(),
      z.object({ action: z.literal('unpublish'), version: positive }).strict(),
      z.object({ action: z.literal('restore'), version: positive, sourceVersion: positive }).strict(),
    ]), req.body);
    const id = parse(queryId, req.params.id); await document(ctx, id);
    await securityLimit(db, `knowledge-write:${ctx.operatorId}`, 120, 3600000);
    const item = await db.orm.transaction(async orm => {
      const [current] = await orm.select().from(documents).where(eq(documents.id, id)).for('update');
      if (!current) throw new ApiError(404, '内容不存在');
      const s = await site(ctx, current.siteId, orm);
      if (current.version !== b.version) throw new ApiError(409, '内容已更新，请刷新后重新预览');
      if (b.action === 'publish' || b.action === 'unpublish') requirePublisher(ctx, s.operatorId);
      let draft = b.action === 'save' ? b.content : current.draft;
      if (b.action === 'restore') {
        const [source] = await orm.select().from(versions).where(and(eq(versions.documentId, id), eq(versions.version, b.sourceVersion)));
        if (!source) throw new ApiError(404, '历史版本不存在');
        draft = parse(documentContentSchema, source.content);
      }
      const next = current.version + 1, now = toPgTimestamp(new Date());
      const publication = b.action === 'publish' ? { published: draft, publishedRevision: next, publishedAt: now }
        : b.action === 'unpublish' ? { published: null, publishedRevision: null, publishedAt: null } : {};
      const [updated] = await orm.update(documents).set({ draft, version: next, updatedAt: now, ...publication }).where(eq(documents.id, id)).returning();
      await orm.insert(versions).values({ documentId: id, version: next, action: b.action, content: draft, actorId: ctx.operatorId });
      return updated!;
    });
    await audit(ctx, `document.${b.action}`, { id, siteId: item.siteId, version: item.version }); return { item };
  });
  async function publicSpace(token: string) {
    if (!z.string().uuid().safeParse(token).success) throw new ApiError(404, 'Not found');
    const [row] = await db.orm.select({ space: spaces }).from(spaces).innerJoin(sites, eq(sites.id, spaces.siteId)).innerJoin(operators, eq(operators.id, sites.operatorId))
      .where(and(eq(spaces.token, token), eq(spaces.published, true), ne(sites.status, 'destroyed'), eq(operators.status, 'active')));
    if (!row) throw new ApiError(404, 'Not found'); return row.space;
  }
  app.get<{ Params: { token: string } }>('/public/help/:token', async (req, reply) => {
    publicHeaders(reply); const space = await publicSpace(req.params.token);
    const q = parse(z.object({ q: z.string().trim().max(100).default(''), beforeId: queryId.optional() }), req.query);
    const rows = await db.orm.select({ id: documents.id, token: documents.token, content: documents.published }).from(documents)
      .where(and(eq(documents.siteId, space.siteId), isNotNull(documents.published), q.beforeId ? sql`${documents.id}<${q.beforeId}` : undefined,
        q.q ? sql`(${documents.published}->>'title' ILIKE ${search(q.q)} OR ${documents.published}->>'summary' ILIKE ${search(q.q)} OR ${documents.published}->>'category' ILIKE ${search(q.q)})` : undefined))
      .orderBy(desc(documents.id)).limit(41);
    const path = `/public/help/${space.token}`;
    const next = new URLSearchParams({ q: q.q, beforeId: String(rows[39]?.id ?? '') });
    return reply.type('text/html; charset=utf-8').send(page(space.title, `<h1>${esc(space.title)}</h1><p>${esc(space.description)}</p><form method="get" action="${path}"><input aria-label="搜索已发布内容" name="q" maxlength="100" value="${esc(q.q)}"><button type="submit">搜索</button></form>${rows.length ? rows.slice(0, 40).map(r => `<article><small>${esc(label(r.content!.kind))} · ${esc(r.content!.category)}</small><h2><a href="${path}/${r.token}">${esc(r.content!.title)}</a></h2><p>${esc(r.content!.summary)}</p></article>`).join('') : '<p>暂无匹配的已发布内容。</p>'}${rows.length > 40 ? `<a href="${path}?${esc(next.toString())}">下一页</a>` : ''}`));
  });
  app.get<{ Params: { token: string; documentToken: string } }>('/public/help/:token/:documentToken', async (req, reply) => {
    publicHeaders(reply); const space = await publicSpace(req.params.token);
    if (!z.string().uuid().safeParse(req.params.documentToken).success) throw new ApiError(404, 'Not found');
    const [row] = await db.orm.select({ content: documents.published, publishedAt: documents.publishedAt }).from(documents)
      .where(and(eq(documents.siteId, space.siteId), eq(documents.token, req.params.documentToken), isNotNull(documents.published)));
    if (!row) throw new ApiError(404, 'Not found');
    return reply.type('text/html; charset=utf-8').send(page(row.content!.title, `<a href="/public/help/${space.token}">← ${esc(space.title)}</a>${renderContent(row.content!)}<p><small>发布时间：${esc(row.publishedAt!)} UTC · 站长维护的服务说明</small></p>`));
  });
}
