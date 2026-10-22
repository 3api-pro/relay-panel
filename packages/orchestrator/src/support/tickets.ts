import { and, asc, desc, eq } from 'drizzle-orm';
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
import { queueNotification } from '../notifications/service.js';

export function registerTicketRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
  app.get('/api/support/tickets', async req => {
    const ctx = req.ctx!;
    if (ctx.role === 'viewer') throw new ApiError(403, '只读角色无工单权限');
    return { tickets: await db.orm.select().from(supportTickets).where(ctx.role === 'root' ? undefined : eq(supportTickets.operatorId, ctx.operatorId))
      .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id)).limit(200) };
  });
  app.post('/api/support/tickets', async (req, reply) => {
    const ctx = req.ctx!; requireWrite(ctx);
    const body = z.object({ subject: z.string().trim().min(3).max(120), body: z.string().trim().min(5).max(5000) }).safeParse(req.body);
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
    const ctx = req.ctx!;
    const [ticket] = await db.orm.select().from(supportTickets).where(and(eq(supportTickets.id, Number(req.params.id)),
      ctx.role === 'root' ? undefined : eq(supportTickets.operatorId, ctx.operatorId)));
    if (!ticket || ctx.role === 'viewer') throw new ApiError(404, '工单不存在');
    const messages = await db.orm.select({ id: supportMessages.id, body: supportMessages.body, staff: supportMessages.staff, createdAt: supportMessages.createdAt })
      .from(supportMessages).where(eq(supportMessages.ticketId, ticket.id)).orderBy(asc(supportMessages.id)).limit(500);
    return { ticket, messages };
  });
  app.post<{ Params: { id: string } }>('/api/support/tickets/:id/messages', async req => {
    const ctx = req.ctx!; requireWrite(ctx);
    const parsed = z.object({ version: z.number().int().positive(), body: z.string().trim().min(1).max(5000),
      status: z.enum(['open', 'waiting_customer', 'resolved']).optional() }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, '请填写回复内容');
    const body = parsed.data;
    if (body.status === 'waiting_customer' && ctx.role !== 'root') throw new ApiError(403, '仅管理员可设置等待客户回复');
    const [ticket] = await db.orm.select().from(supportTickets).where(and(eq(supportTickets.id, Number(req.params.id)),
      ctx.role === 'root' ? undefined : eq(supportTickets.operatorId, ctx.operatorId)));
    if (!ticket) throw new ApiError(404, '工单不存在');
    await securityLimit(db, `ticket-reply:${ctx.operatorId}`, 60, 3_600_000);
    return withBillingTransaction(db, ticket.operatorId, async tx => {
      const [updated] = await tx.orm.update(supportTickets).set({ status: body.status ?? (ctx.role === 'root' ? 'waiting_customer' : 'open'),
        version: body.version + 1, updatedAt: toPgTimestamp(new Date()),
      }).where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.version, body.version))).returning();
      if (!updated) throw new ApiError(409, '工单已有新回复，请刷新后重试');
      await tx.orm.insert(supportMessages).values({ ticketId: ticket.id, actorId: ctx.operatorId, staff: ctx.role === 'root', body: body.body });
      await writeAudit(tx, { actor: ctx.email, action: 'support.reply', payload: { ticketId: ticket.id, status: updated.status }, ok: true });
      const recipients = ctx.role === 'root' ? [{ id: ticket.operatorId }]
        : await tx.orm.select({ id: operators.id }).from(operators).where(and(eq(operators.role, 'root'), eq(operators.status, 'active')));
      for (const recipient of recipients) await queueNotification(tx, config, { operatorId: recipient.id, category: 'support',
        key: `ticket:${ticket.id}:${updated.version}:${recipient.id}`, subject: '支持工单有新回复', body: `工单 #${ticket.id}：${ticket.subject}。请登录面板查看回复。` });
      return { ticket: updated };
    });
  });
}
