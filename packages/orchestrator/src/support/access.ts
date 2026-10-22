import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Orm } from '../db/client.js';
import { operators, supportAssignments, supportTickets } from '../db/schema.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { toPgTimestamp } from '../auth/sessions.js';
export const ticketId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export function supportParse<T extends z.ZodTypeAny>(s: T, input: unknown): z.output<T> { const r = s.safeParse(input); if (!r.success) throw new ApiError(400, '请检查工单、权限、有效期及必填内容'); return r.data; }
export const now = () => toPgTimestamp(new Date());
export const issuer = alias(operators, 'support_issuer');
export const customer = alias(operators, 'support_customer');
export function activeAssignment(ctx: SessionCtx) {
  return and(eq(supportAssignments.operatorId, ctx.operatorId), eq(supportAssignments.email, normalizeEmail(ctx.email)),
    isNull(supportAssignments.revokedAt), gt(supportAssignments.expiresAt, now()), eq(issuer.role, 'root'), eq(issuer.status, 'active'), eq(customer.status, 'active'));
}
export function ticketDto(t: typeof supportTickets.$inferSelect) { return { id: t.id, subject: t.subject, status: t.status, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt }; }
/** Every grant mutation and ticket operation locks ticket first, so revocation serializes with replies. */
export async function ticketContext(orm: Orm, ctx: SessionCtx, id: number) {
  if (ctx.role === 'viewer') throw new ApiError(404, '工单不存在');
  const [ticket] = await orm.select().from(supportTickets).where(eq(supportTickets.id, id)).for('update');
  if (!ticket) throw new ApiError(404, '工单不存在');
  if (ctx.role === 'root') return { ticket, staff: true, canReply: true, canResolve: true, canNotes: true, assignment: null };
  if (ctx.operatorId === ticket.operatorId) return { ticket, staff: false, canReply: true, canResolve: true, canNotes: false, assignment: null };
  const [member] = await orm.select({ verified: operators.emailVerifiedAt }).from(operators).where(eq(operators.id, ctx.operatorId));
  if (!member?.verified) throw new ApiError(404, '工单不存在');
  const [r] = await orm.select({ assignment: supportAssignments }).from(supportAssignments)
    .innerJoin(issuer, eq(issuer.id, supportAssignments.assignedBy)).innerJoin(customer, eq(customer.id, ticket.operatorId))
    .where(and(eq(supportAssignments.ticketId, ticket.id), activeAssignment(ctx)));
  if (!r) throw new ApiError(404, '工单不存在');
  return { ticket, staff: true, canReply: r.assignment.canReply, canResolve: r.assignment.canResolve, canNotes: r.assignment.canNotes, assignment: r.assignment };
}
export async function activeAssignees(orm: Orm, id: number) {
  return orm.select({ id: operators.id, expiresAt: supportAssignments.expiresAt }).from(supportAssignments)
    .innerJoin(operators, eq(operators.id, supportAssignments.operatorId)).innerJoin(issuer, eq(issuer.id, supportAssignments.assignedBy))
    .where(and(eq(supportAssignments.ticketId, id), isNull(supportAssignments.revokedAt), gt(supportAssignments.expiresAt, now()),
      eq(operators.status, 'active'), eq(operators.role, 'operator'), isNotNull(operators.emailVerifiedAt), eq(operators.email, supportAssignments.email), eq(issuer.status, 'active'), eq(issuer.role, 'root')));
}
export const cursorInput = z.object({ at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/).refine(v => v.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(v.replace(' ', 'T') + 'Z')) && new Date(v.replace(' ', 'T') + 'Z').toISOString().slice(0, 10) === v.slice(0, 10)), id: ticketId }).strict();
export function decodeCursor(value?: string) {
  if (!value) return null;
  try { return supportParse(cursorInput, JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); } catch { throw new ApiError(400, '分页位置无效，请刷新'); }
}
export function cursorCondition(value?: string) { const c = decodeCursor(value); return c ? sql`(${supportTickets.updatedAt},${supportTickets.id})<(${c.at}::timestamp,${c.id})` : undefined; }
export function encodeCursor(t: typeof supportTickets.$inferSelect) { return Buffer.from(JSON.stringify({ at: t.updatedAt, id: t.id })).toString('base64url'); }
