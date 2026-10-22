import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { operators, supportMessages, supportTickets } from '../db/schema.js';
import { ApiError, requireWrite } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { withBillingTransaction } from '../billing/transaction.js';
import { writeAudit } from '../audit.js';
import { activeAssignees, encodeCursor, supportParse, ticketContext, ticketDto, ticketId } from './access.js';
import { registerSupportAssignmentRoutes, ticketListInput, ticketListConditions } from './assignments.js';
import { queueNotification } from '../notifications/service.js';

export function registerTicketRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
  registerSupportAssignmentRoutes(app, { db });
  app.get('/api/support/tickets', async req => {
    const ctx = req.ctx!;
    if (ctx.role === 'viewer') throw new ApiError(403, '只读角色无工单权限');
    const q = supportParse(ticketListInput, req.query);
    const rows = await db.orm.select().from(supportTickets).where(and(ctx.role === 'root' ? undefined : eq(supportTickets.operatorId, ctx.operatorId), ticketListConditions(q)))
      .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id)).limit(51);
    return { tickets: rows.slice(0, 50).map(ticketDto), nextCursor: rows.length > 50 ? encodeCursor(rows[49]!) : null };
  });
  app.post('/api/support/tickets', async (req, reply) => {
    const ctx = req.ctx!; requireWrite(ctx);
    const body = z.object({ subject: z.string().trim().min(3).max(120), body: z.string().trim().min(5).max(5000) }).strict().safeParse(req.body);
    if (!body.success) throw new ApiError(400, '请填写标题和问题描述');
    await securityLimit(db, `tickets:${ctx.operatorId}`, 10, 3_600_000);
    const ticket = await withBillingTransaction(db, ctx.operatorId, async tx => {
      const [created] = await tx.orm.insert(supportTickets).values({ operatorId: ctx.operatorId, subject: body.data.subject }).returning();
      await tx.orm.insert(supportMessages).values({ ticketId: created!.id, actorId: ctx.operatorId, body: body.data.body, staff: ctx.role === 'root' });
      await writeAudit(tx, { actor: ctx.email, action: 'support.create', payload: { ticketId: created!.id }, ok: true });
      const roots = await tx.orm.select({ id: operators.id }).from(operators).where(and(eq(operators.role, 'root'), eq(operators.status, 'active')));
      for (const root of roots) await queueNotification(tx, config, { operatorId: root.id, category: 'support', key: `ticket:${created!.id}:new:${root.id}`,
        subject: '收到新的支持工单', body: `工单 #${created!.id}：${body.data.subject}。请在管理面板查看。` });
      return created;
    });
    return reply.code(201).send({ ticket });
  });
  app.get<{ Params: { id: string } }>('/api/support/tickets/:id', async req => {
    const q = supportParse(z.object({ beforeId: ticketId.optional() }).strict(), req.query);
    return db.orm.transaction(async orm => {
      const c = await ticketContext(orm, req.ctx!, supportParse(ticketId, req.params.id));
      const rows = await orm.select({ id: supportMessages.id, body: supportMessages.body, staff: supportMessages.staff, createdAt: supportMessages.createdAt })
        .from(supportMessages).where(and(eq(supportMessages.ticketId, c.ticket.id), q.beforeId ? sql`${supportMessages.id}<${q.beforeId}` : undefined)).orderBy(desc(supportMessages.id)).limit(101);
      return { ticket: ticketDto(c.ticket), messages: rows.slice(0, 100).reverse(), hasMore: rows.length > 100,
        permissions: { staff: c.staff, canReply: c.canReply, canResolve: c.canResolve, canNotes: c.canNotes, canAssign: req.ctx!.role === 'root' }, expiresAt: c.assignment?.expiresAt ?? null };
    });
  });
  app.post<{ Params: { id: string } }>('/api/support/tickets/:id/messages', async req => {
    const ctx = req.ctx!; requireWrite(ctx);
    const body = supportParse(z.object({ version: z.number().int().positive(), body: z.string().trim().min(1).max(5000),
      status: z.enum(['open', 'waiting_customer', 'resolved']).optional() }).strict(), req.body);
    await securityLimit(db, `ticket-reply:${ctx.operatorId}`, 60, 3_600_000);
    return db.orm.transaction(async orm => {
      const c = await ticketContext(orm, ctx, supportParse(ticketId, req.params.id)), ticket = c.ticket, tx = { ...db, orm };
      if (!c.canReply) throw new ApiError(403, '当前工单授权只允许阅读');
      if (body.status === 'resolved' && !c.canResolve) throw new ApiError(403, '当前授权不允许结单');
      if (body.status === 'waiting_customer' && !c.staff) throw new ApiError(403, '仅客服可设置等待客户回复');
      // Reopening a resolved case is also a resolution action for delegated staff.
      if (ticket.status === 'resolved' && c.staff && !c.canResolve) throw new ApiError(403, '当前授权不允许重新打开已结单工单');
      if (ticket.version !== body.version) throw new ApiError(409, '工单已有新回复，请刷新后重试');
      const [updated] = await orm.update(supportTickets).set({ status: body.status ?? (c.staff ? 'waiting_customer' : 'open'), version: body.version + 1, updatedAt: toPgTimestamp(new Date()) })
        .where(eq(supportTickets.id, ticket.id)).returning();
      await orm.insert(supportMessages).values({ ticketId: ticket.id, actorId: ctx.operatorId, staff: c.staff, body: body.body });
      await writeAudit(tx, { actor: ctx.email, action: 'support.reply', payload: { ticketId: ticket.id, status: updated!.status, ...(c.assignment ? { assignmentId: c.assignment.id } : {}) }, ok: true });
      const roots = await orm.select({ id: operators.id }).from(operators).where(and(eq(operators.role, 'root'), eq(operators.status, 'active')));
      const recipients = new Map<number, string | undefined>();
      if (c.staff) recipients.set(ticket.operatorId, undefined);
      if (ctx.role !== 'root') for (const root of roots) recipients.set(root.id, undefined);
      for (const a of await activeAssignees(orm, ticket.id)) recipients.set(a.id, a.expiresAt);
      recipients.delete(ctx.operatorId);
      for (const [recipient, expiresAt] of recipients) await queueNotification(tx, config, { operatorId: recipient, category: 'support', ...(expiresAt ? { expiresAt } : {}),
        key: `ticket:${ticket.id}:${updated!.version}:${recipient}`, subject: '支持工单有新回复', body: `工单 #${ticket.id} 有新回复，请登录面板查看。` });
      return { ticket: ticketDto(updated!) };
    });
  });
}
