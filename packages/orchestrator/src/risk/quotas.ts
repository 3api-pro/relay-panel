import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { EngineKind, PlatformQuota, PlatformQuotaInput } from '@relay-panel/adapter-core';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import { auditEvents, operators, quotaOperations as operations, sites, type SiteRow } from '../db/schema.js';
import type { Orm } from '../db/client.js';
import type { RiskDeps } from './service.js';
import { mergeQuotaInput, type QuotaChange } from './quota-input.js';

type Operation = typeof operations.$inferSelect;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => toPgTimestamp(new Date());
const time = (value: string) => Date.parse(value.includes('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
const siteHash = (s: SiteRow) => hash([s.id, s.operatorId, s.engine, s.version, s.baseUrl, s.credentialRef]);
export const QUOTA_SEMANTICS = {
  billing: 'balance-only', scope: 'engine-user-platform', dailyWeekly: 'engine-timezone-calendar', monthly: 'rolling-30-days',
  inferenceProbe: false, subscriptionCovered: false, simpleModeCovered: false, runtimeModeVerified: false, zeroOvershootGuaranteed: false,
} as const;

/** Normalize all-null rows, which upstream removes as equivalent to unlimited. Usage is not a config revision. */
export function canonicalLimits(rows: PlatformQuotaInput[]): PlatformQuotaInput[] {
  return rows.filter(r => r.dailyLimitUsd != null || r.weeklyLimitUsd != null || r.monthlyLimitUsd != null)
    .map(r => ({ platform: r.platform, dailyLimitUsd: r.dailyLimitUsd ?? null, weeklyLimitUsd: r.weeklyLimitUsd ?? null, monthlyLimitUsd: r.monthlyLimitUsd ?? null }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}
function inputs(rows: PlatformQuota[]): PlatformQuotaInput[] {
  if (!Array.isArray(rows) || rows.length > 64) throw new ApiError(502, '引擎限额快照不完整');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.platform !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.platform) || seen.has(row.platform)) throw new ApiError(502, '引擎限额快照不完整');
    seen.add(row.platform);
    for (const w of [row.daily, row.weekly, row.monthly]) if (!w || typeof w.usageUsd !== 'number' || !Number.isFinite(w.usageUsd) || w.usageUsd < 0 || (w.limitUsd !== null && (typeof w.limitUsd !== 'number' || !Number.isFinite(w.limitUsd) || w.limitUsd < 0))) throw new ApiError(502, '引擎限额快照不完整');
  }
  return rows.map(r => ({ platform: r.platform, dailyLimitUsd: r.daily.limitUsd, weeklyLimitUsd: r.weekly.limitUsd, monthlyLimitUsd: r.monthly.limitUsd }));
}
const same = (a: PlatformQuotaInput[], b: PlatformQuotaInput[]) => hash(canonicalLimits(a)) === hash(canonicalLimits(b));
function dto(o: Operation) {
  const { siteFingerprint: _siteFingerprint, actorId: _actorId, ...item } = o;
  return { ...item, observedFingerprint: o.observed ? hash(canonicalLimits(inputs(o.observed))) : null };
}

export class QuotaService {
  private readonly credstore;
  constructor(private readonly deps: RiskDeps) { this.credstore = makeCredentialStoreV2(deps.db, deps.config); }
  private async site(orm: Orm, slug: string, lock?: 'update' | 'share') {
    const query = orm.select().from(sites).where(and(eq(sites.slug, slug), ne(sites.status, 'destroyed'))).limit(1);
    const [site] = await (lock ? query.for(lock) : query);
    if (!site) throw new ApiError(404, '站点不存在');
    if (site.engine !== 'sub2api') throw new ApiError(400, '该引擎尚未接入用户平台限额');
    return site;
  }
  private async client(site: SiteRow) {
    const client = await this.deps.adapters[site.engine as EngineKind].connect({ siteSlug: site.slug, engine: site.engine as EngineKind, version: site.version, baseUrl: site.baseUrl, dataDir: site.dataDir, composeProject: site.composeProject, credentialRef: site.credentialRef }, this.credstore);
    if (!client.users.getPlatformQuotas || !client.users.setPlatformQuotas) throw new ApiError(400, '引擎版本不支持平台限额');
    return { get: client.users.getPlatformQuotas, set: client.users.setPlatformQuotas };
  }
  private user(id: string) {
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new ApiError(400, '请输入有效的引擎用户编号');
  }
  private async snapshot(site: SiteRow, userId: string) {
    try { const client = await this.client(site), rows = await client.get(userId); inputs(rows); return rows; }
    catch { throw new ApiError(502, '无法读取完整限额，请检查引擎连接、版本、权限与用户编号'); }
  }
  private async activeRoot(orm: Orm, ctx: SessionCtx) {
    requireRoot(ctx);
    const [actor] = await orm.select({ id: operators.id }).from(operators).where(and(eq(operators.id, ctx.operatorId), eq(operators.role, 'root'), eq(operators.status, 'active'))).limit(1);
    if (!actor) throw new ApiError(403, '管理员权限已失效');
  }
  async preview(ctx: SessionCtx, slug: string, userId: string, change: QuotaChange) {
    await this.activeRoot(this.deps.db.orm, ctx); this.user(userId);
    const site = await this.site(this.deps.db.orm, slug);
    const current = await this.snapshot(site, userId), before = inputs(current), merged = mergeQuotaInput(current, change);
    const [item] = await this.deps.db.orm.insert(operations).values({ siteId: site.id, actorId: ctx.operatorId, userId, siteFingerprint: siteHash(site), change, beforeLimits: before, requestedLimits: merged, expiresAt: toPgTimestamp(new Date(Date.now() + 10 * 60_000)) }).returning();
    return { operation: dto(item!), platform: change.platform, window: change.window, current, merged, semantics: QUOTA_SEMANTICS, writable: !site.readonly };
  }
  async history(ctx: SessionCtx, slug: string, before?: number) {
    requireRoot(ctx);
    const site = await this.site(this.deps.db.orm, slug);
    const rows = await this.deps.db.orm.select().from(operations).where(and(eq(operations.siteId, site.id), before ? lt(operations.id, before) : undefined)).orderBy(desc(operations.id)).limit(51);
    return { items: rows.slice(0, 50).map(dto), hasMore: rows.length > 50, semantics: QUOTA_SEMANTICS, writable: !site.readonly };
  }
  private async record(orm: Orm, o: Operation, ctx: SessionCtx, status: string, detail: string, observed?: PlatformQuota[], resolutionNote?: string) {
    const [item] = await orm.update(operations).set({ status, detail, updatedAt: now(), ...(observed ? { observed, checkedAt: now() } : {}), ...(resolutionNote ? { resolutionNote } : {}) }).where(eq(operations.id, o.id)).returning();
    await orm.insert(auditEvents).values({ siteId: o.siteId, actor: ctx.email, action: `risk.quota.${status}`, payload: { operationId: o.id, userId: o.userId }, ok: status === 'verified' || status === 'resolved' });
    return dto(item!);
  }
  private async finish(o: Operation, ctx: SessionCtx, status: string, detail: string, observed?: PlatformQuota[]) {
    return this.deps.db.orm.transaction(async tx => {
      const [current] = await tx.select().from(operations).where(eq(operations.id, o.id)).for('update');
      // A review may have completed after a crashed/slow worker; never reopen a closed record.
      if (!current || !['applying', 'uncertain'].includes(current.status)) return current ? dto(current) : null;
      return this.record(tx, current, ctx, status, detail, observed);
    });
  }
  async apply(ctx: SessionCtx, slug: string, userId: string, operationId: number) {
    requireRoot(ctx); this.user(userId);
    if (!this.deps.config.riskEnforce) throw new ApiError(403, '当前仅允许预览，管理员尚未启用限额写入');
    // Commit the intention before contacting upstream. Site lock serializes claims across processes.
    const op = await this.deps.db.orm.transaction(async tx => {
      await this.activeRoot(tx, ctx);
      const site = await this.site(tx, slug, 'update');
      if (site.readonly) throw new ApiError(403, '该站为只读，拒绝限额写回');
      const [o] = await tx.select().from(operations).where(and(eq(operations.id, operationId), eq(operations.siteId, site.id), eq(operations.userId, userId), eq(operations.actorId, ctx.operatorId))).for('update');
      if (!o) throw new ApiError(404, '预览不存在或不属于当前管理员');
      if (o.status === 'verified') return o; // Duplicate submit never repeats PUT.
      if (o.status !== 'preview' || time(o.expiresAt) <= Date.now() || siteHash(site) !== o.siteFingerprint) throw new ApiError(409, '预览已失效或已执行，请查看记录后重新预览');
      const [pending] = await tx.select({ id: operations.id }).from(operations).where(and(eq(operations.siteId, site.id), eq(operations.userId, userId), inArray(operations.status, ['applying', 'uncertain']))).limit(1);
      if (pending) throw new ApiError(409, `操作 #${pending.id} 尚未核实，请先回读复核`);
      const [claimed] = await tx.update(operations).set({ status: 'applying', startedAt: now(), updatedAt: now(), detail: '已记录执行意图，等待引擎确认' }).where(eq(operations.id, o.id)).returning();
      await tx.insert(auditEvents).values({ siteId: site.id, actor: ctx.email, action: 'risk.quota.started', payload: { operationId: o.id, userId }, ok: true });
      return claimed!;
    });
    if (op.status === 'verified') return { operation: dto(op), quotas: op.observed ?? [] };
    let attempted = false;
    try {
      const result = await this.deps.db.orm.transaction(async tx => {
        // Protect the target and readonly flag while using its credentials. No retry of the remote write.
        const site = await this.site(tx, slug, 'share');
        if (site.readonly || siteHash(site) !== op.siteFingerprint) throw new ApiError(409, '站点配置已变化');
        await this.activeRoot(tx, ctx);
        const client = await this.client(site), before = await client.get(userId);
        if (!same(inputs(before), op.beforeLimits)) return { status: 'conflict', detail: '引擎限额已被其他操作修改，本次未写入；请重新预览', observed: before };
        if (!same(inputs(before), op.requestedLimits)) { attempted = true; await client.set(userId, op.requestedLimits); }
        const observed = await client.get(userId);
        const matches = same(inputs(observed), op.requestedLimits);
        return { status: matches ? 'verified' : 'uncertain', detail: matches ? '引擎配置回读一致；仅适用标准模式余额计费，实际拦截与运行模式仍须在引擎侧验证' : '写入后回读与预览不一致，请复核；禁止自动重试', observed };
      });
      const operation = await this.finish(op, ctx, result.status, result.detail, result.observed);
      return { operation, quotas: result.observed };
    } catch {
      const operation = await this.finish(op, ctx, attempted ? 'uncertain' : 'failed', attempted ? '已尝试写入，但结果未能核实；请回读复核，不要重复提交' : '写入前检查未完成，本次未调用引擎写入接口');
      return { operation, quotas: [] };
    }
  }
  async review(ctx: SessionCtx, slug: string, id: number, resolution?: { observedFingerprint: string; note: string }) {
    await this.activeRoot(this.deps.db.orm, ctx);
    return this.deps.db.orm.transaction(async tx => {
      const site = await this.site(tx, slug, 'share');
      const [o] = await tx.select().from(operations).where(and(eq(operations.id, id), eq(operations.siteId, site.id))).for('update');
      if (!o) throw new ApiError(404, '操作记录不存在');
      if (!['applying', 'uncertain'].includes(o.status)) throw new ApiError(409, '仅待核实的操作可以复核');
      if (!o.startedAt || Date.now() - time(o.startedAt) < (resolution ? 300_000 : 120_000)) throw new ApiError(409, resolution ? '请在执行开始五分钟后再处理差异' : '执行可能仍在进行，请在开始两分钟后回读');
      if (siteHash(site) !== o.siteFingerprint) throw new ApiError(409, '站点连接配置已变化，无法对原目标回读；请恢复原连接后复核');
      const observed = await this.snapshot(site, o.userId), current = inputs(observed);
      if (same(current, o.requestedLimits)) return { operation: await this.record(tx, o, ctx, 'verified', '复核时引擎配置与预览一致', observed) };
      if (resolution) {
        if (!o.observed || !o.checkedAt || Date.now() - time(o.checkedAt) > 10 * 60_000 || resolution.observedFingerprint !== hash(canonicalLimits(inputs(o.observed))) || resolution.observedFingerprint !== hash(canonicalLimits(current))) throw new ApiError(409, '当前配置已变化或尚未回读，请先重新复核');
        return { operation: await this.record(tx, o, ctx, 'resolved', '管理员已接受当前引擎配置并关闭差异，本次不标记为写入成功', observed, resolution.note) };
      }
      return { operation: await this.record(tx, o, ctx, 'uncertain', '回读配置仍与预览不同；可在确认引擎没有待执行请求后记录处理意见', observed) };
    });
  }
}
