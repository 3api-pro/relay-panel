import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Orm } from '../db/client.js';
import { financeScopes, financeSubmissions, observationRuns, observedRequests, serviceAccess, sites, operators, servicePartners } from '../db/schema.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { writeAudit } from '../audit.js';
import { csvCell } from '../billing/aftercare.js';
import { accessContext, ownedSite } from './collaboration.js';

type Scope = typeof financeScopes.$inferSelect;
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const scopeInput = z.object({ label: z.string().trim().min(3).max(120), fromDay: day, toDay: day,
  channelId: z.string().trim().min(1).max(256).nullable(), model: z.string().trim().min(1).max(256).nullable(),
  costs: z.boolean(), details: z.boolean(), export: z.boolean(), review: z.boolean(), enabled: z.boolean(), version: z.number().int().min(0),
}).strict().refine(v => v.toDay >= v.fromDay && (Date.parse(v.toDay) - Date.parse(v.fromDay)) / 86400000 < 92, '日期范围最多 92 天');
function parse<T extends z.ZodTypeAny>(s: T, value: unknown): z.output<T> { const r = s.safeParse(value); if (!r.success) throw new ApiError(400, '请检查授权范围、日期（最多 92 天）和必填说明'); return r.data; }
function scopeDto(s: Scope) { return { accessId: s.accessId, label: s.label, fromDay: s.fromDay, toDay: s.toDay, channelId: s.channelId, model: s.model, costs: s.costs, details: s.details, export: s.export, review: s.review, enabled: s.enabled, version: s.version }; }
function submissionDto(s: typeof financeSubmissions.$inferSelect) { return { id: s.id, scopeVersion: s.scopeVersion, report: s.report, note: s.note, status: s.status, decision: s.decision, decidedAt: s.decidedAt, version: s.version, createdAt: s.createdAt }; }
export interface SharedFinanceReport {
  scope: ReturnType<typeof scopeDto>; currency: 'USD'; timezone: 'Asia/Shanghai'; generatedAt: string;
  days: { day: string; scanStatus: string; sourceScope: string | null; collectedAt: string | null; records: number; pricedRecords: number; chargeUsd: string | null; costRecords?: number; supplierCostUsd?: string | null }[];
  records: number; pricedRecords: number; chargeUsd: string | null; costRecords?: number; supplierCostUsd?: string | null;
}
async function scanRows(orm: Orm, scope: Scope, siteId: number) {
  return orm.select().from(observationRuns).where(and(eq(observationRuns.siteId, siteId), sql`${observationRuns.day}>=${scope.fromDay}`, sql`${observationRuns.day}<=${scope.toDay}`)).orderBy(asc(observationRuns.id)).for('share');
}
function conditions(scope: Scope, runs: { id: number }[]) {
  return and(inArray(observationRuns.id, runs.map(r => r.id)), eq(observedRequests.generation, observationRuns.generation),
    sql`${observedRequests.evidence}->>'outcome'='consumption'`, sql`${observedRequests.evidence}->>'currency'='USD'`,
    scope.channelId ? sql`${observedRequests.evidence}->>'channelId'=${scope.channelId}` : undefined, scope.model ? sql`${observedRequests.evidence}->>'model'=${scope.model}` : undefined);
}
function sumDecimal(values: (string | null)[]) {
  const present = values.filter((s): s is string => s !== null); if (!present.length) return null;
  const total = present.reduce((n, v) => { const neg = v.startsWith('-'), [a, b = ''] = v.replace(/^-/, '').split('.'); return n + (neg ? -1n : 1n) * (BigInt(a!) * 1000000n + BigInt(b.padEnd(6, '0'))); }, 0n);
  const positive = total < 0 ? -total : total; return `${total < 0 ? '-' : ''}${positive / 1000000n}.${(positive % 1000000n).toString().padStart(6, '0')}`;
}
async function report(orm: Orm, scope: Scope, siteId: number): Promise<SharedFinanceReport> {
  const runs = await scanRows(orm, scope, siteId), charge = sql`(${observedRequests.evidence}->>'charge')::numeric`, cost = sql`(${observedRequests.evidence}->>'supplierCost')::numeric`;
  const sums = runs.length ? await orm.select({ day: observationRuns.day, records: sql<number>`count(*)::int`, priced: sql<number>`count(${charge})::int`, amount: sql<string | null>`round(sum(${charge}),6)::text`,
    ...(scope.costs ? { costRecords: sql<number>`count(${cost})::int`, costAmount: sql<string | null>`round(sum(${cost}),6)::text` } : {}),
  }).from(observedRequests).innerJoin(observationRuns, eq(observationRuns.id, observedRequests.runId)).where(conditions(scope, runs)).groupBy(observationRuns.day) : [];
  const days: SharedFinanceReport['days'] = [];
  for (let t = Date.parse(scope.fromDay); t <= Date.parse(scope.toDay); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10), r = runs.find(r => r.day === day), s = sums.find(s => s.day === day);
    days.push({ day, scanStatus: r?.status ?? 'missing', sourceScope: r?.sourceScope ?? null, collectedAt: r?.updatedAt ?? null, records: s?.records ?? 0, pricedRecords: s?.priced ?? 0, chargeUsd: s?.amount ?? null,
      ...(scope.costs ? { costRecords: s?.costRecords ?? 0, supplierCostUsd: s?.costAmount ?? null } : {}) });
  }
  return { scope: scopeDto(scope), currency: 'USD', timezone: 'Asia/Shanghai', generatedAt: new Date().toISOString(), days,
    records: days.reduce((n, d) => n + d.records, 0), pricedRecords: days.reduce((n, d) => n + d.pricedRecords, 0), chargeUsd: sumDecimal(days.map(d => d.chargeUsd)),
    ...(scope.costs ? { costRecords: days.reduce((n, d) => n + (d.costRecords ?? 0), 0), supplierCostUsd: sumDecimal(days.map(d => d.supplierCostUsd ?? null)) } : {}) };
}

export function registerFinanceAccessRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ownerBase = '/api/services/finance-access', memberBase = '/api/collaboration/finance';
  const audit = (orm: Orm, ctx: SessionCtx, action: string, payload: Record<string, unknown>) => writeAudit({ ...db, orm }, { actor: ctx.email, action: `finance-access.${action}`, payload, ok: true });
  async function context(orm: Orm, ctx: SessionCtx, accessId: number, staff: boolean, inactive = false) {
    // Lock in the same order as collaboration revocation, including reads and exports.
    const grant = await accessContext(orm, ctx, accessId, staff, true, inactive && staff);
    if (grant.access.role !== 'finance') throw new ApiError(404, '财务授权不存在');
    if (!staff) { const [op] = await orm.select({ verified: operators.emailVerifiedAt }).from(operators).where(eq(operators.id, ctx.operatorId)); if (!op?.verified) throw new ApiError(403, '请验证受邀邮箱'); }
    const [scope] = await orm.select().from(financeScopes).where(eq(financeScopes.accessId, accessId));
    if (!scope || (!scope.enabled && !staff)) throw new ApiError(404, '财务授权未启用');
    return { ...grant, scope };
  }
  app.get(ownerBase, async req => {
    const q = parse(z.object({ siteId: id }).strict(), req.query); await ownedSite(db.orm, req.ctx!, q.siteId);
    const rows = await db.orm.select({ access: serviceAccess, scope: financeScopes }).from(serviceAccess).leftJoin(financeScopes, eq(financeScopes.accessId, serviceAccess.id))
      .where(and(eq(serviceAccess.siteId, q.siteId), eq(serviceAccess.role, 'finance'))).orderBy(desc(serviceAccess.id)).limit(501);
    return { items: rows.slice(0, 500).map(r => ({ accessId: r.access.id, email: r.access.email, acceptedAt: r.access.acceptedAt, expiresAt: r.access.expiresAt, revokedAt: r.access.revokedAt, scope: r.scope ? scopeDto(r.scope) : null })), limited: rows.length > 500 };
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id`, async req => {
    const ctx = req.ctx!, accessId = parse(id, req.params.id), b = parse(scopeInput, req.body);
    await securityLimit(db, `finance-scope:${ctx.operatorId}`, 60, 3600000);
    return db.orm.transaction(async orm => {
      const grant = await accessContext(orm, ctx, accessId, true, true); if (grant.access.role !== 'finance') throw new ApiError(400, '仅财务身份可配置财务范围');
      const [prior] = await orm.select().from(financeScopes).where(eq(financeScopes.accessId, accessId));
      if ((prior?.version ?? 0) !== b.version) throw new ApiError(409, '授权已更新，请刷新');
      const values = { ...b, accessId, version: b.version + 1, updatedAt: toPgTimestamp(new Date()) };
      const [scope] = prior ? await orm.update(financeScopes).set(values).where(eq(financeScopes.accessId, accessId)).returning() : await orm.insert(financeScopes).values(values).returning();
      await audit(orm, ctx, 'configure', values); return { scope: scopeDto(scope!) };
    });
  });
  app.get(memberBase, async req => {
    const ctx = req.ctx!, q = parse(z.object({ beforeId: id.optional() }).strict(), req.query); if (ctx.role !== 'operator') return { items: [], hasMore: false };
    const [op] = await db.orm.select({ verified: operators.emailVerifiedAt }).from(operators).where(eq(operators.id, ctx.operatorId)); if (!op?.verified) return { items: [], hasMore: false };
    const rows = await db.orm.select({ scope: financeScopes, expiresAt: serviceAccess.expiresAt }).from(financeScopes).innerJoin(serviceAccess, eq(serviceAccess.id, financeScopes.accessId))
      .innerJoin(sites, eq(sites.id, serviceAccess.siteId)).innerJoin(operators, eq(operators.id, serviceAccess.ownerId)).leftJoin(servicePartners, eq(servicePartners.id, serviceAccess.partnerId))
      .where(and(eq(serviceAccess.role, 'finance'), eq(serviceAccess.operatorId, ctx.operatorId), eq(serviceAccess.email, normalizeEmail(ctx.email)), isNotNull(serviceAccess.acceptedAt), isNull(serviceAccess.revokedAt), gt(serviceAccess.expiresAt, toPgTimestamp(new Date())), eq(financeScopes.enabled, true),
        eq(sites.operatorId, serviceAccess.ownerId), sql`${sites.status}<>'destroyed'`, eq(operators.status, 'active'), sql`(${serviceAccess.partnerId} IS NULL OR (${servicePartners.status}='active' AND ${servicePartners.siteId}=${sites.id}))`, q.beforeId ? sql`${financeScopes.accessId}<${q.beforeId}` : undefined)).orderBy(desc(financeScopes.accessId)).limit(51);
    return { items: rows.slice(0, 50).map(r => ({ ...scopeDto(r.scope), expiresAt: r.expiresAt })), hasMore: rows.length > 50 };
  });
  for (const staff of [true, false]) {
    const base = staff ? ownerBase : memberBase;
    app.get<{ Params: { id: string } }>(`${base}/:id/report`, async req => {
      parse(z.object({}).strict(), req.query);
      return db.orm.transaction(async orm => { const { scope, access } = await context(orm, req.ctx!, parse(id, req.params.id), staff); return { report: await report(orm, scope, access.siteId) }; });
    });
    app.get<{ Params: { id: string } }>(`${base}/:id/records`, async req => {
      const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query);
      return db.orm.transaction(async orm => {
        const { scope, access } = await context(orm, req.ctx!, parse(id, req.params.id), staff);
        if (!scope.details) throw new ApiError(403, '未授权查看消费明细');
        const runs = await scanRows(orm, scope, access.siteId);
        const rows = runs.length ? await orm.select({ id: observedRequests.id, day: observationRuns.day, evidence: observedRequests.evidence }).from(observedRequests).innerJoin(observationRuns, eq(observationRuns.id, observedRequests.runId))
          .where(and(conditions(scope, runs), q.beforeId ? sql`${observedRequests.id}<${q.beforeId}` : undefined)).orderBy(desc(observedRequests.id)).limit(101) : [];
        return { items: rows.slice(0, 100).map(r => ({ id: r.id, day: r.day, model: r.evidence.model, channelId: r.evidence.channelId, charge: r.evidence.charge, ...(scope.costs ? { supplierCost: r.evidence.supplierCost } : {}) })), hasMore: rows.length > 100 };
      });
    });
    app.get<{ Params: { id: string } }>(`${base}/:id/report.csv`, async (req, reply) => {
      parse(z.object({}).strict(), req.query);
      const r = await db.orm.transaction(async orm => {
        const { scope, access } = await context(orm, req.ctx!, parse(id, req.params.id), staff); if (!scope.export) throw new ApiError(403, '未授权导出');
        const r = await report(orm, scope, access.siteId); await audit(orm, req.ctx!, 'export', { accessId: scope.accessId, version: scope.version }); return r;
      });
      const rows = [['Scope', 'Version', 'Channel', 'Model', 'Day (Asia/Shanghai)', 'Scan', 'Source coverage', 'Collected at (UTC)', 'Records', 'Priced records', 'Charge USD', ...(r.scope.costs ? ['Cost records', 'Supplier cost USD'] : [])],
        ...r.days.map(d => [r.scope.label, r.scope.version, r.scope.channelId, r.scope.model, d.day, d.scanStatus, d.sourceScope, d.collectedAt, d.records, d.pricedRecords, d.chargeUsd, ...(r.scope.costs ? [d.costRecords, d.supplierCostUsd] : [])])];
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="shared-finance.csv"').header('Cache-Control', 'no-store').send('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
    });
    app.get<{ Params: { id: string } }>(`${base}/:id/reviews`, async req => {
      const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query);
      return db.orm.transaction(async orm => {
        const { scope } = await context(orm, req.ctx!, parse(id, req.params.id), staff, staff);
        if (!staff && !scope.review) throw new ApiError(403, '未授权复核');
        const rows = await orm.select().from(financeSubmissions).where(and(eq(financeSubmissions.accessId, scope.accessId), staff ? undefined : eq(financeSubmissions.scopeVersion, scope.version), q.beforeId ? sql`${financeSubmissions.id}<${q.beforeId}` : undefined)).orderBy(desc(financeSubmissions.id)).limit(51);
        return { items: rows.slice(0, 50).map(submissionDto), hasMore: rows.length > 50 };
      });
    });
  }
  app.post<{ Params: { id: string } }>(`${memberBase}/:id/reviews`, async (req, reply) => {
    const b = parse(z.object({ version: id, note: z.string().trim().min(5).max(2000) }).strict(), req.body), ctx = req.ctx!;
    await securityLimit(db, `finance-submit:${ctx.operatorId}`, 30, 3600000);
    const item = await db.orm.transaction(async orm => {
      const { scope, access } = await context(orm, ctx, parse(id, req.params.id), false);
      if (!scope.review) throw new ApiError(403, '未授权复核'); if (scope.version !== b.version) throw new ApiError(409, '授权已更新，请刷新');
      const [created] = await orm.insert(financeSubmissions).values({ accessId: scope.accessId, scopeVersion: scope.version, note: b.note, report: await report(orm, scope, access.siteId) }).onConflictDoNothing().returning();
      if (!created) throw new ApiError(409, '已有待站长处理的复核，请等待处理后再提交');
      await audit(orm, ctx, 'submit', { id: created.id, accessId: scope.accessId, scopeVersion: scope.version }); return submissionDto(created);
    }); return reply.code(201).send({ item });
  });
  app.post<{ Params: { id: string; review: string } }>(`${ownerBase}/:id/reviews/:review`, async req => {
    const b = parse(z.object({ version: id, status: z.enum(['accepted', 'returned']), decision: z.string().trim().min(5).max(2000) }).strict(), req.body), ctx = req.ctx!;
    return db.orm.transaction(async orm => {
      const { scope } = await context(orm, ctx, parse(id, req.params.id), true, true), reviewId = parse(id, req.params.review);
      const [item] = await orm.update(financeSubmissions).set({ status: b.status, decision: b.decision, version: b.version + 1, decidedAt: toPgTimestamp(new Date()), decidedBy: ctx.operatorId })
        .where(and(eq(financeSubmissions.id, reviewId), eq(financeSubmissions.accessId, scope.accessId), eq(financeSubmissions.version, b.version), eq(financeSubmissions.status, 'submitted'))).returning();
      if (!item) throw new ApiError(409, '复核已处理或不存在');
      await audit(orm, ctx, 'decision', { accessId: scope.accessId, id: item.id, status: b.status }); return { item: submissionDto(item) };
    });
  });
}
