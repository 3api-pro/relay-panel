import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { organizations, organizationMembers, organizationInvites, operators } from '../db/schema.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { securityLimit } from '../auth/security.js';
import { hashToken, toPgTimestamp } from '../auth/sessions.js';
import { withBillingTransaction } from '../billing/transaction.js';
import { writeAudit } from '../audit.js';

/** Selected workspaces never alter the authenticated identity or platform role. */
export async function resolveWorkspace(db: Db, ctx: SessionCtx, header: string | string[] | undefined): Promise<SessionCtx> {
  if (!header || header === String(ctx.operatorId)) return ctx;
  const id = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : NaN;
  if (!Number.isSafeInteger(id) || ctx.role !== 'operator') throw new ApiError(403, '工作区不可访问');
  const [member] = await db.orm.select({ role: organizationMembers.role }).from(organizationMembers)
    .innerJoin(operators, eq(operators.id, organizationMembers.ownerId))
    .where(and(eq(organizationMembers.ownerId, id), eq(organizationMembers.operatorId, ctx.operatorId), eq(operators.status, 'active')));
  if (!member || !['reader', 'editor'].includes(member.role)) throw new ApiError(403, '工作区不可访问，请切回个人工作区');
  return { ...ctx, tenantOwnerId: id, teamRole: member.role as 'reader' | 'editor' };
}

export function registerTeamRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  const writable = (ctx: SessionCtx): void => { if (ctx.role === 'viewer') throw new ApiError(403, '平台观察员不能管理团队'); };
  app.get('/api/team/workspaces', async req => {
    const ctx = req.ctx!;
    const memberships = await db.orm.select({ ownerId: organizations.ownerId, name: organizations.name, role: organizationMembers.role })
      .from(organizationMembers).innerJoin(organizations, eq(organizationMembers.ownerId, organizations.ownerId))
      .innerJoin(operators, eq(operators.id, organizations.ownerId))
      .where(and(eq(organizationMembers.operatorId, ctx.operatorId), eq(operators.status, 'active')));
    const [own] = await db.orm.select().from(organizations).where(eq(organizations.ownerId, ctx.operatorId));
    return { workspaces: [{ ownerId: ctx.operatorId, name: own?.name ?? '个人工作区', role: 'owner' }, ...(ctx.role === 'operator' ? memberships : [])] };
  });
  app.put('/api/team', async req => {
    const ctx = req.ctx!; writable(ctx);
    const body = z.object({ name: z.string().trim().min(1).max(64) }).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '请输入团队名称');
    await db.orm.insert(organizations).values({ ownerId: ctx.operatorId, name: body.data.name })
      .onConflictDoUpdate({ target: organizations.ownerId, set: { name: body.data.name } });
    await writeAudit(db, { actor: ctx.email, action: 'team.update', payload: { ownerId: ctx.operatorId }, ok: true });
    return { ok: true };
  });
  app.get('/api/team', async req => {
    const ctx = req.ctx!; writable(ctx);
    const [organization] = await db.orm.select().from(organizations).where(eq(organizations.ownerId, ctx.operatorId));
    const members = await db.orm.select({ id: organizationMembers.id, email: operators.email, displayName: operators.displayName, role: organizationMembers.role })
      .from(organizationMembers).innerJoin(operators, eq(operators.id, organizationMembers.operatorId)).where(eq(organizationMembers.ownerId, ctx.operatorId));
    const invites = await db.orm.select({ id: organizationInvites.id, email: organizationInvites.email, role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt, usedAt: organizationInvites.usedAt, revokedAt: organizationInvites.revokedAt })
      .from(organizationInvites).where(eq(organizationInvites.ownerId, ctx.operatorId)).orderBy(desc(organizationInvites.id)).limit(100);
    return { organization: organization ?? null, members, invites };
  });
  app.post('/api/team/invites', async (req, reply) => {
    const ctx = req.ctx!; writable(ctx);
    const body = z.object({ email: z.string().email(), role: z.enum(['reader', 'editor']) }).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '邮箱或团队角色无效');
    const email = normalizeEmail(body.data.email);
    if (email === normalizeEmail(ctx.email)) throw new ApiError(400, '不能邀请自己');
    await securityLimit(db, `team-invite:${ctx.operatorId}`, 20, 3_600_000);
    const token = randomBytes(32).toString('hex');
    const invite = await withBillingTransaction(db, ctx.operatorId, async tx => {
      const [org] = await tx.orm.select().from(organizations).where(eq(organizations.ownerId, ctx.operatorId));
      if (!org) throw new ApiError(400, '请先保存团队名称');
      await tx.orm.update(organizationInvites).set({ revokedAt: toPgTimestamp(new Date()) }).where(and(eq(organizationInvites.ownerId, ctx.operatorId), eq(organizationInvites.email, email), isNull(organizationInvites.usedAt)));
      const [created] = await tx.orm.insert(organizationInvites).values({ ownerId: ctx.operatorId, email, role: body.data.role,
        tokenHash: hashToken(token), expiresAt: toPgTimestamp(new Date(Date.now() + 7 * 86_400_000)),
      }).returning({ id: organizationInvites.id });
      await writeAudit(tx, { actor: ctx.email, action: 'team.invite', payload: { email, role: body.data.role }, ok: true });
      return created;
    });
    return reply.code(201).send({ id: invite!.id, token });
  });
  app.post('/api/team/accept', async req => {
    const ctx = req.ctx!;
    if (ctx.role !== 'operator') throw new ApiError(403, '请使用普通用户账号加入团队');
    const body = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '邀请无效');
    const [invite] = await db.orm.select().from(organizationInvites).where(and(eq(organizationInvites.tokenHash, hashToken(body.data.token)),
      eq(organizationInvites.email, normalizeEmail(ctx.email)), isNull(organizationInvites.usedAt), isNull(organizationInvites.revokedAt), gt(organizationInvites.expiresAt, toPgTimestamp(new Date()))));
    if (!invite) throw new ApiError(400, '邀请无效、已过期或不属于当前邮箱');
    return withBillingTransaction(db, invite.ownerId, async tx => {
      const [owner] = await tx.orm.select().from(operators).where(eq(operators.id, invite.ownerId));
      if (owner?.status !== 'active') throw new ApiError(400, '团队已停用');
      const [used] = await tx.orm.update(organizationInvites).set({ usedAt: toPgTimestamp(new Date()) })
        .where(and(eq(organizationInvites.id, invite.id), isNull(organizationInvites.usedAt), isNull(organizationInvites.revokedAt), gt(organizationInvites.expiresAt, toPgTimestamp(new Date())))).returning();
      if (!used) throw new ApiError(400, '邀请已失效');
      await tx.orm.insert(organizationMembers).values({ ownerId: invite.ownerId, operatorId: ctx.operatorId, role: invite.role })
        .onConflictDoUpdate({ target: [organizationMembers.ownerId, organizationMembers.operatorId], set: { role: invite.role } });
      await writeAudit(tx, { actor: ctx.email, action: 'team.join', payload: { ownerId: invite.ownerId, role: invite.role }, ok: true });
      return { ok: true };
    });
  });
  app.delete<{ Params: { id: string } }>('/api/team/invites/:id', async req => {
    writable(req.ctx!);
    await withBillingTransaction(db, req.ctx!.operatorId, async tx => {
      await tx.orm.update(organizationInvites).set({ revokedAt: toPgTimestamp(new Date()) }).where(and(eq(organizationInvites.id, Number(req.params.id)), eq(organizationInvites.ownerId, req.ctx!.operatorId)));
      await writeAudit(tx, { actor: req.ctx!.email, action: 'team.invite.revoke', payload: { inviteId: Number(req.params.id) }, ok: true });
    });
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/team/members/:id', async req => {
    const ctx = req.ctx!; writable(ctx);
    const body = z.object({ role: z.enum(['reader', 'editor', 'remove']) }).safeParse(req.body);
    if (!body.success) throw new ApiError(400, '团队角色无效');
    await withBillingTransaction(db, ctx.operatorId, async tx => {
      const where = and(eq(organizationMembers.id, Number(req.params.id)), eq(organizationMembers.ownerId, ctx.operatorId));
      const changed = body.data.role === 'remove' ? await tx.orm.delete(organizationMembers).where(where).returning()
        : await tx.orm.update(organizationMembers).set({ role: body.data.role }).where(where).returning();
      if (!changed.length) throw new ApiError(404, '成员不存在');
      await writeAudit(tx, { actor: ctx.email, action: 'team.member.update', payload: { memberId: Number(req.params.id), role: body.data.role }, ok: true });
    });
    return { ok: true };
  });
}
