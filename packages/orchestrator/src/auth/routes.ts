import type { FastifyInstance, FastifyRequest } from 'fastify';
// 仅为声明合并（req.cookies / reply.setCookie 类型），插件注册由 server.ts / 测试完成
import '@fastify/cookie';
import { z } from 'zod';
import { and, asc, desc, eq, gt, isNull, like, ne, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { invites, operators, sites, subscriptions } from '../db/schema.js';
import { writeAudit } from '../audit.js';
import { randomHex } from '../secrets.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  SESSION_COOKIE,
  createSession,
  destroyOperatorSessions,
  destroySession,
  sessionCookieOptions,
  toPgTimestamp,
  type SessionMeta,
} from './sessions.js';
import { ApiError, authenticate, requireRoot, type OperatorRole, type SessionCtx } from './rbac.js';
import { SlidingWindowLimiter, clientIp, normalizeEmail } from './ratelimit.js';

/**
 * 认证/账号路由（规格 §4）：/api/auth/*、/api/invites、/api/operators。
 * deps 用规格 §12 buildServer 的注入形状，本模块只消费 config/db（结构化兼容，
 * F4 传全量 deps 即可）。每个 handler 自行取 ctx（优先 F4 钩子挂的 req.ctx，
 * 否则现场 authenticate）——脱离 server.ts 也可独立测试。
 */

export interface AuthRoutesDeps {
  config: Config;
  db: Db;
}

const INVITE_DEFAULT_TTL_HOURS = 168;

/** 限速滑窗（开放注册前置闸 §3）：signup 1 小时窗、login 失败 10 分钟窗 */
const SIGNUP_WINDOW_MS = 3_600_000;
const LOGIN_WINDOW_MS = 600_000;

const roleEnum = z.enum(['root', 'operator', 'viewer']);

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const signupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, '密码至少 8 位'),
  displayName: z.string().min(1).max(64).optional(),
  inviteToken: z.string().min(1).optional(),
});

const passwordBody = z.object({
  current: z.string().min(1),
  next: z.string().min(8, '密码至少 8 位'),
});

const inviteCreateBody = z.object({
  role: roleEnum.optional(),
  note: z.string().max(200).optional(),
  ttlHours: z.number().int().positive().max(24 * 365).optional(),
});

const operatorPatchBody = z.object({
  role: roleEnum.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  displayName: z.string().max(64).nullable().optional(),
});

/** zod 校验失败统一 400；issue 文案不含请求原值（口令等不回显） */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ApiError(400, `请求参数无效: ${issues}`);
  }
  return r.data;
}

function requestMeta(req: FastifyRequest): SessionMeta {
  const ua = req.headers['user-agent'];
  return {
    ...(typeof req.ip === 'string' ? { ip: req.ip } : {}),
    ...(typeof ua === 'string' ? { userAgent: ua } : {}),
  };
}

/** 登录时对不存在的账号也跑一次 scrypt，避免时序泄露账号是否存在 */
let timingDummyHash: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  timingDummyHash ??= hashPassword(randomHex(8));
  return timingDummyHash;
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const text = `${err.message} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  return /duplicate|unique/i.test(text);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { config, db } = deps;
  // 内存滑窗限速器（单实例进程内共享；本 app 生命周期内有效）
  const rateLimiter = new SlidingWindowLimiter();

  async function getCtx(req: FastifyRequest): Promise<SessionCtx> {
    const preset = (req as FastifyRequest & { ctx?: SessionCtx }).ctx;
    if (preset) return preset;
    const ctx = await authenticate(db, req, config.sessionTtlHours);
    if (!ctx) throw new ApiError(401, '未登录或会话已过期');
    return ctx;
  }

  // ---- /api/auth/* ----

  app.post('/api/auth/login', async (req, reply) => {
    const body = parseBody(loginBody, req.body);
    const email = normalizeEmail(body.email);
    // 限速：单 (真实IP, 账号) 失败次数滑窗；超限退避 429（成功即清零，失败才计数）
    const loginKey = `login:${clientIp(req)}:${email}`;
    if (rateLimiter.tooMany(loginKey, LOGIN_WINDOW_MS, config.loginMaxFails)) {
      await writeAudit(db, {
        actor: email,
        action: 'auth.login',
        payload: { email },
        ok: false,
        error: 'rate limited',
      });
      throw new ApiError(429, '操作过于频繁，请稍后再试');
    }

    // 归一化查找；兼容历史未归一化行：归一化未命中时回落原样(小写)再查一次
    const rawLower = body.email.trim().toLowerCase();
    let op = (await db.orm.select().from(operators).where(eq(operators.email, email)).limit(1))[0];
    if (!op && rawLower !== email) {
      op = (await db.orm.select().from(operators).where(eq(operators.email, rawLower)).limit(1))[0];
    }

    let ok = false;
    let reason = '';
    if (!op) {
      await verifyPassword(body.password, await dummyHash());
      reason = 'unknown email';
    } else {
      const pwOk = await verifyPassword(body.password, op.passwordHash);
      if (op.status !== 'active') reason = 'operator disabled';
      else if (!pwOk) reason = 'bad password';
      else ok = true;
    }

    if (!ok || !op) {
      rateLimiter.record(loginKey); // 失败计数
      await writeAudit(db, {
        actor: email,
        action: 'auth.login',
        payload: { email },
        ok: false,
        error: reason,
      });
      // 统一文案，不区分不存在/密码错/已禁用
      throw new ApiError(401, '邮箱或密码错误');
    }

    rateLimiter.clear(loginKey); // 成功清零失败计数
    const { token } = await createSession(db, op.id, config.sessionTtlHours, requestMeta(req));
    await db.orm.update(operators).set({ lastLoginAt: toPgTimestamp(new Date()) }).where(eq(operators.id, op.id));
    await writeAudit(db, { actor: op.email, action: 'auth.login', payload: { email: op.email }, ok: true });
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config.sessionTtlHours));
    return { email: op.email, displayName: op.displayName, role: op.role, signupMode: config.signupMode };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const ctx = await authenticate(db, req, config.sessionTtlHours);
      await destroySession(db, token);
      await writeAudit(db, { actor: ctx?.email ?? 'anonymous', action: 'auth.logout', ok: true });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const ctx = await getCtx(req);
    const rows = await db.orm.select().from(operators).where(eq(operators.id, ctx.operatorId)).limit(1);
    const op = rows[0];
    if (!op) throw new ApiError(401, '未登录或会话已过期');
    return { email: op.email, displayName: op.displayName, role: op.role, signupMode: config.signupMode };
  });

  app.post('/api/auth/signup', async (req) => {
    const body = parseBody(signupBody, req.body);
    if (config.signupMode === 'closed') throw new ApiError(403, '注册已关闭');

    // 邮箱归一化：gmail 别名(点/+tag)收敛到同一账号，杜绝派生海量小号
    const email = normalizeEmail(body.email);

    // 限速：单 IP + 单邮箱双维度滑窗（超任一即拒），CF-Connecting-IP 取真实 IP
    const ipKey = `signup:ip:${clientIp(req)}`;
    const emailKey = `signup:email:${email}`;
    if (
      rateLimiter.tooMany(ipKey, SIGNUP_WINDOW_MS, config.signupMaxPerIp) ||
      rateLimiter.tooMany(emailKey, SIGNUP_WINDOW_MS, config.signupMaxPerEmail)
    ) {
      await writeAudit(db, {
        actor: email,
        action: 'auth.signup',
        payload: { email, mode: config.signupMode },
        ok: false,
        error: 'rate limited',
      });
      throw new ApiError(429, '操作过于频繁，请稍后再试');
    }
    rateLimiter.record(ipKey);
    rateLimiter.record(emailKey);

    const dup = await db.orm.select({ id: operators.id }).from(operators).where(eq(operators.email, email)).limit(1);
    if (dup.length > 0) throw new ApiError(409, '邮箱已注册');

    let role: OperatorRole = 'operator';
    let invitePrefix: string | undefined;
    if (config.signupMode === 'invite') {
      if (!body.inviteToken) throw new ApiError(400, '需要邀请码');
      // 单条 UPDATE 原子消费（未用 + 未过期），并发重放只会成功一次
      const nowPg = toPgTimestamp(new Date());
      const used = await db.orm
        .update(invites)
        .set({ usedBy: email, usedAt: nowPg })
        .where(and(eq(invites.token, body.inviteToken), isNull(invites.usedAt), gt(invites.expiresAt, nowPg)))
        .returning();
      const inv = used[0];
      if (!inv) {
        await writeAudit(db, {
          actor: email,
          action: 'auth.signup',
          payload: { email, mode: config.signupMode },
          ok: false,
          error: 'invalid or expired invite',
        });
        throw new ApiError(400, '邀请码无效或已过期');
      }
      role = inv.role as OperatorRole;
      invitePrefix = inv.token.slice(0, 8);
    }

    const passwordHash = await hashPassword(body.password);
    let created;
    try {
      const inserted = await db.orm
        .insert(operators)
        .values({
          email,
          passwordHash,
          role,
          status: 'active',
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        })
        .returning();
      created = inserted[0]!;
    } catch (err) {
      // 查重与插入之间的并发窗口，unique 约束兜底
      if (isUniqueViolation(err)) throw new ApiError(409, '邮箱已注册');
      throw err;
    }

    await writeAudit(db, {
      actor: created.email,
      action: 'auth.signup',
      payload: {
        email: created.email,
        mode: config.signupMode,
        role,
        ...(invitePrefix !== undefined ? { invitePrefix } : {}),
      },
      ok: true,
    });
    return { email: created.email, displayName: created.displayName, role: created.role };
  });

  app.post('/api/auth/password', async (req) => {
    const ctx = await getCtx(req);
    const body = parseBody(passwordBody, req.body);
    const rows = await db.orm.select().from(operators).where(eq(operators.id, ctx.operatorId)).limit(1);
    const op = rows[0];
    if (!op || !(await verifyPassword(body.current, op.passwordHash))) {
      await writeAudit(db, { actor: ctx.email, action: 'auth.password', ok: false, error: 'current password mismatch' });
      throw new ApiError(400, '当前密码错误');
    }
    await db.orm
      .update(operators)
      .set({ passwordHash: await hashPassword(body.next) })
      .where(eq(operators.id, ctx.operatorId));
    // 吊销除当前会话外的全部会话
    const token = req.cookies?.[SESSION_COOKIE];
    await destroyOperatorSessions(db, ctx.operatorId, token !== undefined ? { exceptToken: token } : {});
    await writeAudit(db, { actor: ctx.email, action: 'auth.password', ok: true });
    return { ok: true };
  });

  // ---- /api/invites（root） ----

  app.get('/api/invites', async (req) => {
    const ctx = await getCtx(req);
    requireRoot(ctx);
    const rows = await db.orm.select().from(invites).orderBy(desc(invites.createdAt), asc(invites.token));
    return {
      invites: rows.map((r) => ({
        // 列表绝不回完整 token
        token: `${r.token.slice(0, 8)}…`,
        tokenPrefix: r.token.slice(0, 8),
        role: r.role,
        note: r.note,
        createdBy: r.createdBy,
        expiresAt: r.expiresAt,
        usedBy: r.usedBy,
        usedAt: r.usedAt,
        createdAt: r.createdAt,
      })),
    };
  });

  app.post('/api/invites', async (req) => {
    const ctx = await getCtx(req);
    requireRoot(ctx);
    const body = parseBody(inviteCreateBody, req.body);
    const token = randomHex(16);
    const role = body.role ?? 'operator';
    const ttlHours = body.ttlHours ?? INVITE_DEFAULT_TTL_HOURS;
    const expiresAt = toPgTimestamp(new Date(Date.now() + ttlHours * 3600_000));
    await db.orm.insert(invites).values({
      token,
      role,
      createdBy: ctx.email,
      expiresAt,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    await writeAudit(db, {
      actor: ctx.email,
      action: 'invite.create',
      payload: { role, ttlHours, prefix: token.slice(0, 8), ...(body.note !== undefined ? { note: body.note } : {}) },
      ok: true,
    });
    // 唯一一次完整返回，UI 提示立即保存
    return { token, role, note: body.note ?? null, expiresAt };
  });

  app.delete<{ Params: { token: string } }>('/api/invites/:token', async (req) => {
    const ctx = await getCtx(req);
    requireRoot(ctx);
    const param = req.params.token;
    // 接受完整 token 或列表页给出的 8 位前缀；限定 hex 防 LIKE 注入
    if (!/^[0-9a-f]{8,64}$/i.test(param)) throw new ApiError(400, '邀请标识格式无效');
    const rows = await db.orm.select().from(invites).where(like(invites.token, `${param}%`));
    if (rows.length === 0) throw new ApiError(404, '邀请不存在');
    if (rows.length > 1) throw new ApiError(409, '前缀匹配到多条邀请，请使用更长的前缀');
    const inv = rows[0]!;
    if (inv.usedAt !== null) throw new ApiError(400, '该邀请已被使用，保留作审计');
    await db.orm.delete(invites).where(eq(invites.token, inv.token));
    await writeAudit(db, {
      actor: ctx.email,
      action: 'invite.delete',
      payload: { prefix: inv.token.slice(0, 8) },
      ok: true,
    });
    return { ok: true };
  });

  // ---- /api/operators（root） ----

  app.get('/api/operators', async (req) => {
    const ctx = await getCtx(req);
    requireRoot(ctx);
    const ops = await db.orm.select().from(operators).orderBy(asc(operators.id));
    const counts = await db.orm
      .select({ operatorId: sites.operatorId, n: sql<number>`count(*)::int` })
      .from(sites)
      .where(ne(sites.status, 'destroyed'))
      .groupBy(sites.operatorId);
    const countMap = new Map(counts.map((c) => [c.operatorId, c.n]));

    const nowPg = toPgTimestamp(new Date());
    const subs = await db.orm
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'active'), gt(subscriptions.currentPeriodEnd, nowPg)));
    const subMap = new Map<number, { planKey: string; currentPeriodEnd: string }>();
    for (const s of subs) {
      const prev = subMap.get(s.operatorId);
      // 同账号多条 active 时取最晚到期的
      if (!prev || s.currentPeriodEnd > prev.currentPeriodEnd) {
        subMap.set(s.operatorId, { planKey: s.planKey, currentPeriodEnd: s.currentPeriodEnd });
      }
    }

    return {
      operators: ops.map((o) => ({
        id: o.id,
        email: o.email,
        displayName: o.displayName,
        role: o.role,
        status: o.status,
        lastLoginAt: o.lastLoginAt,
        createdAt: o.createdAt,
        siteCount: countMap.get(o.id) ?? 0,
        subscription: subMap.get(o.id) ?? null,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/operators/:id', async (req) => {
    const ctx = await getCtx(req);
    requireRoot(ctx);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, '操作员 id 无效');
    const body = parseBody(operatorPatchBody, req.body);
    if (body.role === undefined && body.status === undefined && body.displayName === undefined) {
      throw new ApiError(400, '没有可更新的字段');
    }

    const rows = await db.orm.select().from(operators).where(eq(operators.id, id)).limit(1);
    const target = rows[0];
    if (!target) throw new ApiError(404, '操作员不存在');

    // 最后一个 active root 保护：不得被降级或禁用
    const demoting =
      (body.role !== undefined && body.role !== 'root') || (body.status !== undefined && body.status !== 'active');
    if (target.role === 'root' && target.status === 'active' && demoting) {
      const otherRoots = await db.orm
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.role, 'root'), eq(operators.status, 'active'), ne(operators.id, id)));
      if (otherRoots.length === 0) throw new ApiError(400, '不能禁用或降级最后一个活跃 root');
    }

    const updated = await db.orm
      .update(operators)
      .set({
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      })
      .where(eq(operators.id, id))
      .returning();
    const after = updated[0]!;

    // 禁用即时生效：吊销其全部会话
    if (body.status === 'disabled') await destroyOperatorSessions(db, id);

    await writeAudit(db, {
      actor: ctx.email,
      action: 'operator.update',
      payload: {
        targetId: id,
        targetEmail: target.email,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      },
      ok: true,
    });
    return { id: after.id, email: after.email, displayName: after.displayName, role: after.role, status: after.status };
  });
}
