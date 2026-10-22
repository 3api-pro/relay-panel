import { and, desc, eq, gt, ilike, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { operators, supportAssignments, supportInternalNotes, supportTickets } from '../db/schema.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { writeAudit } from '../audit.js';
import { activeAssignment, customer, issuer, cursorCondition, encodeCursor, now, supportParse as parse, ticketContext, ticketDto, ticketId as id } from './access.js';
export const ticketListInput = z.object({ status: z.enum(['open', 'waiting_customer', 'resolved']).optional(), q: z.string().trim().max(120).optional(), cursor: z.string().max(200).optional() }).strict();
export function ticketListConditions(q: z.infer<typeof ticketListInput>) { return and(q.status ? eq(supportTickets.status, q.status) : undefined, q.q ? ilike(supportTickets.subject, '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%') : undefined, cursorCondition(q.cursor)); }
const permissions = z.object({ canReply: z.boolean(), canResolve: z.boolean(), canNotes: z.boolean(), days: z.number().int().min(1).max(90) });
const valid = <T extends { canReply: boolean; canResolve: boolean }>(b: T) => { if (b.canResolve && !b.canReply) throw new ApiError(400, '结单权限需要同时允许回复'); return b; };
function assignmentDto(a: typeof supportAssignments.$inferSelect) { return { id: a.id, email: a.email, canReply: a.canReply, canResolve: a.canResolve, canNotes: a.canNotes, expiresAt: a.expiresAt, revokedAt: a.revokedAt, version: a.version, createdAt: a.createdAt }; }
export function registerSupportAssignmentRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const base = '/api/support/tickets';
  app.get('/api/support/assigned', async req => {
    const ctx = req.ctx!, q = parse(ticketListInput, req.query);
    if (ctx.role !== 'operator') return { tickets: [], nextCursor: null };
    const [op] = await db.orm.select({ verified: operators.emailVerifiedAt }).from(operators).where(eq(operators.id, ctx.operatorId));
    if (!op?.verified) return { tickets: [], nextCursor: null };
    const rows = await db.orm.select({ ticket: supportTickets, grant: supportAssignments }).from(supportAssignments)
      .innerJoin(supportTickets, eq(supportTickets.id, supportAssignments.ticketId)).innerJoin(issuer, eq(issuer.id, supportAssignments.assignedBy)).innerJoin(customer, eq(customer.id, supportTickets.operatorId))
      .where(and(activeAssignment(ctx), ticketListConditions(q))).orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id)).limit(51);
    return { tickets: rows.slice(0, 50).map(r => ({ ...ticketDto(r.ticket), permissions: { canReply: r.grant.canReply, canResolve: r.grant.canResolve, canNotes: r.grant.canNotes }, expiresAt: r.grant.expiresAt })), nextCursor: rows.length > 50 ? encodeCursor(rows[49]!.ticket) : null };
  });
  app.get<{ Params: { id: string } }>(`${base}/:id/assignments`, async req => {
    requireRoot(req.ctx!); const ticketId = parse(id, req.params.id), q = parse(z.object({ beforeId: id.optional() }).strict(), req.query);
    return db.orm.transaction(async orm => {
      await ticketContext(orm, req.ctx!, ticketId);
      const rows = await orm.select().from(supportAssignments).where(and(eq(supportAssignments.ticketId, ticketId), q.beforeId ? sql`${supportAssignments.id}<${q.beforeId}` : undefined)).orderBy(desc(supportAssignments.id)).limit(51);
      return { items: rows.slice(0, 50).map(assignmentDto), hasMore: rows.length > 50 };
    });
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/assignments`, async (req, reply) => {
    const ctx = req.ctx!; requireRoot(ctx); const ticketId = parse(id, req.params.id), b = valid(parse(permissions.extend({ email: z.string().email().max(254) }).strict(), req.body));
    await securityLimit(db, `support-assign:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      const { ticket } = await ticketContext(orm, ctx, ticketId);
      const [op] = await orm.select().from(operators).where(eq(operators.email, normalizeEmail(b.email)));
      if (!op || op.role !== 'operator' || op.status !== 'active' || !op.emailVerifiedAt || op.id === ticket.operatorId) throw new ApiError(400, '请选择已有且邮箱已验证的普通客服账号，不能选择工单客户本人');
      const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(supportAssignments).where(and(eq(supportAssignments.ticketId, ticket.id), isNull(supportAssignments.revokedAt), gt(supportAssignments.expiresAt, now())));
      if (count!.n >= 10) throw new ApiError(409, '同一工单最多 10 个有效客服授权');
      const [created] = await orm.insert(supportAssignments).values({ ticketId, operatorId: op.id, email: op.email, assignedBy: ctx.operatorId, canReply: b.canReply, canResolve: b.canResolve, canNotes: b.canNotes, expiresAt: toPgTimestamp(new Date(Date.now() + b.days * 86400000)) }).onConflictDoNothing().returning();
      if (!created) throw new ApiError(409, '该客服已有授权，请更新或先撤销');
      await writeAudit({ ...db, orm }, { actor: ctx.email, action: 'support.assign', payload: { ticketId, assignmentId: created.id, operatorId: op.id, canReply: b.canReply, canResolve: b.canResolve, canNotes: b.canNotes, days: b.days }, ok: true }); return created;
    }); return reply.code(201).send({ item: assignmentDto(item) });
  });
  app.post<{ Params: { id: string; assignment: string } }>(`${base}/:id/assignments/:assignment`, async req => {
    const ctx = req.ctx!; requireRoot(ctx); const ticketId = parse(id, req.params.id), assignmentId = parse(id, req.params.assignment), b = valid(parse(permissions.extend({ version: id }).strict(), req.body));
    return db.orm.transaction(async orm => {
      await ticketContext(orm, ctx, ticketId);
      const [a] = await orm.select().from(supportAssignments).where(and(eq(supportAssignments.id, assignmentId), eq(supportAssignments.ticketId, ticketId)));
      if (!a || a.revokedAt || a.version !== b.version) throw new ApiError(409, '授权不存在、已撤销或版本已更新');
      const [op] = await orm.select().from(operators).where(eq(operators.id, a.operatorId));
      if (!op?.emailVerifiedAt || op.status !== 'active' || op.role !== 'operator' || op.email !== a.email) throw new ApiError(409, '客服账号或邮箱已变化，请重新授权');
      if (a.expiresAt <= now()) { const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(supportAssignments).where(and(eq(supportAssignments.ticketId, ticketId), isNull(supportAssignments.revokedAt), gt(supportAssignments.expiresAt, now()))); if (count!.n >= 10) throw new ApiError(409, '同一工单最多 10 个有效客服授权'); }
      const [updated] = await orm.update(supportAssignments).set({ canReply: b.canReply, canResolve: b.canResolve, canNotes: b.canNotes, version: b.version + 1, assignedBy: ctx.operatorId, expiresAt: toPgTimestamp(new Date(Date.now() + b.days * 86400000)), updatedAt: now() }).where(eq(supportAssignments.id, a.id)).returning();
      await writeAudit({ ...db, orm }, { actor: ctx.email, action: 'support.assignment_update', payload: { ticketId, assignmentId, ...b }, ok: true }); return { item: assignmentDto(updated!) };
    });
  });
  app.delete<{ Params: { id: string; assignment: string } }>(`${base}/:id/assignments/:assignment`, async req => {
    requireRoot(req.ctx!); const ticketId = parse(id, req.params.id), assignmentId = parse(id, req.params.assignment);
    return db.orm.transaction(async orm => {
      await ticketContext(orm, req.ctx!, ticketId);
      const [a] = await orm.select().from(supportAssignments).where(and(eq(supportAssignments.id, assignmentId), eq(supportAssignments.ticketId, ticketId)));
      if (!a) throw new ApiError(404, '授权不存在');
      if (!a.revokedAt) await orm.update(supportAssignments).set({ revokedAt: now(), updatedAt: now(), version: a.version + 1 }).where(eq(supportAssignments.id, a.id));
      await writeAudit({ ...db, orm }, { actor: req.ctx!.email, action: 'support.assignment_revoke', payload: { ticketId, assignmentId }, ok: true }); return { ok: true };
    });
  });
  app.get<{ Params: { id: string } }>(`${base}/:id/notes`, async req => {
    const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query);
    return db.orm.transaction(async orm => {
      const c = await ticketContext(orm, req.ctx!, parse(id, req.params.id)); if (!c.canNotes) throw new ApiError(403, '无内部备注权限');
      const rows = await orm.select({ id: supportInternalNotes.id, body: supportInternalNotes.body, createdAt: supportInternalNotes.createdAt }).from(supportInternalNotes)
        .where(and(eq(supportInternalNotes.ticketId, c.ticket.id), q.beforeId ? sql`${supportInternalNotes.id}<${q.beforeId}` : undefined)).orderBy(desc(supportInternalNotes.id)).limit(51);
      return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
    });
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/notes`, async (req, reply) => {
    const ctx = req.ctx!, b = parse(z.object({ body: z.string().trim().min(1).max(5000) }).strict(), req.body); await securityLimit(db, `support-note:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      const c = await ticketContext(orm, ctx, parse(id, req.params.id)); if (!c.canNotes) throw new ApiError(403, '无内部备注权限');
      const [created] = await orm.insert(supportInternalNotes).values({ ticketId: c.ticket.id, actorId: ctx.operatorId, body: b.body }).returning();
      await writeAudit({ ...db, orm }, { actor: ctx.email, action: 'support.internal_note', payload: { ticketId: c.ticket.id, noteId: created!.id }, ok: true }); return { id: created!.id, body: created!.body, createdAt: created!.createdAt };
    }); return reply.code(201).send({ item });
  });
}
