import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { UsageRecord, UsageRecordQuery } from '@relay-panel/adapter-core';
import type { Db } from '../db/client.js';
import { financeReviewCases as cases, financeReviewEvents as events, sites } from '../db/schema.js';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { writeAudit } from '../audit.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import type { SitesService } from '../sites/service.js';

export const REVIEW_STATES = ['pending', 'reviewing', 'confirmed', 'explained', 'resolved'] as const;
export type ReviewState = typeof REVIEW_STATES[number];
type Case = typeof cases.$inferSelect;
const digest = (e: UsageRecord) => createHash('sha256').update(JSON.stringify(e)).digest('hex');

/** Signals for human review, not a debt calculation or proof that settlement failed. */
export function reviewReasons(e: UsageRecord): string[] {
  if (e.billingType === 'subscription') return [];
  if (e.actualCost === null || e.billingType === 'unknown' || e.rateMultiplier === null) return ['incomplete_evidence'];
  if (e.rateMultiplier === 0) return []; // Explicitly configured free usage.
  if (e.actualCost === 0 && e.activity === null && e.accountCost === null) return ['incomplete_evidence'];
  if (e.actualCost === 0 && ((e.activity ?? 0) > 0 || (e.accountCost ?? 0) > 0)) return ['zero_charge'];
  return [];
}

async function transaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.orm.transaction(orm => fn({ ...db, orm,
    async query() { throw new Error('Use transactional ORM'); },
    async exec() { throw new Error('Use transactional ORM'); },
    async close() { throw new Error('Use transactional ORM'); },
  }));
}

async function event(db: Db, ctx: SessionCtx, row: Case, kind: string, note: string) {
  await db.orm.insert(events).values({ caseId: row.id, actor: ctx.email, kind, state: row.state, note, evidence: row.evidence });
  // No siteId: private case metadata must not appear in tenant-readable site audit trails.
  await writeAudit(db, { actor: ctx.email, action: `finance.review.${kind}`, ok: true,
    payload: { caseId: row.id, version: row.version, state: row.state, verification: row.verification } });
}

export class FinanceReview {
  constructor(private db: Db, private siteService: SitesService) {}

  async list(ctx: SessionCtx, state: string | undefined, siteId: number | undefined, page: number) {
    requireRoot(ctx);
    const where = and(state ? eq(cases.state, state) : undefined, siteId ? eq(cases.siteId, siteId) : undefined);
    const rows = await this.db.orm.select({ item: cases, slug: sites.slug, label: sites.label }).from(cases)
      .innerJoin(sites, eq(cases.siteId, sites.id)).where(where).orderBy(desc(cases.id)).offset((page - 1) * 50).limit(51);
    return { items: rows.slice(0, 50).map(r => ({ ...r.item, slug: r.slug, label: r.label })), page, hasMore: rows.length > 50 };
  }

  async detail(ctx: SessionCtx, id: number) {
    requireRoot(ctx);
    const [row] = await this.db.orm.select({ item: cases, slug: sites.slug, label: sites.label }).from(cases)
      .innerJoin(sites, eq(cases.siteId, sites.id)).where(eq(cases.id, id));
    if (!row) throw new ApiError(404, '复核记录不存在');
    const history = await this.db.orm.select().from(events).where(eq(events.caseId, id)).orderBy(desc(events.id)).limit(101);
    return { ...row.item, slug: row.slug, label: row.label, events: history.slice(0, 100), historyTruncated: history.length > 100 };
  }

  async scan(ctx: SessionCtx, slug: string, query: UsageRecordQuery) {
    requireRoot(ctx);
    const { siteId, page } = await this.siteService.financeUsageRecords(ctx, slug, query);
    let created = 0;
    let updated = 0;
    // One page is atomic; duplicate scans converge on the unique engine identity.
    await transaction(this.db, async tx => {
      for (const evidence of page.items) {
        const reasons = reviewReasons(evidence);
        const fingerprint = digest(evidence);
        if (reasons.length) {
          const [inserted] = await tx.orm.insert(cases).values({ siteId, sourceId: evidence.id, evidence, fingerprint, reasons })
            .onConflictDoNothing({ target: [cases.siteId, cases.sourceId] }).returning();
          if (inserted) { await event(tx, ctx, inserted, 'detected', ''); created++; continue; }
        }
        const [row] = await tx.orm.select().from(cases).where(and(eq(cases.siteId, siteId), eq(cases.sourceId, evidence.id))).for('update');
        if (row && row.fingerprint !== fingerprint) {
          await this.replaceEvidence(tx, ctx, row, evidence, 'scan', ''); updated++;
        }
      }
      await writeAudit(tx, { actor: ctx.email, action: 'finance.review.scan', ok: true,
        payload: { siteId, from: query.from, to: query.to, page: page.page, scanned: page.items.length, created, updated } });
    });
    return { scanned: page.items.length, flagged: page.items.filter(e => reviewReasons(e).length).length,
      created, updated, total: page.total, page: page.page, pages: page.pages, pageSize: page.pageSize, scope: 'page' };
  }

  private async locked(tx: Db, id: number, version: number) {
    const [row] = await tx.orm.select().from(cases).where(eq(cases.id, id)).for('update');
    if (!row) throw new ApiError(404, '复核记录不存在');
    if (row.version !== version) throw new ApiError(409, '记录已更新，请刷新后重试');
    return row;
  }

  private async replaceEvidence(tx: Db, ctx: SessionCtx, row: Case, evidence: UsageRecord, kind: string, note: string) {
    const fingerprint = digest(evidence);
    const reasons = reviewReasons(evidence);
    const now = toPgTimestamp(new Date());
    const [updated] = await tx.orm.update(cases).set({ evidence, fingerprint, reasons,
      state: fingerprint !== row.fingerprint && ['resolved', 'explained'].includes(row.state) ? 'pending' : row.state,
      verification: reasons.length ? 'flagged' : 'clear', checkedAt: now, updatedAt: now, version: row.version + 1,
    }).where(eq(cases.id, row.id)).returning();
    await event(tx, ctx, updated!, kind, note);
    return updated!;
  }

  async review(ctx: SessionCtx, id: number, version: number, state: ReviewState, note: string) {
    requireRoot(ctx);
    if (!note.trim() || note.length > 2000) throw new ApiError(400, '请填写处置依据（1–2000 字）');
    return transaction(this.db, async tx => {
      const row = await this.locked(tx, id, version);
      const age = Date.now() - fromPgTimestamp(row.checkedAt).getTime();
      if (state === 'resolved' && (row.verification !== 'clear' || !Number.isFinite(age) || age < 0 || age > 15 * 60_000)) {
        throw new ApiError(409, '请先重新核验：仅当最近 15 分钟内异常信号已解除，才可标记已解决');
      }
      const [updated] = await tx.orm.update(cases).set({ state, version: row.version + 1, updatedAt: toPgTimestamp(new Date()) })
        .where(eq(cases.id, id)).returning();
      await event(tx, ctx, updated!, 'review', note.trim());
      return updated!;
    });
  }

  async recheck(ctx: SessionCtx, id: number, version: number) {
    requireRoot(ctx);
    const current = await this.detail(ctx, id);
    if (current.version !== version) throw new ApiError(409, '记录已更新，请刷新后重试');
    let evidence: UsageRecord | undefined;
    // Usage API has no GET by ID. Exact request-id search is bounded to 10 pages and identity checked.
    if (current.evidence.requestId) {
      const date = new Date(Date.parse(current.evidence.createdAt) + 8 * 3600_000).toISOString().slice(0, 10);
      try {
        for (let page = 1; page <= 10; page++) {
          const response = await this.siteService.financeUsageRecords(ctx, current.slug,
            { from: date, to: date, requestId: current.evidence.requestId, page });
          evidence = response.page.items.find(e => e.id === current.sourceId && e.requestId === current.evidence.requestId &&
            e.userId === current.evidence.userId && e.createdAt === current.evidence.createdAt);
          if (evidence || page >= response.page.pages || response.page.items.length === 0) break;
        }
      } catch { /* Unavailable evidence cannot clear or close a case. */ }
    }
    return transaction(this.db, async tx => {
      const row = await this.locked(tx, id, version);
      if (evidence) return this.replaceEvidence(tx, ctx, row, evidence, 'recheck', '');
      const [updated] = await tx.orm.update(cases).set({ verification: 'unavailable', version: row.version + 1,
        checkedAt: toPgTimestamp(new Date()), updatedAt: toPgTimestamp(new Date()) }).where(eq(cases.id, id)).returning();
      await event(tx, ctx, updated!, 'recheck', '未取得匹配的请求证据；保留上次证据与处置状态');
      return updated!;
    });
  }
}
