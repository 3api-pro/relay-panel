import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db, Orm } from '../db/client.js';
import type { Config } from '../config.js';
import { budgetPolicies, budgetEvents, sites, operators, observationRuns, observedRequests } from '../db/schema.js';
import { ApiError, canAccessSite, requireWrite, type SessionCtx } from '../auth/rbac.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import { queueNotification } from '../notifications/service.js';
import { beijingDay } from './observations.js';

type Policy = typeof budgetPolicies.$inferSelect;
const DAY = 86400000;
export function budgetWindow(period: string, now = Date.now()) {
  const today = beijingDay(now), d = new Date(today + 'T00:00:00Z');
  let from = today, end: string;
  if (period === 'month') { from = today.slice(0, 8) + '01'; end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); }
  else if (period === 'week') { d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); from = d.toISOString().slice(0, 10); end = new Date(d.getTime() + 7 * DAY).toISOString().slice(0, 10); }
  else end = new Date(d.getTime() + DAY).toISOString().slice(0, 10);
  const days: string[] = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(today + 'T00:00:00Z'); t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  return { from, to: today, endExclusive: end, days, timezone: 'Asia/Shanghai' as const };
}
export interface BudgetReport {
  policy: { id: number; version: number; name: string; period: string; basis: string; amountUsd: string; warningPercent: number; channelId: string | null; model: string | null };
  window: ReturnType<typeof budgetWindow>; currency: 'USD'; enforcement: 'observation_only';
  observedUsd: string | null; observedPercent: number | null; status: 'no_evidence' | 'observed_below_threshold' | 'warning' | 'exceeded';
  records: number; pricedRecords: number; completeDays: number; missingDays: number; allRecordsPriced: boolean;
  latestCollectionAt: string | null; stale: boolean; evaluatedAt: string;
  days: { day: string; scanStatus: string; records: number; pricedRecords: number; observedUsd: string | null; sourceScope: string | null }[];
}
export class Budgets {
  constructor(readonly db: Db, readonly config: Config) {}
  async site(ctx: SessionCtx, id: number, orm: Orm = this.db.orm) {
    const [r] = await orm.select({ site: sites }).from(sites).innerJoin(operators, eq(operators.id, sites.operatorId))
      .where(and(eq(sites.id, id), ne(sites.status, 'destroyed'), eq(operators.status, 'active')));
    if (!r || !canAccessSite(ctx, r.site)) throw new ApiError(404, '站点不存在'); return r.site;
  }
  requireOwner(ctx: SessionCtx, ownerId: number) {
    requireWrite(ctx); if (ctx.role !== 'root' && (ctx.operatorId !== ownerId || ctx.teamRole)) throw new ApiError(403, '预算策略与提醒由站点所有者管理');
  }
  async policy(ctx: SessionCtx, id: number) {
    const [row] = await this.db.orm.select().from(budgetPolicies).where(eq(budgetPolicies.id, id));
    if (!row) throw new ApiError(404, '预算不存在'); await this.site(ctx, row.siteId); return row;
  }
  async report(policy: Policy, orm: Orm, now = Date.now()): Promise<BudgetReport> {
    const window = budgetWindow(policy.period, now);
    // Lock at most 31 scan rows so a generation change cannot mix coverage and sums.
    const runs = await orm.select().from(observationRuns).where(and(eq(observationRuns.siteId, policy.siteId), inArray(observationRuns.day, window.days))).orderBy(asc(observationRuns.id)).for('share');
    const cost = sql`(${observedRequests.evidence}->>${policy.basis})::numeric`;
    const sums = runs.length ? await orm.select({ day: observationRuns.day, records: sql<number>`count(*)::int`, priced: sql<number>`count(${cost})::int`, amount: sql<string | null>`round(sum(${cost}),6)::text` })
      .from(observedRequests).innerJoin(observationRuns, eq(observationRuns.id, observedRequests.runId))
      .where(and(inArray(observationRuns.id, runs.map(r => r.id)), eq(observedRequests.generation, observationRuns.generation),
        sql`${observedRequests.evidence}->>'outcome'='consumption'`, sql`${observedRequests.evidence}->>'currency'='USD'`,
        policy.channelId ? sql`${observedRequests.evidence}->>'channelId'=${policy.channelId}` : undefined,
        policy.model ? sql`${observedRequests.evidence}->>'model'=${policy.model}` : undefined)).groupBy(observationRuns.day) : [];
    const days = window.days.map(day => { const r = runs.find(r => r.day === day), sum = sums.find(s => s.day === day); return { day, scanStatus: r?.status ?? 'missing', records: sum?.records ?? 0, pricedRecords: sum?.priced ?? 0, observedUsd: sum?.amount ?? null, sourceScope: r?.sourceScope ?? null }; });
    const records = days.reduce((n, d) => n + d.records, 0), pricedRecords = days.reduce((n, d) => n + d.pricedRecords, 0);
    // Six-decimal decimal sums avoid floating-point threshold drift (0.1 + 0.2).
    const micros = days.reduce((n, d) => n + (d.observedUsd === null ? 0n : decimalMicros(d.observedUsd)), 0n);
    const limit = decimalMicros(policy.amountUsd), warning = BigInt(policy.warningPercent);
    const observedUsd = pricedRecords ? microsDecimal(micros) : null;
    const status = !pricedRecords ? 'no_evidence' : micros >= limit ? 'exceeded' : micros * 100n >= limit * warning ? 'warning' : 'observed_below_threshold';
    const latestCollectionAt = runs.map(r => r.updatedAt).sort().at(-1) ?? null, todayRun = runs.find(r => r.day === window.to);
    return { policy: { id: policy.id, version: policy.version, name: policy.name, period: policy.period, basis: policy.basis, amountUsd: policy.amountUsd, warningPercent: policy.warningPercent, channelId: policy.channelId, model: policy.model },
      window, currency: 'USD', enforcement: 'observation_only', observedUsd, observedPercent: pricedRecords ? Number(micros * 10000n / limit) / 100 : null, status,
      records, pricedRecords, completeDays: days.filter(d => d.scanStatus === 'complete').length, missingDays: days.filter(d => d.scanStatus === 'missing').length,
      allRecordsPriced: records > 0 && pricedRecords === records, latestCollectionAt,
      stale: !todayRun || now - fromPgTimestamp(todayRun.updatedAt).getTime() > 30 * 60000 || todayRun.status !== 'complete', evaluatedAt: new Date(now).toISOString(), days };
  }
  async readReport(ctx: SessionCtx, id: number) { const p = await this.policy(ctx, id); return this.db.orm.transaction(orm => this.report(p, orm)); }
  async evaluate(ctx: SessionCtx, id: number, now = Date.now()) {
    return this.db.orm.transaction(async orm => {
      const [policy] = await orm.select().from(budgetPolicies).where(eq(budgetPolicies.id, id)).for('update');
      if (!policy) throw new ApiError(404, '预算不存在'); const s = await this.site(ctx, policy.siteId, orm); this.requireOwner(ctx, s.operatorId);
      if (!policy.enabled) throw new ApiError(409, '预算策略已暂停');
      const report = await this.report(policy, orm, now), level = report.status === 'exceeded' ? 100 : report.status === 'warning' ? policy.warningPercent : null;
      if (level === null) return { report, eventCreated: false };
      const [prior] = await orm.select().from(budgetEvents).where(and(eq(budgetEvents.policyId, id), eq(budgetEvents.policyVersion, policy.version), eq(budgetEvents.periodStart, report.window.from)))
        .orderBy(desc(budgetEvents.level)).limit(1);
      if (prior && prior.level >= level) return { report, eventCreated: false };
      const [event] = await orm.insert(budgetEvents).values({ policyId: id, policyVersion: policy.version, periodStart: report.window.from, level, evidence: report }).onConflictDoNothing().returning();
      if (!event) return { report, eventCreated: false };
      if (policy.notify) await queueNotification({ ...this.db, orm }, this.config, { operatorId: s.operatorId, category: 'alerts', key: `budget:${id}:${policy.version}:${report.window.from}:${level}`,
        subject: `预算观测提醒：${policy.name}`, body: `${policy.name}：${report.window.from} 至 ${report.window.to} 已观测 ${report.observedUsd} USD，预算 ${policy.amountUsd} USD，达到 ${level}% 阈值。\n金额来自已有日志；${report.pricedRecords}/${report.records} 条记录包含金额，${report.completeDays}/${report.window.days.length} 天本轮读取完整。日志可能不覆盖全部请求，缺少数据不能视为预算充足。\n本提醒不执行渠道停用或引擎限额。请在面板预算页面复核。`,
        expiresAt: toPgTimestamp(new Date(Date.parse(report.window.endExclusive + 'T00:00:00+08:00') + DAY)) });
      return { report, eventCreated: true };
    });
  }
}
function decimalMicros(value: string): bigint {
  const [whole, decimal = ''] = value.split('.'); return BigInt(whole!) * 1000000n + BigInt(decimal.padEnd(6, '0').slice(0, 6));
}
function microsDecimal(value: bigint): string { return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, '0')}`; }

/** Reads only the panel database; no engine requests, probes, quota changes or payments. */
export function startBudgetWorker(db: Db, config: Config, intervalMs: number) {
  const service = new Budgets(db, config); let cursor = 0, current: Promise<void> | null = null;
  async function run() {
    const rows = await db.orm.select({ policy: budgetPolicies, ownerId: sites.operatorId }).from(budgetPolicies).innerJoin(sites, eq(sites.id, budgetPolicies.siteId)).innerJoin(operators, eq(operators.id, sites.operatorId))
      .where(and(eq(budgetPolicies.enabled, true), sql`${budgetPolicies.id}>${cursor}`, ne(sites.status, 'destroyed'), eq(operators.status, 'active'))).orderBy(asc(budgetPolicies.id)).limit(5);
    if (!rows.length) { cursor = 0; return; }
    for (const row of rows) { cursor = row.policy.id; await service.evaluate({ role: 'operator', operatorId: row.ownerId, email: 'budget-monitor' }, row.policy.id).catch(() => undefined); }
  }
  const tick = () => { if (!current) current = run().finally(() => { current = null; }); return current; };
  const timer = intervalMs > 0 ? setInterval(() => void tick().catch(() => undefined), Math.max(60000, intervalMs)) : null; timer?.unref();
  return { tick, async stop() { if (timer) clearInterval(timer); await current; } };
}
