import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { UsageRecord } from '@relay-panel/adapter-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { historicalRates, reconciliationRecords, reconciliationRuns, sites } from '../db/schema.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { toPgTimestamp, fromPgTimestamp } from '../auth/sessions.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { writeAudit } from '../audit.js';
import { csvCell } from '../billing/aftercare.js';

type Rate = typeof historicalRates.$inferSelect;
export function estimateCharge(record: UsageRecord, rates: Rate[]): { expected: number | null; gap: number | null; basis: string } {
  if (record.billingType !== 'balance' || record.totalCost === null || record.actualCost === null) return { expected: null, gap: null, basis: 'insufficient_evidence' };
  const candidates = rates.filter(r => !r.voidedAt && r.userId === record.userId && r.model === record.model &&
    Date.parse(record.createdAt) >= fromPgTimestamp(r.fromAt).getTime() && Date.parse(record.createdAt) < fromPgTimestamp(r.toAt).getTime());
  if (candidates.length > 1) return { expected: null, gap: null, basis: 'conflicting_historical_rates' };
  const multiplier = candidates[0]?.multiplier ?? record.rateMultiplier;
  if (multiplier === null) return { expected: null, gap: null, basis: 'missing_rate' };
  const expected = record.totalCost * multiplier;
  return { expected, gap: Math.max(0, expected - record.actualCost), basis: candidates[0] ? `historical_rate:${candidates[0].id}` : 'request_rate_snapshot' };
}
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const date = new Date(s + 'T00:00:00Z'); return Number.isFinite(+date) && date.toISOString().slice(0, 10) === s;
});

export function registerReconciliationRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const { db } = deps;
  const service = new SitesService(deps), base = '/api/admin/reconciliation';
  async function requireRun(id: string) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new ApiError(400, '任务编号无效');
    const [row] = await db.orm.select({ run: reconciliationRuns, slug: sites.slug, label: sites.label }).from(reconciliationRuns)
      .innerJoin(sites, eq(sites.id, reconciliationRuns.siteId)).where(eq(reconciliationRuns.id, Number(id)));
    if (!row) throw new ApiError(404, '对账任务不存在');
    return row;
  }
  app.get(base, async req => { requireRoot(req.ctx!); return { runs: await db.orm.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.id)).limit(100) }; });
  app.post(base, async (req, reply) => {
    requireRoot(req.ctx!);
    const body = z.object({ siteId: z.number().int().positive(), from: day, to: day, supplier: z.string().trim().min(1).max(100),
      invoiceRef: z.string().trim().min(1).max(100), invoiceAmount: z.number().nonnegative().max(1e10), accountId: z.string().regex(/^\d+$/).optional(),
      note: z.string().trim().min(5).max(2000), currency: z.literal('USD'),
    }).refine(x => x.from <= x.to && Date.parse(x.to) - Date.parse(x.from) < 31 * 86_400_000 && x.to < new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '请填写账单依据；仅接受 USD、已结束的北京时间日期，最多 31 天');
    const [site] = await db.orm.select().from(sites).where(eq(sites.id, body.data.siteId));
    if (!site) throw new ApiError(404, '站点不存在');
    if (site.engine !== 'sub2api') throw new ApiError(400, '该引擎尚不提供可核对的请求级成本记录，请使用供应商原始账单人工核对');
    const b = body.data;
    const [run] = await db.orm.insert(reconciliationRuns).values({ siteId: b.siteId, fromDate: b.from, toDate: b.to,
      supplier: b.supplier, invoiceRef: b.invoiceRef, invoiceAmount: b.invoiceAmount, accountId: b.accountId ?? null, note: b.note })
      .onConflictDoNothing().returning();
    if (!run) throw new ApiError(409, '该站点的供应商账单已创建对账任务');
    await writeAudit(db, { actor: req.ctx!.email, action: 'finance.reconciliation.create', payload: { runId: run.id }, ok: true });
    return reply.code(201).send({ run });
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/scan`, async req => {
    requireRoot(req.ctx!);
    const { run, slug } = await requireRun(req.params.id);
    if (run.status === 'complete') return { run };
    if (run.status !== 'scanning') throw new ApiError(409, '扫描不完整，请重置扫描后重试');
    if (run.nextPage > 1000) throw new ApiError(413, '记录过多，请缩短对账日期');
    const { page } = await service.financeUsageRecords(req.ctx!, slug, { from: run.fromDate, to: run.toDate, page: run.nextPage });
    if (page.total > 100_000) throw new ApiError(413, '每个对账区间最多 100000 条记录，请缩短日期');
    if (run.expectedRows !== null && page.total !== run.expectedRows) throw new ApiError(409, '扫描期间源记录总数变化，请核实日志完整性后重新对账');
    const updated = await db.orm.transaction(async orm => {
      const [fresh] = await orm.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, run.id)).for('update');
      if (!fresh || fresh.version !== run.version) throw new ApiError(409, '扫描已推进，请刷新');
      for (const evidence of page.items) await orm.insert(reconciliationRecords).values({ runId: run.id, sourceId: evidence.id, evidence }).onConflictDoNothing();
      const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(reconciliationRecords).where(eq(reconciliationRecords.runId, run.id));
      const end = page.page >= page.pages;
      const [next] = await orm.update(reconciliationRuns).set({ nextPage: page.page + 1, expectedRows: page.total, version: run.version + 1,
        status: end && count!.n === page.total ? 'complete' : end ? 'incomplete' : 'scanning',
      }).where(eq(reconciliationRuns.id, run.id)).returning();
      return next;
    });
    return { run: updated };
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/restart`, async req => {
    requireRoot(req.ctx!);
    const body = z.object({ version: z.number().int().positive(), note: z.string().trim().min(5).max(2000) }).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '请提供版本及重扫原因');
    const { run } = await requireRun(req.params.id);
    return db.orm.transaction(async orm => {
      const [fresh] = await orm.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, run.id)).for('update');
      if (!fresh || fresh.version !== body.data.version || fresh.status === 'complete') throw new ApiError(409, '任务已完成或已改变，请刷新');
      await orm.delete(reconciliationRecords).where(eq(reconciliationRecords.runId, run.id));
      const [next] = await orm.update(reconciliationRuns).set({ nextPage: 1, expectedRows: null, status: 'scanning', version: fresh.version + 1 }).where(eq(reconciliationRuns.id, run.id)).returning();
      await writeAudit({ ...db, orm }, { actor: req.ctx!.email, action: 'finance.reconciliation.restart', payload: { runId: run.id, note: body.data.note }, ok: true });
      return { run: next };
    });
  });
  async function result(id: string) {
    const { run, label } = await requireRun(id);
    const rows = await db.orm.select().from(reconciliationRecords).where(eq(reconciliationRecords.runId, run.id));
    const rates = await db.orm.select().from(historicalRates).where(eq(historicalRates.siteId, run.siteId));
    const selected = rows.filter(r => run.accountId === null || r.evidence.accountId === run.accountId);
    const estimates = selected.map(r => ({ ...r.evidence, estimate: estimateCharge(r.evidence, rates) }));
    const knownCosts = estimates.filter(r => r.accountCost !== null);
    const observedCost = knownCosts.reduce((sum, r) => sum + r.accountCost!, 0);
    const costComplete = run.status === 'complete' && knownCosts.length === selected.length;
    return { run, label, estimates, summary: { currency: 'USD', timezone: 'Asia/Shanghai', scannedRows: rows.length,
      selectedRows: selected.length, knownCostRows: knownCosts.length, observedCost, costComplete,
      invoiceDifference: costComplete ? run.invoiceAmount - observedCost : null,
      estimatedShortfall: estimates.reduce((sum, r) => sum + (r.estimate.gap ?? 0), 0),
      estimableRows: estimates.filter(r => r.estimate.gap !== null).length, settlementProof: 'unavailable',
      sourceScope: 'engine-request-logs',
    } };
  }
  app.get<{ Params: { id: string } }>(`${base}/:id`, async req => { requireRoot(req.ctx!); const r = await result(req.params.id); return { run: r.run, label: r.label, summary: r.summary }; });
  app.get<{ Params: { id: string } }>(`${base}/:id/export.csv`, async (req, reply) => {
    requireRoot(req.ctx!); const r = await result(req.params.id);
    const data = [['Request record ID', 'Request ID', 'UTC time', 'Model', 'User', 'Account', 'Recorded charge USD', 'Observed supplier cost USD', 'Estimated charge USD', 'Estimated gap USD', 'Rate basis', 'Wallet settlement proof'],
      ...r.estimates.map(e => [e.id, e.requestId, e.createdAt, e.model, e.userId, e.accountId, e.actualCost, e.accountCost, e.estimate.expected, e.estimate.gap, e.estimate.basis, e.settlementProof])];
    await writeAudit(db, { actor: req.ctx!.email, action: 'finance.reconciliation.export', payload: { runId: r.run.id, rows: r.estimates.length }, ok: true });
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="reconciliation-${r.run.id}.csv"`)
      .send('\ufeff' + data.map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
  app.post(`${base}/rates`, async req => {
    requireRoot(req.ctx!);
    const body = z.object({ siteId: z.number().int().positive(), userId: z.string().regex(/^\d+$/), model: z.string().min(1).max(200),
      from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), multiplier: z.number().nonnegative().max(10000), note: z.string().trim().min(5).max(2000),
    }).refine(x => Date.parse(x.from) < Date.parse(x.to)).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '请填写历史费率、准确生效时间和依据');
    const b = body.data;
    const [site] = await db.orm.select().from(sites).where(eq(sites.id, b.siteId));
    if (!site) throw new ApiError(404, '站点不存在');
    return db.orm.transaction(async orm => {
      await orm.select().from(sites).where(eq(sites.id, b.siteId)).for('update');
      const from = toPgTimestamp(new Date(b.from)), to = toPgTimestamp(new Date(b.to));
      const overlap = await orm.select({ id: historicalRates.id }).from(historicalRates).where(and(eq(historicalRates.siteId, b.siteId),
        eq(historicalRates.userId, b.userId), eq(historicalRates.model, b.model), isNull(historicalRates.voidedAt), lt(historicalRates.fromAt, to), gt(historicalRates.toAt, from))).limit(1);
      if (overlap.length) throw new ApiError(409, '已有生效费率覆盖该时间；请先作废错误依据，再登记新费率');
      const [rate] = await orm.insert(historicalRates).values({ siteId: b.siteId, userId: b.userId, model: b.model, fromAt: from,
        toAt: to, multiplier: b.multiplier, note: b.note }).returning();
      await writeAudit({ ...db, orm }, { actor: req.ctx!.email, action: 'finance.historical-rate', payload: { rateId: rate!.id, siteId: b.siteId }, ok: true });
      return { rate };
    });
  });
  app.get<{ Querystring: { siteId?: string } }>(`${base}/rates`, async req => {
    requireRoot(req.ctx!);
    if (!req.query.siteId || !/^\d+$/.test(req.query.siteId)) throw new ApiError(400, '请选择站点');
    return { rates: await db.orm.select().from(historicalRates).where(eq(historicalRates.siteId, Number(req.query.siteId))).orderBy(desc(historicalRates.id)).limit(200) };
  });
  app.post<{ Params: { id: string } }>(`${base}/rates/:id/void`, async req => {
    requireRoot(req.ctx!);
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).safeParse(req.body);
    if (!body.success || !/^\d+$/.test(req.params.id)) throw new ApiError(400, '请提供作废依据');
    return db.orm.transaction(async orm => {
      const [rate] = await orm.update(historicalRates).set({ voidedAt: toPgTimestamp(new Date()), voidReason: body.data.reason })
        .where(and(eq(historicalRates.id, Number(req.params.id)), isNull(historicalRates.voidedAt))).returning();
      if (!rate) throw new ApiError(409, '费率不存在或已作废');
      await writeAudit({ ...db, orm }, { actor: req.ctx!.email, action: 'finance.historical-rate.void', payload: { rateId: rate.id, reason: body.data.reason }, ok: true });
      return { rate };
    });
  });
}
