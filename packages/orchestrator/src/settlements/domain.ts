import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Orm } from '../db/client.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { accessContext, ownedSite } from '../services/collaboration.js';
import { operators, servicePartners, sites, settlementStatements as statements, settlementShares as shares, settlementReceipts as receipts, settlementEvents as events, auditEvents } from '../db/schema.js';
export type Statement = typeof statements.$inferSelect;
export const id = z.coerce.number().int().positive().max(2147483647);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
const moneyPattern = /^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
export const money = z.string().refine(s => { if (!moneyPattern.test(s)) return false; const n = micros(s); return n >= -1000000000000000n && n <= 1000000000000000n; });
export const positiveMoney = money.refine(s => moneyPattern.test(s) && micros(s) > 0n);
export const now = () => toPgTimestamp(new Date());
export const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> { const r = schema.safeParse(value); if (!r.success) throw new ApiError(400, '请核对必填字段、日期和金额；金额最多六位小数'); return r.data; }
export function micros(s: string): bigint { const negative = s.startsWith('-'), [whole, fraction = ''] = s.replace(/^-/, '').split('.'); return (negative ? -1n : 1n) * (BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'))); }
export function decimal(n: bigint): string { const a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 1000000n}.${(a % 1000000n).toString().padStart(6, '0')}`; }
export const draftInput = z.object({ siteId: id, partnerId: id, reference: z.string().trim().min(1).max(100), title: z.string().trim().min(3).max(160),
  direction: z.enum(['payable','receivable']), currency: z.enum(['USD','CNY']), fromDay: day, toDay: day, dueDay: day.nullable(),
  lines: z.array(z.object({ label: z.string().trim().min(1).max(200), amount: money }).strict()).min(1).max(50),
  publicNote: z.string().trim().max(2000), internalNote: z.string().trim().max(4000), sourceReviewId: id.nullable().default(null), version: z.number().int().nonnegative(),
}).strict().refine(b => b.fromDay <= b.toDay && Date.parse(b.toDay) - Date.parse(b.fromDay) < 366 * 86400000);
export function priced(lines: { label: string; amount: string }[]) {
  const total = lines.reduce((n, l) => n + micros(l.amount), 0n);
  if (total <= 0n || total > 1000000000000000n) throw new ApiError(400, '结算单净额须大于零且不超过十亿');
  return { total: decimal(total), lines: lines.map(l => ({ label: l.label, amount: decimal(micros(l.amount)) })) };
}
export async function activeSite(orm: Orm, siteId: number, ownerId?: number) {
  const [site] = await orm.select().from(sites).where(eq(sites.id, siteId)).for('share');
  if (!site || site.status === 'destroyed' || (ownerId !== undefined && site.operatorId !== ownerId)) throw new ApiError(404, '结算站点不存在');
  const [owner] = await orm.select({ status: operators.status }).from(operators).where(eq(operators.id, site.operatorId)).for('share');
  if (owner?.status !== 'active') throw new ApiError(404, '结算账号不可用');
  return site;
}
export async function statementRow(orm: Orm, statementId: number) {
  const [first] = await orm.select({ siteId: statements.siteId, ownerId: statements.ownerId }).from(statements).where(eq(statements.id, statementId));
  if (!first) throw new ApiError(404, '结算单不存在');
  await activeSite(orm, first.siteId, first.ownerId);
  const [row] = await orm.select().from(statements).where(eq(statements.id, statementId)).for('update');
  if (!row) throw new ApiError(404, '结算单不存在'); return row;
}
export async function ownerStatement(orm: Orm, ctx: SessionCtx, statementId: number) {
  const [first] = await orm.select({ siteId: statements.siteId }).from(statements).where(eq(statements.id, statementId));
  if (!first) throw new ApiError(404, '结算单不存在'); await ownedSite(orm, ctx, first.siteId);
  return statementRow(orm, statementId);
}
export function version(row: Statement, expected: number) { if (row.version !== expected) throw new ApiError(409, '结算单已更新，请刷新后重试'); }
export async function activePartner(orm: Orm, siteId: number, partnerId: number) {
  const [p] = await orm.select().from(servicePartners).where(and(eq(servicePartners.id, partnerId), eq(servicePartners.siteId, siteId), eq(servicePartners.status, 'active'))).for('share');
  if (!p) throw new ApiError(400, '请选择本站点的有效合作伙伴'); return p;
}
export function publicStatement(s: Statement) {
  return { id: s.id, reference: s.reference, title: s.title, partnerName: s.partnerName, direction: s.direction, currency: s.currency, fromDay: s.fromDay, toDay: s.toDay, dueDay: s.dueDay, lines: s.lines, total: s.total,
    publicNote: s.publicNote, status: s.status, version: s.version, issuedAt: s.issuedAt, cancelledAt: s.cancelledAt, cancelReason: s.cancelReason, createdAt: s.createdAt, updatedAt: s.updatedAt };
}
export function publicReceipt(r: typeof receipts.$inferSelect) { return { id: r.id, amount: r.amount, reference: r.reference, method: r.method, receivedDay: r.receivedDay, note: r.note, voidedAt: r.voidedAt, voidReason: r.voidReason, createdAt: r.createdAt }; }
export function publicShare(s: typeof shares.$inferSelect) { return { id: s.id, status: s.status, note: s.note, version: s.version, revokedAt: s.revokedAt, createdAt: s.createdAt, updatedAt: s.updatedAt }; }
export async function balance(orm: Orm, s: Statement) {
  const [r] = await orm.select({ amount: sql<string>`coalesce(sum(${receipts.amount}),0)::numeric(24,6)::text` }).from(receipts).where(and(eq(receipts.statementId, s.id), isNull(receipts.voidedAt)));
  const recorded = micros(r!.amount), remaining = micros(s.total) - recorded;
  return { recorded: decimal(recorded), remaining: decimal(remaining), status: recorded === 0n ? 'unrecorded' : remaining === 0n ? 'recorded_in_full' : 'partially_recorded', overdue: s.status === 'issued' && remaining > 0n && !!s.dueDay && s.dueDay < today(), proof: 'operator-recorded' };
}
export async function change(orm: Orm, s: Statement, ctx: SessionCtx, action: string, note: string, values: Partial<typeof statements.$inferInsert> = {}, shareId?: number) {
  const [item] = await orm.update(statements).set({ ...values, version: s.version + 1, updatedAt: now() }).where(eq(statements.id, s.id)).returning();
  await event(orm, s, ctx, action, note, shareId); return item!;
}
export async function event(orm: Orm, s: Statement, ctx: SessionCtx, action: string, note: string, shareId?: number) {
  await orm.insert(events).values({ statementId: s.id, shareId: shareId ?? null, actorId: ctx.operatorId, action, note });
  await orm.insert(auditEvents).values({ siteId: s.siteId, actor: ctx.email, action: `settlement.${action}`, payload: { statementId: s.id, ...(shareId ? { shareId } : {}) }, ok: true });
}
export function grantMatches(grant: Awaited<ReturnType<typeof accessContext>>, s: Statement) {
  if (grant.access.siteId !== s.siteId || grant.access.ownerId !== s.ownerId || !['supplier','reseller','finance'].includes(grant.access.role) || (grant.access.role !== 'finance' && grant.access.partnerId !== s.partnerId) || (grant.access.partnerId !== null && grant.access.partnerId !== s.partnerId)) throw new ApiError(404, '此身份不能接收该结算单');
}
export async function memberStatement(orm: Orm, ctx: SessionCtx, shareId: number) {
  const [first] = await orm.select().from(shares).where(eq(shares.id, shareId));
  if (!first) throw new ApiError(404, '共享结算单不存在');
  // Consistent lock order: grant -> site -> statement -> share, including owner share/revoke actions.
  const grant = await accessContext(orm, ctx, first.accessId, false, true);
  const [op] = await orm.select({ verified: operators.emailVerifiedAt }).from(operators).where(eq(operators.id, ctx.operatorId));
  if (!op?.verified) throw new ApiError(403, '请先验证受邀邮箱');
  const statement = await statementRow(orm, first.statementId); grantMatches(grant, statement);
  const [share] = await orm.select().from(shares).where(eq(shares.id, shareId)).for('update');
  if (!share || share.revokedAt || statement.status === 'draft') throw new ApiError(404, '共享结算单不存在');
  return { statement, share, grant };
}
