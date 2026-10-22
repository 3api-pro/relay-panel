import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Orm } from '../db/client.js';
import { operators, sites, servicePartners, serviceWork, serviceAccess, serviceAssignments, serviceMessages } from '../db/schema.js';
import { ApiError, requireWrite, type SessionCtx } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { hashToken, toPgTimestamp } from '../auth/sessions.js';
import { securityLimit } from '../auth/security.js';
import { writeAudit } from '../audit.js';

export const collaborationRoles = {
  supplier: ['incident', 'billing_review', 'quote', 'settlement'],
  reseller: ['incident', 'quote', 'onboarding'],
  operations: ['incident', 'maintenance', 'upgrade', 'recovery', 'onboarding'],
  support: ['incident', 'onboarding'],
  finance: ['billing_review', 'quote', 'settlement'],
} as const;
type Role = keyof typeof collaborationRoles;
type Access = typeof serviceAccess.$inferSelect;
type Assignment = typeof serviceAssignments.$inferSelect;
const roleSchema = z.enum(['supplier', 'reseller', 'operations', 'support', 'finance']);
const statuses = z.enum(['open', 'in_progress', 'waiting', 'submitted', 'accepted', 'closed']);
const now = () => toPgTimestamp(new Date());
const positive = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ApiError(400, '请检查邮箱、身份、日期和必填内容');
  return r.data;
}
function accessDto(a: Access) {
  return { id: a.id, siteId: a.siteId, email: a.email, role: a.role, partnerId: a.partnerId,
    acceptedAt: a.acceptedAt, revokedAt: a.revokedAt, expiresAt: a.expiresAt, inviteExpiresAt: a.inviteExpiresAt, createdAt: a.createdAt };
}
// Deliberately excludes internal case identifiers, notes, evidence, costs and operator identities.
function assignmentDto(a: Assignment) {
  return { id: a.id, title: a.title, brief: a.brief, status: a.status, version: a.version, updatedAt: a.updatedAt, revokedAt: a.revokedAt };
}
function permits(role: string, kind: string): boolean {
  return Object.hasOwn(collaborationRoles, role) && (collaborationRoles[role as Role] as readonly string[]).includes(kind);
}

export async function ownedSite(orm: Orm, ctx: SessionCtx, id: number, lock = false) {
  requireWrite(ctx);
  if (ctx.teamRole || ctx.tenantOwnerId) throw new ApiError(403, '仅站点所有者或平台管理员可管理协作授权');
  const q = orm.select().from(sites).where(and(eq(sites.id, id), sql`${sites.status}<>'destroyed'`));
  const [site] = await (lock ? q.for('update') : q);
  if (!site || (ctx.role !== 'root' && site.operatorId !== ctx.operatorId)) throw new ApiError(404, '站点不存在');
  return site;
}
export async function accessContext(orm: Orm, ctx: SessionCtx, id: number, staff: boolean, lock = false, allowInactive = false) {
  const q = orm.select().from(serviceAccess).where(eq(serviceAccess.id, id));
  const [access] = await (lock ? q.for('update') : q);
  if (!access) throw new ApiError(404, '协作授权不存在');
  if (staff) await ownedSite(orm, ctx, access.siteId);
  else if (ctx.role !== 'operator' || access.operatorId !== ctx.operatorId || !access.acceptedAt || access.email !== normalizeEmail(ctx.email)) {
    throw new ApiError(404, '协作授权不存在');
  }
  const [site] = await orm.select().from(sites).where(eq(sites.id, access.siteId));
  const [owner] = await orm.select({ status: operators.status }).from(operators).where(eq(operators.id, access.ownerId));
  let partnerActive = true;
  if (access.partnerId) {
    const [partner] = await orm.select().from(servicePartners).where(eq(servicePartners.id, access.partnerId));
    partnerActive = !!partner && partner.siteId === access.siteId && partner.status === 'active';
  }
  const active = !access.revokedAt && access.expiresAt > now() && site?.status !== 'destroyed'
    && site?.operatorId === access.ownerId && owner?.status === 'active' && partnerActive;
  if (!active && !allowInactive) throw new ApiError(staff ? 409 : 404, '协作授权已撤销、到期或关联站点/伙伴已停用');
  return { access, site: site!, active };
}

export function registerCollaborationRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  const ownerBase = '/api/services/collaboration', memberBase = '/api/collaboration';
  const audit = (orm: Orm, ctx: SessionCtx, action: string, payload: Record<string, unknown>) =>
    writeAudit({ ...db, orm }, { actor: ctx.email, action: `collaboration.${action}`, payload, ok: true });

  async function assignmentContext(orm: Orm, ctx: SessionCtx, id: number, staff: boolean, lock = false) {
    const [first] = await orm.select({ accessId: serviceAssignments.accessId }).from(serviceAssignments).where(eq(serviceAssignments.id, id));
    if (!first) throw new ApiError(404, '协作事项不存在');
    // All mutations lock grant before assignment: revocation and replies serialize across processes.
    const grant = await accessContext(orm, ctx, first.accessId, staff, lock, staff && !lock);
    const q = orm.select().from(serviceAssignments).where(eq(serviceAssignments.id, id));
    const [item] = await (lock ? q.for('update') : q);
    if (!item || (item.revokedAt && (!staff || lock))) throw new ApiError(404, '协作事项不存在');
    const [work] = await orm.select().from(serviceWork).where(eq(serviceWork.id, item.workId));
    if (!work || work.siteId !== grant.access.siteId || !permits(grant.access.role, work.kind)) throw new ApiError(404, '协作事项不存在');
    return { ...grant, item, work };
  }

  app.get(`${ownerBase}/access`, async req => {
    const { siteId } = parse(z.object({ siteId: positive }), req.query);
    await ownedSite(db.orm, req.ctx!, siteId);
    const rows = await db.orm.select().from(serviceAccess).where(eq(serviceAccess.siteId, siteId)).orderBy(desc(serviceAccess.id)).limit(501);
    return { items: rows.slice(0, 500).map(accessDto), limited: rows.length > 500, roles: collaborationRoles };
  });
  app.post(`${ownerBase}/access`, async (req, reply) => {
    const ctx = req.ctx!;
    const b = parse(z.object({ siteId: positive, email: z.string().email().max(254), role: roleSchema,
      partnerId: positive.optional(), days: z.number().int().min(1).max(90).default(30) }).strict(), req.body);
    await ownedSite(db.orm, ctx, b.siteId);
    const email = normalizeEmail(b.email);
    if (email === normalizeEmail(ctx.email)) throw new ApiError(400, '请邀请其他账号');
    await securityLimit(db, `collaboration-invite:${ctx.operatorId}`, 30, 3600000);
    const token = randomBytes(32).toString('hex');
    const item = await db.orm.transaction(async orm => {
      const site = await ownedSite(orm, ctx, b.siteId, true);
      const [owner] = await orm.select().from(operators).where(eq(operators.id, site.operatorId));
      if (owner?.status !== 'active' || owner.email === email) throw new ApiError(400, '站点账号不可用或无需邀请所有者');
      if (['supplier', 'reseller'].includes(b.role) && !b.partnerId) throw new ApiError(400, '请关联本站点的对应合作伙伴');
      if (b.partnerId) {
        const [p] = await orm.select().from(servicePartners).where(eq(servicePartners.id, b.partnerId));
        const expected = b.role === 'operations' ? 'operator' : b.role;
        if (!p || p.siteId !== b.siteId || p.status !== 'active' || p.kind !== expected) throw new ApiError(400, '合作伙伴与站点或协作身份不匹配');
      }
      const [existing] = await orm.select({ id: serviceAccess.id }).from(serviceAccess)
        .where(and(eq(serviceAccess.siteId, b.siteId), eq(serviceAccess.email, email), isNull(serviceAccess.revokedAt)));
      if (existing) throw new ApiError(409, '此邮箱已有授权，请先撤销旧授权再重新邀请');
      const expiresAt = toPgTimestamp(new Date(Date.now() + b.days * 86400000));
      const [created] = await orm.insert(serviceAccess).values({ siteId: b.siteId, ownerId: site.operatorId, email, role: b.role,
        partnerId: b.partnerId ?? null, inviteTokenHash: hashToken(token),
        inviteExpiresAt: toPgTimestamp(new Date(Date.now() + Math.min(b.days, 7) * 86400000)), expiresAt }).returning();
      await audit(orm, ctx, 'invite', { id: created!.id, siteId: b.siteId, role: b.role });
      return created!;
    });
    return reply.code(201).send({ item: accessDto(item), token });
  });
  app.delete<{ Params: { id: string } }>(`${ownerBase}/access/:id`, async req => {
    await db.orm.transaction(async orm => {
      const { access } = await accessContext(orm, req.ctx!, parse(positive, req.params.id), true, true, true);
      await orm.update(serviceAccess).set({ revokedAt: access.revokedAt ?? now() }).where(eq(serviceAccess.id, access.id));
      await audit(orm, req.ctx!, 'revoke', { id: access.id });
    });
    return { ok: true };
  });

  app.post(`${memberBase}/accept`, async req => {
    const ctx = req.ctx!;
    if (ctx.role !== 'operator') throw new ApiError(403, '请使用受邀的普通用户账号');
    const { token } = parse(z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), req.body);
    await securityLimit(db, `collaboration-accept:${ctx.operatorId}`, 20, 3600000);
    return db.orm.transaction(async orm => {
      const [op] = await orm.select().from(operators).where(eq(operators.id, ctx.operatorId));
      if (!op?.emailVerifiedAt) throw new ApiError(403, '请先在账号安全中验证受邀邮箱');
      const [a] = await orm.select().from(serviceAccess).where(and(eq(serviceAccess.inviteTokenHash, hashToken(token)),
        eq(serviceAccess.email, normalizeEmail(ctx.email)), isNull(serviceAccess.acceptedAt), isNull(serviceAccess.revokedAt),
        gt(serviceAccess.inviteExpiresAt, now()), gt(serviceAccess.expiresAt, now()))).for('update');
      if (!a) throw new ApiError(400, '邀请无效、已使用、已过期或不属于当前邮箱');
      const [site] = await orm.select().from(sites).where(eq(sites.id, a.siteId));
      const [owner] = await orm.select().from(operators).where(eq(operators.id, a.ownerId));
      if (!site || site.status === 'destroyed' || site.operatorId !== a.ownerId || owner?.status !== 'active') throw new ApiError(400, '站点授权已失效');
      if (a.partnerId) {
        const [p] = await orm.select().from(servicePartners).where(eq(servicePartners.id, a.partnerId));
        if (!p || p.siteId !== a.siteId || p.status !== 'active') throw new ApiError(400, '合作伙伴已停用');
      }
      await orm.update(serviceAccess).set({ operatorId: ctx.operatorId, acceptedAt: now() }).where(eq(serviceAccess.id, a.id));
      await audit(orm, ctx, 'accept', { id: a.id });
      return { ok: true };
    });
  });

  app.get(`${ownerBase}/assignments`, async req => {
    const q = parse(z.object({ siteId: positive, beforeId: positive.optional() }), req.query);
    await ownedSite(db.orm, req.ctx!, q.siteId);
    const rows = await db.orm.select({ item: serviceAssignments, email: serviceAccess.email, role: serviceAccess.role })
      .from(serviceAssignments).innerJoin(serviceAccess, eq(serviceAccess.id, serviceAssignments.accessId))
      .where(and(eq(serviceAccess.siteId, q.siteId), q.beforeId ? sql`${serviceAssignments.id}<${q.beforeId}` : undefined))
      .orderBy(desc(serviceAssignments.id)).limit(101);
    return { items: rows.slice(0, 100).map(r => ({ ...assignmentDto(r.item), accessId: r.item.accessId, workId: r.item.workId, email: r.email, role: r.role })), hasMore: rows.length > 100 };
  });
  app.post(`${ownerBase}/assignments`, async (req, reply) => {
    const ctx = req.ctx!;
    const b = parse(z.object({ accessId: positive, workId: positive, title: z.string().trim().min(3).max(160), brief: z.string().trim().min(5).max(4000) }).strict(), req.body);
    await securityLimit(db, `collaboration-share:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      const { access } = await accessContext(orm, ctx, b.accessId, true, true);
      const [work] = await orm.select().from(serviceWork).where(eq(serviceWork.id, b.workId));
      if (!work || work.siteId !== access.siteId || !permits(access.role, work.kind)) throw new ApiError(400, '事项不属于该站点或超出此身份范围');
      if (access.partnerId && work.partnerId !== access.partnerId) throw new ApiError(400, '事项必须关联受邀的同一合作伙伴');
      const [created] = await orm.insert(serviceAssignments).values(b).onConflictDoNothing().returning();
      if (!created) throw new ApiError(409, '此事项已经分配；撤销后请重新授权再分配');
      await orm.insert(serviceMessages).values({ assignmentId: created.id, actorId: ctx.operatorId, staff: true, body: '协作事项已共享', status: 'open' });
      await audit(orm, ctx, 'share', { id: created.id, accessId: access.id, workId: work.id });
      return created;
    });
    return reply.code(201).send({ item: assignmentDto(item) });
  });

  app.get(`${memberBase}/assignments`, async req => {
    const ctx = req.ctx!, q = parse(z.object({ beforeId: positive.optional() }), req.query);
    if (ctx.role !== 'operator') return { items: [], hasMore: false };
    // Filters apply before pagination, so revoked grants cannot hide later accessible cases.
    const rows = await db.orm.select({ item: serviceAssignments, role: serviceAccess.role, kind: serviceWork.kind })
      .from(serviceAssignments).innerJoin(serviceAccess, eq(serviceAccess.id, serviceAssignments.accessId))
      .innerJoin(sites, eq(sites.id, serviceAccess.siteId)).innerJoin(operators, eq(operators.id, serviceAccess.ownerId))
      .innerJoin(serviceWork, eq(serviceWork.id, serviceAssignments.workId))
      .leftJoin(servicePartners, eq(servicePartners.id, serviceAccess.partnerId))
      .where(and(eq(serviceAccess.operatorId, ctx.operatorId), eq(serviceAccess.email, normalizeEmail(ctx.email)),
        isNull(serviceAccess.revokedAt), gt(serviceAccess.expiresAt, now()), isNull(serviceAssignments.revokedAt),
        eq(sites.operatorId, serviceAccess.ownerId), sql`${sites.status}<>'destroyed'`, eq(operators.status, 'active'),
        sql`(${serviceAccess.partnerId} IS NULL OR (${servicePartners.status}='active' AND ${servicePartners.siteId}=${sites.id}))`,
        q.beforeId ? sql`${serviceAssignments.id}<${q.beforeId}` : undefined)).orderBy(desc(serviceAssignments.id)).limit(101);
    return { items: rows.slice(0, 100).filter(r => permits(r.role, r.kind)).map(r => ({ ...assignmentDto(r.item), role: r.role, kind: r.kind })), hasMore: rows.length > 100 };
  });

  for (const staff of [true, false]) {
    const base = staff ? ownerBase : memberBase;
    app.get<{ Params: { id: string } }>(`${base}/assignments/:id`, async req => {
      const { item, access, work, active } = await assignmentContext(db.orm, req.ctx!, parse(positive, req.params.id), staff);
      const q = parse(z.object({ beforeId: positive.optional() }), req.query);
      const rows = await db.orm.select({ id: serviceMessages.id, staff: serviceMessages.staff, body: serviceMessages.body,
        status: serviceMessages.status, createdAt: serviceMessages.createdAt }).from(serviceMessages)
        .where(and(eq(serviceMessages.assignmentId, item.id), q.beforeId ? sql`${serviceMessages.id}<${q.beforeId}` : undefined))
        .orderBy(desc(serviceMessages.id)).limit(101);
      return { item: { ...assignmentDto(item), role: access.role, kind: work.kind }, active: active && !item.revokedAt,
        messages: rows.slice(0, 100), hasMore: rows.length > 100 };
    });
    app.post<{ Params: { id: string } }>(`${base}/assignments/:id/messages`, async req => {
      const ctx = req.ctx!; requireWrite(ctx);
      const b = parse(z.object({ version: positive, status: statuses, body: z.string().trim().min(5).max(4000) }).strict(), req.body);
      await securityLimit(db, `collaboration-message:${ctx.operatorId}`, 120, 3600000);
      const item = await db.orm.transaction(async orm => {
        const { item } = await assignmentContext(orm, ctx, parse(positive, req.params.id), staff, true);
        if (item.version !== b.version) throw new ApiError(409, '事项已更新，请刷新后重试');
        const transitions: Record<string, string[]> = staff ? {
          open: ['open','in_progress','waiting'], in_progress: ['in_progress','waiting'], waiting: ['waiting','in_progress'],
          submitted: ['submitted','in_progress','waiting','accepted'], accepted: ['accepted','closed','in_progress'], closed: ['closed','in_progress'],
        } : {
          open: ['open','in_progress','waiting','submitted'], in_progress: ['in_progress','waiting','submitted'],
          waiting: ['waiting','in_progress','submitted'], submitted: ['submitted'], accepted: [], closed: [],
        };
        if (!transitions[item.status]?.includes(b.status)) throw new ApiError(409, '状态转换不允许；结果须由站点方复核');
        const [updated] = await orm.update(serviceAssignments).set({ status: b.status, version: item.version + 1, updatedAt: now() })
          .where(eq(serviceAssignments.id, item.id)).returning();
        await orm.insert(serviceMessages).values({ assignmentId: item.id, actorId: ctx.operatorId, staff, body: b.body, status: b.status });
        await audit(orm, ctx, 'message', { id: item.id, status: b.status, staff });
        return updated!;
      });
      return { item: assignmentDto(item) };
    });
  }
  app.delete<{ Params: { id: string } }>(`${ownerBase}/assignments/:id`, async req => {
    await db.orm.transaction(async orm => {
      const { item } = await assignmentContext(orm, req.ctx!, parse(positive, req.params.id), true, true);
      await orm.update(serviceAssignments).set({ revokedAt: now(), version: item.version + 1, updatedAt: now() }).where(eq(serviceAssignments.id, item.id));
      await audit(orm, req.ctx!, 'unshare', { id: item.id });
    });
    return { ok: true };
  });
}
