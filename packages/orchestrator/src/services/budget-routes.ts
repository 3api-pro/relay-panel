import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { budgetPolicies, budgetEvents, sites } from '../db/schema.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { writeAudit } from '../audit.js';
import { csvCell } from '../billing/aftercare.js';
import type { SitesServiceDeps } from '../sites/service.js';
import { Budgets } from './budgets.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), queryId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const policyInput = z.object({ name: z.string().trim().min(3).max(120), period: z.enum(['day', 'week', 'month']), basis: z.enum(['charge', 'supplierCost']),
  amountUsd: z.number().finite().min(.000001).max(1e9).refine(v => Number(v.toFixed(6)) === v, '最多六位小数'), warningPercent: z.number().int().min(1).max(99),
  channelId: z.string().trim().min(1).max(256).nullable(), model: z.string().trim().min(1).max(256).nullable(), enabled: z.boolean(), notify: z.boolean(),
}).strict();
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => { const r = schema.safeParse(value); if (!r.success) throw new ApiError(400, '请检查预算名称、金额、周期、范围和提醒阈值'); return r.data; };
export function registerBudgetRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const { db } = deps, service = new Budgets(db, deps.config), base = '/api/services/budgets';
  const audit = (ctx: SessionCtx, action: string, payload: Record<string, unknown>) => writeAudit(db, { actor: ctx.email, action: `budget.${action}`, payload, ok: true });
  app.get(base, async req => {
    const q = parse(z.object({ siteId: queryId }), req.query), s = await service.site(req.ctx!, q.siteId);
    const items = await db.orm.select().from(budgetPolicies).where(eq(budgetPolicies.siteId, s.id)).orderBy(desc(budgetPolicies.id)).limit(50);
    return { items, canManage: req.ctx!.role === 'root' || (req.ctx!.role === 'operator' && req.ctx!.operatorId === s.operatorId && !req.ctx!.teamRole),
      enforcement: 'observation_only', intervalMs: deps.config.observationIntervalMs, policyLimit: 50 };
  });
  app.post(base, async (req, reply) => {
    const ctx = req.ctx!, b = parse(policyInput.extend({ siteId: positive }).strict(), req.body);
    const s = await service.site(ctx, b.siteId); service.requireOwner(ctx, s.operatorId); await securityLimit(db, `budget-edit:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      await orm.select({ id: sites.id }).from(sites).where(eq(sites.id, s.id)).for('update');
      const current = await service.site(ctx, s.id, orm); service.requireOwner(ctx, current.operatorId);
      const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(budgetPolicies).where(eq(budgetPolicies.siteId, s.id));
      if (count!.n >= 50) throw new ApiError(409, '每站最多 50 条预算策略，请修改已有策略');
      const [created] = await orm.insert(budgetPolicies).values({ ...b, amountUsd: b.amountUsd.toFixed(6) }).returning(); return created!;
    });
    await audit(ctx, 'create', { ...b, id: item.id }); return reply.code(201).send({ item });
  });
  app.post<{ Params: { id: string } }>(`${base}/:id`, async req => {
    const ctx = req.ctx!, id = parse(queryId, req.params.id), b = parse(policyInput.extend({ version: positive }).strict(), req.body);
    const policy = await service.policy(ctx, id), s = await service.site(ctx, policy.siteId); service.requireOwner(ctx, s.operatorId);
    await securityLimit(db, `budget-edit:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      const [current] = await orm.select().from(budgetPolicies).where(eq(budgetPolicies.id, id)).for('update');
      if (!current || current.version !== b.version) throw new ApiError(409, '预算策略已更新，请刷新');
      const currentSite = await service.site(ctx, current.siteId, orm); service.requireOwner(ctx, currentSite.operatorId);
      const [updated] = await orm.update(budgetPolicies).set({ ...b, amountUsd: b.amountUsd.toFixed(6), version: b.version + 1, updatedAt: toPgTimestamp(new Date()) }).where(eq(budgetPolicies.id, id)).returning(); return updated!;
    });
    await audit(ctx, 'update', { ...b, id, siteId: item.siteId }); return { item };
  });
  app.get<{ Params: { id: string } }>(`${base}/:id/report`, async req => ({ report: await service.readReport(req.ctx!, parse(queryId, req.params.id)) }));
  app.post<{ Params: { id: string } }>(`${base}/:id/evaluate`, async req => {
    const ctx = req.ctx!, id = parse(queryId, req.params.id), p = await service.policy(ctx, id), s = await service.site(ctx, p.siteId); service.requireOwner(ctx, s.operatorId);
    parse(z.object({}).strict(), req.body ?? {}); await securityLimit(db, `budget-evaluate:${id}`, 10, 60000);
    const result = await service.evaluate(ctx, id); await audit(ctx, 'evaluate', { id, siteId: p.siteId, eventCreated: result.eventCreated }); return result;
  });
  app.get<{ Params: { id: string } }>(`${base}/:id/report.csv`, async (req, reply) => {
    const report = await service.readReport(req.ctx!, parse(queryId, req.params.id));
    const rows = [['Budget', 'Policy version', 'Amount basis', 'Budget USD', 'Channel filter', 'Model filter', 'Day (Asia/Shanghai)', 'Scan state', 'Consumption records', 'Records with amount', 'Observed USD', 'Source coverage', 'Enforcement'],
      ...report.days.map(d => [report.policy.name, report.policy.version, report.policy.basis, report.policy.amountUsd, report.policy.channelId, report.policy.model, d.day, d.scanStatus, d.records, d.pricedRecords, d.observedUsd, d.sourceScope, report.enforcement])];
    await audit(req.ctx!, 'export', { id: report.policy.id, periodStart: report.window.from });
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="observed-budget.csv"').header('Cache-Control', 'no-store')
      .send('\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
  });
  app.get<{ Params: { id: string } }>(`${base}/:id/events`, async req => {
    const policy = await service.policy(req.ctx!, parse(queryId, req.params.id)), q = parse(z.object({ beforeId: queryId.optional() }), req.query);
    const rows = await db.orm.select().from(budgetEvents).where(and(eq(budgetEvents.policyId, policy.id), q.beforeId ? sql`${budgetEvents.id}<${q.beforeId}` : undefined)).orderBy(desc(budgetEvents.id)).limit(51);
    return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
  });
  app.post<{ Params: { id: string; event: string } }>(`${base}/:id/events/:event/acknowledge`, async req => {
    const ctx = req.ctx!, p = await service.policy(ctx, parse(queryId, req.params.id)), eventId = parse(queryId, req.params.event), s = await service.site(ctx, p.siteId); service.requireOwner(ctx, s.operatorId);
    const b = parse(z.object({ note: z.string().trim().min(5).max(1000) }).strict(), req.body);
    const [item] = await db.orm.update(budgetEvents).set({ acknowledgedAt: toPgTimestamp(new Date()), acknowledgedBy: ctx.operatorId, acknowledgement: b.note })
      .where(and(eq(budgetEvents.id, eventId), eq(budgetEvents.policyId, p.id), isNull(budgetEvents.acknowledgedAt))).returning();
    if (!item) throw new ApiError(409, '提醒已确认或不存在'); await audit(ctx, 'acknowledge', { id: p.id, eventId, note: b.note }); return { item };
  });
}
