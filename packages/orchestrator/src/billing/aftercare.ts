import { and, asc, desc, eq, inArray, gte, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { paymentOrders, refundRequests, subscriptions } from '../db/schema.js';
import { ApiError, requireRoot, requireWrite } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { withBillingTransaction } from './transaction.js';
import { writeAudit } from '../audit.js';
import { queueNotification } from '../notifications/service.js';
import { paymentCents } from './payments/types.js';

function ctx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  if (!req.ctx) throw new ApiError(401, '请登录');
  return req.ctx;
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, '请检查退款金额、原因及操作参数');
  return r.data;
}
/** Spreadsheet formula injection is neutralized for human-authored fields. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}

export function registerAftercareRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
  app.get('/api/billing/refunds', async req => {
    const actor = ctx(req);
    if (actor.role === 'viewer') throw new ApiError(403, '仅账号所有者可查看退款');
    const rows = await db.orm.select({ refund: refundRequests, orderNo: paymentOrders.orderNo, providerKey: paymentOrders.providerKey })
      .from(refundRequests).innerJoin(paymentOrders, eq(paymentOrders.id, refundRequests.orderId))
      .where(actor.role === 'root' ? undefined : eq(refundRequests.operatorId, actor.operatorId))
      .orderBy(desc(refundRequests.id)).limit(200);
    return { refunds: rows.map(x => ({ ...x.refund, orderNo: x.orderNo, providerKey: x.providerKey })) };
  });
  app.post<{ Params: { orderNo: string } }>('/api/billing/orders/:orderNo/refunds', async (req, reply) => {
    const actor = ctx(req); requireWrite(actor);
    const body = parse(z.object({ amount: z.number().positive().refine(x => Number.isFinite(paymentCents(x))), reason: z.string().trim().min(3).max(1000) }), req.body);
    const [order] = await db.orm.select().from(paymentOrders).where(eq(paymentOrders.orderNo, req.params.orderNo));
    if (!order || (actor.role !== 'root' && order.operatorId !== actor.operatorId)) throw new ApiError(404, '订单不存在');
    const refund = await withBillingTransaction(db, order.operatorId, async tx => {
      const [fresh] = await tx.orm.select().from(paymentOrders).where(eq(paymentOrders.id, order.id));
      if (!fresh || !['paid', 'completed'].includes(fresh.status)) throw new ApiError(409, '仅已付款订单可申请退款');
      const allocated = await tx.orm.select().from(refundRequests).where(and(eq(refundRequests.orderId, fresh.id),
        inArray(refundRequests.status, ['requested', 'approved', 'completed'])));
      const used = allocated.reduce((sum, item) => sum + paymentCents(item.amount), 0);
      if (used + paymentCents(body.amount) > paymentCents(fresh.amount)) throw new ApiError(409, '退款及在途申请总额超过可退金额');
      const [created] = await tx.orm.insert(refundRequests).values({ operatorId: fresh.operatorId, orderId: fresh.id, amount: body.amount, reason: body.reason }).returning();
      await writeAudit(tx, { actor: actor.email, action: 'refund.request', payload: { refundId: created!.id, orderNo: fresh.orderNo, amount: body.amount }, ok: true });
      return created;
    });
    return reply.code(201).send({ refund });
  });
  app.patch<{ Params: { id: string } }>('/api/billing/refunds/:id', async req => {
    const actor = ctx(req); requireWrite(actor);
    const body = parse(z.object({ version: z.number().int().positive(), action: z.enum(['approve', 'reject', 'complete', 'cancel']),
      note: z.string().trim().min(3).max(2000), receipt: z.string().trim().min(3).max(200).optional(),
      entitlement: z.enum(['keep', 'cancel_pending', 'end_subscription']).optional(),
      subscriptionVersion: z.string().optional(),
    }), req.body);
    if (body.action !== 'cancel') requireRoot(actor);
    const [refund] = await db.orm.select().from(refundRequests).where(eq(refundRequests.id, Number(req.params.id)));
    if (!refund || (actor.role !== 'root' && refund.operatorId !== actor.operatorId)) throw new ApiError(404, '退款申请不存在');
    return withBillingTransaction(db, refund.operatorId, async tx => {
      const [fresh] = await tx.orm.select().from(refundRequests).where(eq(refundRequests.id, refund.id));
      if (!fresh || fresh.version !== body.version) throw new ApiError(409, '退款申请已变化，请刷新后重试');
      const allowed = body.action === 'complete' ? ['approved'] : ['requested'];
      if (!allowed.includes(fresh.status)) throw new ApiError(409, '退款状态不允许此操作');
      const [order] = await tx.orm.select().from(paymentOrders).where(eq(paymentOrders.id, fresh.orderId));
      if (!order) throw new ApiError(404, '订单不存在');
      if (body.action === 'complete') {
        if (!body.receipt || !body.entitlement) throw new ApiError(400, '请填写已核实的渠道退款流水及权益处理方式');
        const [duplicate] = await tx.orm.select().from(refundRequests).where(eq(refundRequests.receipt, `${order.providerKey}:${body.receipt}`));
        if (duplicate) throw new ApiError(409, '该渠道退款流水已登记');
        const subs = await tx.orm.select().from(subscriptions).where(and(eq(subscriptions.operatorId, fresh.operatorId), eq(subscriptions.status, 'active')));
        if (body.entitlement === 'cancel_pending') {
          const target = subs.find(s => s.pendingChange?.orderNo === order.orderNo);
          if (!target) throw new ApiError(409, '未找到此订单对应的待生效套餐，请重新核对权益');
          await tx.orm.update(subscriptions).set({ pendingChange: null, updatedAt: toPgTimestamp(new Date()) }).where(eq(subscriptions.id, target.id));
        } else if (body.entitlement === 'end_subscription') {
          // Version from the explicit preview protects newer renewals from accidental termination.
          if (subs.length !== 1 || body.subscriptionVersion !== `${subs[0]!.id}:${subs[0]!.updatedAt}`) throw new ApiError(409, '请先预览当前订阅并确认版本');
          if (subs[0]!.pendingChange) throw new ApiError(409, '存在待生效套餐，须先核对该订单权益');
          await tx.orm.update(subscriptions).set({ status: 'cancelled', updatedAt: toPgTimestamp(new Date()) }).where(eq(subscriptions.id, subs[0]!.id));
        }
        // Prevent a paid-but-unfulfilled order from being granted after its refund.
        if (order.status === 'paid') {
          if (paymentCents(fresh.amount) !== paymentCents(order.amount)) throw new ApiError(409, '未开通订单请全额退款，部分退款需先完成权益核对');
          await tx.orm.update(paymentOrders).set({ status: 'refunded', reconciliationError: null, updatedAt: toPgTimestamp(new Date()) }).where(eq(paymentOrders.id, order.id));
        }
      }
      const status = ({ approve: 'approved', reject: 'rejected', complete: 'completed', cancel: 'cancelled' })[body.action];
      const [updated] = await tx.orm.update(refundRequests).set({ status, version: fresh.version + 1, note: body.note,
        reviewedBy: actor.email, updatedAt: toPgTimestamp(new Date()),
        ...(body.action === 'complete' ? { receipt: `${order.providerKey}:${body.receipt}`, entitlement: body.entitlement! } : {}),
      }).where(eq(refundRequests.id, fresh.id)).returning();
      await writeAudit(tx, { actor: actor.email, action: `refund.${body.action}`, payload: { refundId: fresh.id, orderNo: order.orderNo,
        amount: fresh.amount, note: body.note, entitlement: body.entitlement ?? null, receipt: body.receipt ?? null }, ok: true });
      await queueNotification(tx, config, { operatorId: fresh.operatorId, category: 'billing', key: `refund:${fresh.id}:${fresh.version + 1}`,
        subject: '退款申请状态更新', body: `订单 ${order.orderNo}，退款金额 CNY ${fresh.amount.toFixed(2)}，状态 ${status}。${body.note}` });
      return { refund: updated };
    });
  });

  app.get<{ Params: { id: string } }>('/api/billing/refunds/:id/preview', async req => {
    requireRoot(ctx(req));
    const [refund] = await db.orm.select().from(refundRequests).where(eq(refundRequests.id, Number(req.params.id)));
    if (!refund) throw new ApiError(404, '申请不存在');
    const subs = await db.orm.select().from(subscriptions).where(and(eq(subscriptions.operatorId, refund.operatorId), eq(subscriptions.status, 'active')));
    return { subscriptions: subs.map(s => ({ id: s.id, planKey: s.planKey, currentPeriodEnd: s.currentPeriodEnd,
      pendingChange: s.pendingChange, version: `${s.id}:${s.updatedAt}` })) };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/billing/statement.csv', async (req, reply) => {
    const actor = ctx(req);
    if (actor.role === 'viewer') throw new ApiError(403, '仅账号所有者可下载账单');
    const filters = actor.role === 'root' ? [] : [eq(paymentOrders.operatorId, actor.operatorId)];
    const range = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).refine(x => !x.from || !x.to || Date.parse(x.from) < Date.parse(x.to)).safeParse(req.query);
    if (!range.success) throw new ApiError(400, '账单日期必须为带时区的 ISO 时间，截止时间不含在内');
    if (range.data.from) filters.push(gte(paymentOrders.createdAt, toPgTimestamp(new Date(range.data.from))));
    if (range.data.to) filters.push(lt(paymentOrders.createdAt, toPgTimestamp(new Date(range.data.to))));
    const rows = await db.orm.select().from(paymentOrders).where(and(...filters)).orderBy(asc(paymentOrders.id)).limit(10_001);
    if (rows.length > 10_000) throw new ApiError(413, '账单过大，请联系管理员分批导出');
    const refunds = await db.orm.select().from(refundRequests).where(and(eq(refundRequests.status, 'completed'),
      actor.role === 'root' ? undefined : eq(refundRequests.operatorId, actor.operatorId)));
    const totals = new Map<number, number>();
    for (const r of refunds) totals.set(r.orderId, (totals.get(r.orderId) ?? 0) + paymentCents(r.amount));
    const content = [['Order', 'Account ID', 'Plan', 'Currency', 'Amount', 'Confirmed refunds', 'Status', 'Paid at', 'Created at'],
      ...rows.map(o => [o.orderNo, o.operatorId, o.planKey, 'CNY', o.amount.toFixed(2), ((totals.get(o.id) ?? 0) / 100).toFixed(2), o.status, o.paidAt, o.createdAt])]
      .map(row => row.map(csvCell).join(',')).join('\r\n');
    await writeAudit(db, { actor: actor.email, action: 'billing.statement.export', payload: { rows: rows.length }, ok: true });
    return reply.header('Content-Disposition', 'attachment; filename="billing-statement.csv"').type('text/csv; charset=utf-8').send('\ufeff' + content);
  });
}
