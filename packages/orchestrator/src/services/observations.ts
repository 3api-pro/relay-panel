import { and, asc, desc, eq, lt, ne, or, isNull, sql } from 'drizzle-orm';
import type { PassiveRecord } from '@relay-panel/adapter-core';
import { observationRuns, observedRequests, observationSourceRows, sites, appSettings } from '../db/schema.js';
import { ApiError, canAccessSite, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp, fromPgTimestamp } from '../auth/sessions.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';

export const beijingDay = (now = Date.now()): string => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function signals(r: PassiveRecord): string[] {
  const result: string[] = [];
  if (r.outcome === 'error') result.push('recorded_error');
  if (r.billingType === 'balance' && r.expectedCharge !== null && r.expectedCharge > 0 && r.charge !== null && r.charge + 0.000001 < r.expectedCharge) result.push('charge_difference');
  if (r.supplierCost !== null && r.charge !== null && r.billingType === 'balance' && r.expectedCharge !== 0 && r.charge + 0.000001 < r.supplierCost) result.push('below_supplier_cost');
  return result;
}
const quantile = (values: number[], p: number): number | null => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p)-1)]! : null;
export function summarize(records: PassiveRecord[], now = Date.now(), sourceScope = 'unavailable') {
  const groups = new Map<string, PassiveRecord[]>();
  for (const row of records) { const key = JSON.stringify([row.channelId, row.model]); const group=groups.get(key)??[];group.push(row);groups.set(key,group); }
  return [...groups.values()].map(rows => {
    const last = Math.max(...rows.map(r => Date.parse(r.createdAt)));
    const duration = rows.flatMap(r => r.durationMs === null ? [] : [r.durationMs]);
    const first = rows.flatMap(r => r.firstTokenMs === null ? [] : [r.firstTokenMs]);
    const charges = rows.filter(r => r.charge !== null), costs = rows.filter(r => r.supplierCost !== null);
    const matched = rows.filter(r => r.charge !== null && r.supplierCost !== null && r.billingType === 'balance');
    return { channelId: rows[0]!.channelId, model: rows[0]!.model, records: rows.length,
      consumeLogs: rows.filter(r => r.outcome === 'consumption').length, errorLogs: sourceScope==='consume-and-error-logs' ? rows.filter(r => r.outcome === 'error').length : null,
      successRate: null, latestEvidenceAt: new Date(last).toISOString(), freshness: now-last > 30*60000 ? 'stale' : 'recent',
      durationP50Ms: quantile(duration, .5), durationP95Ms: quantile(duration, .95), durationSamples: duration.length,
      firstTokenP95Ms: quantile(first,.95), firstTokenSamples: first.length,
      recordedCharge: charges.length ? charges.reduce((s,r)=>s+r.charge!,0) : null, chargeSamples: charges.length,
      observedSupplierCost: costs.length ? costs.reduce((s,r)=>s+r.supplierCost!,0) : null, costSamples: costs.length,
      matchedMargin: matched.length ? matched.reduce((s,r)=>s+r.charge!-r.supplierCost!,0) : null, marginSamples: matched.length,
      flagged: rows.filter(r => signals(r).length).length, currency: 'USD' };
  }).sort((a,b)=> b.records-a.records);
}

export class Observations {
  readonly service: SitesService;
  constructor(readonly deps: SitesServiceDeps) { this.service = new SitesService(deps); }
  async site(ctx: SessionCtx, id: number) {
    const [site] = await this.deps.db.orm.select().from(sites).where(and(eq(sites.id,id),ne(sites.status,'destroyed')));
    if (!site || !canAccessSite(ctx,site)) throw new ApiError(404, '站点不存在');
    return site;
  }
  async scan(ctx: SessionCtx, siteId: number, day: string) {
    const { db } = this.deps, site = await this.site(ctx,siteId), now = toPgTimestamp(new Date());
    if(site.status!=='active')throw new ApiError(409,'当前站点尚未运行，请先完成安装或恢复服务');
    await db.orm.insert(observationRuns).values({ siteId, day }).onConflictDoNothing();
    const lease = toPgTimestamp(new Date(Date.now()+120000));
    const [run] = await db.orm.update(observationRuns).set({ leaseUntil: lease })
      .where(and(eq(observationRuns.siteId,siteId),eq(observationRuns.day,day),or(isNull(observationRuns.leaseUntil),lt(observationRuns.leaseUntil,now)))).returning();
    if (!run) throw new ApiError(409, '该站点的日志正在采集中');
    try {
      // A completed historical window is immutable until an explicit refresh is requested.
      const restart = ['complete','changed','error','unsupported'].includes(run.status);
      const pageNumber = restart ? 1 : run.nextPage;
      if (pageNumber > 1000) throw new ApiError(413, '已达到每日 100000 条采集上限');
      const page = await this.service.passiveRecords(ctx,site.slug,{day,page:pageNumber});
      const changed = pageNumber > 1 && run.total !== null && run.total !== page.total;
      const generation = restart ? run.generation+1 : run.generation;
      return await db.orm.transaction(async orm => {
        const [locked] = await orm.select().from(observationRuns).where(and(eq(observationRuns.id,run.id),eq(observationRuns.leaseUntil,lease))).for('update');
        if (!locked) throw new ApiError(409,'采集租约已失效，请刷新');
        if (!changed) {
          if(page.sourceIds.length)await orm.insert(observationSourceRows).values(page.sourceIds.map(sourceId=>({runId:run.id,sourceId,generation})))
            .onConflictDoUpdate({target:[observationSourceRows.runId,observationSourceRows.sourceId],set:{generation}});
          for (const evidence of page.items) await orm.insert(observedRequests).values({ runId: run.id, sourceId:evidence.id, generation, evidence, observedAt:now })
            .onConflictDoUpdate({ target:[observedRequests.runId,observedRequests.sourceId],set:{generation,evidence,observedAt:now} });
        }
        const [count]=await orm.select({n:sql<number>`count(*)::int`}).from(observationSourceRows).where(and(eq(observationSourceRows.runId,run.id),eq(observationSourceRows.generation,generation)));
        const [stored]=await orm.select({n:sql<number>`count(*)::int`}).from(observationSourceRows).where(eq(observationSourceRows.runId,run.id));
        if(stored!.n>100000)throw new ApiError(413,'已达到该站点每日 100000 条源日志保留上限');
        const complete=pageNumber>=page.pages && count!.n===page.total;
        const incomplete=pageNumber>=page.pages && !complete;
        const [updated] = await orm.update(observationRuns).set({ sourceScope:page.sourceScope, total:page.total, error:null,
          generation, nextPage:changed||incomplete ? 1 : pageNumber+1, status:changed||incomplete ? 'changed' : complete ? 'complete' : 'partial',
          updatedAt:now, leaseUntil:null,
        }).where(eq(observationRuns.id,run.id)).returning();
        return updated!;
      });
    } catch(error) {
      const status = error instanceof ApiError && error.statusCode===501 ? 'unsupported' : 'error';
      await db.orm.update(observationRuns).set({status, error:status==='unsupported' ? '此版本未提供兼容日志接口' : '采集失败，请核对权限、接口版本或缩小范围；已有证据保留',leaseUntil:null,updatedAt:now})
        .where(and(eq(observationRuns.id,run.id),eq(observationRuns.leaseUntil,lease)));
      throw error;
    }
  }
  async report(ctx: SessionCtx, siteId: number, day: string, query: { requestId?: string | undefined; channelId?: string | undefined; model?: string | undefined } = {}) {
    const site = await this.site(ctx,siteId), { db } = this.deps;
    const [run] = await db.orm.select().from(observationRuns).where(and(eq(observationRuns.siteId,siteId),eq(observationRuns.day,day)));
    const rows = run ? await db.orm.select().from(observedRequests).where(and(eq(observedRequests.runId,run.id),eq(observedRequests.generation,run.generation),
      query.requestId ? sql`${observedRequests.evidence}->>'requestId' = ${query.requestId}` : undefined,
      query.channelId ? sql`${observedRequests.evidence}->>'channelId' = ${query.channelId}` : undefined,
      query.model ? sql`${observedRequests.evidence}->>'model' = ${query.model}` : undefined,
    )).orderBy(desc(observedRequests.id)).limit(10001) : [];
    const selected=rows.slice(0,10000), records=selected.map(r=>r.evidence);
    return { site:{id:site.id,label:site.label,engine:site.engine,version:site.version,managed:site.managed},run,
      retentionDays:30, sampleLimit:10000, sampleLimited:rows.length>10000, records:selected.map(r=>({...r,signals:signals(r.evidence)})),
      groups:summarize(records,Date.now(),run?.sourceScope??'unavailable'), inferenceRequestsGenerated:0, successRate:null, sourceScope:run?.sourceScope ?? 'unavailable',
      latestEvidenceAt:records.length ? new Date(Math.max(...records.map(r=>Date.parse(r.createdAt)))).toISOString() : null };
  }
}

export function startObservationWorker(deps: SitesServiceDeps, intervalMs: number): { stop(): Promise<void> } {
  const service = new Observations(deps); let current:Promise<void>|null=null, cursor=0;
  async function tick() {
    const day=beijingDay(), { db }=deps;
    const candidates=await db.orm.select().from(sites).where(and(eq(sites.status,'active'),sql`${sites.id}>${cursor}`)).orderBy(asc(sites.id)).limit(10);
    if(!candidates.length) {cursor=0;return;}
    for(const site of candidates) {
      cursor=site.id;
      const [settings]=await db.orm.select().from(appSettings).where(eq(appSettings.key,`passive_collection:${site.id}`));
      if(settings?.value.enabled===false)continue;
      const [last]=await db.orm.select().from(observationRuns).where(and(eq(observationRuns.siteId,site.id),eq(observationRuns.day,day)));
      if(last && Date.now()-fromPgTimestamp(last.updatedAt).getTime()<intervalMs) continue;
      await service.scan({operatorId:site.operatorId,role:'operator',email:'passive-collector'},site.id,day).catch(()=>undefined);
    }
    await db.orm.delete(observationRuns).where(lt(observationRuns.day,beijingDay(Date.now()-30*86400000)));
  }
  const timer=intervalMs>0 ? setInterval(()=>{if(!current)current=tick().catch(()=>undefined).finally(()=>{current=null;});},Math.max(60000,intervalMs)) : null;
  timer?.unref();
  return {async stop(){if(timer)clearInterval(timer);await current;}};
}
