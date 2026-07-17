import fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { auditEvents, invites, operators, sessions, sites, subscriptions } from '../src/db/schema.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import {
  createSession,
  destroyOperatorSessions,
  destroySession,
  fromPgTimestamp,
  hashToken,
  resolveSession,
  toPgTimestamp,
} from '../src/auth/sessions.js';
import {
  ApiError,
  authenticate,
  authenticateDetailed,
  canAccessSite,
  requireRoot,
  requireWrite,
  type SessionCtx,
} from '../src/auth/rbac.js';
import { registerAuthRoutes, type AuthRoutesDeps } from '../src/auth/routes.js';
import { makeTestConfig, makeTestDb, seedOperator } from './helpers.js';

// pglite 冷启动约 4s + scrypt 每次约几十 ms，放宽超时；全文件共享一个库
vi.setConfig({ testTimeout: 30_000 });

let db: Db;
const apps: FastifyInstance[] = [];

/** 规格 §12 buildServer deps 形状；本模块只消费 config/db，其余字段占位 */
function makeDeps(forDb: Db, config: Config): AuthRoutesDeps {
  const deps = {
    config,
    db: forDb,
    adapters: {},
    lifecycles: {},
    gateway: null,
    jobs: undefined,
    notifier: undefined,
  };
  return deps as unknown as AuthRoutesDeps;
}

async function makeApp(forDb: Db, overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const app = fastify();
  await app.register(fastifyCookie);
  registerAuthRoutes(app, makeDeps(forDb, makeTestConfig(overrides)));
  await app.ready();
  apps.push(app);
  return app;
}

async function seedWithPassword(
  forDb: Db,
  opts: { email: string; password: string; role?: string; status?: string; displayName?: string },
): Promise<number> {
  const rows = await forDb.orm
    .insert(operators)
    .values({
      email: opts.email,
      passwordHash: await hashPassword(opts.password),
      role: opts.role ?? 'operator',
      status: opts.status ?? 'active',
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    })
    .returning({ id: operators.id });
  return rows[0]!.id;
}

async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'rp_session');
  expect(cookie).toBeTruthy();
  return cookie!.value;
}

let appClosed: FastifyInstance;
let appOpen: FastifyInstance;
let appInvite: FastifyInstance;

beforeAll(async () => {
  db = await makeTestDb();
  appClosed = await makeApp(db); // 默认 signupMode=closed
  appOpen = await makeApp(db, { signupMode: 'open' });
  appInvite = await makeApp(db, { signupMode: 'invite' });
}, 60_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
  await db.close().catch(() => undefined);
});

describe('passwords: hashPassword/verifyPassword', () => {
  it('回环 + 存储格式符合 schema 注释', async () => {
    const stored = await hashPassword('S3cret-pass-回环');
    expect(stored).toMatch(/^scrypt:N=16384,r=8,p=1:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(await verifyPassword('S3cret-pass-回环', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('随机盐：同口令两次散列不同，但都可验证', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-1', a)).toBe(true);
    expect(await verifyPassword('same-password-1', b)).toBe(true);
  });

  it('空/畸形存储串一律 false 不抛错', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plain-garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:N=bad:aa:bb')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:N=16384,r=8,p=1:zz:zz')).toBe(false);
  });
});

describe('sessions: 建立/续期/吊销', () => {
  it('createSession 只落 sha256(token)，resolveSession 返回 operator', async () => {
    const opId = await seedOperator(db, { email: 'sess-1@example.com', role: 'operator' });
    const { token } = await createSession(db, opId, 168, { ip: '192.0.2.1', userAgent: 'vitest' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const rows = await db.orm.select().from(sessions).where(eq(sessions.operatorId, opId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.ip).toBe('192.0.2.1');

    const resolved = await resolveSession(db, token, 168);
    expect(resolved).not.toBeNull();
    expect(resolved!.operator.email).toBe('sess-1@example.com');
    expect(resolved!.renewed).toBe(false);
    // 无此 token
    expect(await resolveSession(db, 'ff'.repeat(32), 168)).toBeNull();
  });

  it('过期会话 resolve 为 null 且行被清理', async () => {
    const opId = await seedOperator(db, { email: 'sess-2@example.com', role: 'operator' });
    const { token } = await createSession(db, opId, 168);
    await db.orm
      .update(sessions)
      .set({ expiresAt: toPgTimestamp(new Date(Date.now() - 1000)) })
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(await resolveSession(db, token, 168)).toBeNull();
    const rows = await db.orm.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    expect(rows).toHaveLength(0);
  });

  it('剩余寿命不足一半时滑动续期', async () => {
    const opId = await seedOperator(db, { email: 'sess-3@example.com', role: 'operator' });
    const { token } = await createSession(db, opId, 168);
    // 手动压到只剩 10h（阈值 84h）
    const shortened = toPgTimestamp(new Date(Date.now() + 10 * 3600_000));
    await db.orm.update(sessions).set({ expiresAt: shortened }).where(eq(sessions.tokenHash, hashToken(token)));

    const renewed = await resolveSession(db, token, 168);
    expect(renewed!.renewed).toBe(true);
    expect(fromPgTimestamp(renewed!.expiresAt).getTime()).toBeGreaterThan(fromPgTimestamp(shortened).getTime());
    // 续满后再 resolve 不再续期
    const again = await resolveSession(db, token, 168);
    expect(again!.renewed).toBe(false);
  });

  it('destroySession / destroyOperatorSessions(exceptToken)', async () => {
    const opId = await seedOperator(db, { email: 'sess-4@example.com', role: 'operator' });
    const s1 = await createSession(db, opId, 168);
    const s2 = await createSession(db, opId, 168);
    const s3 = await createSession(db, opId, 168);

    await destroySession(db, s3.token);
    expect(await resolveSession(db, s3.token, 168)).toBeNull();

    await destroyOperatorSessions(db, opId, { exceptToken: s1.token });
    expect(await resolveSession(db, s1.token, 168)).not.toBeNull();
    expect(await resolveSession(db, s2.token, 168)).toBeNull();

    await destroyOperatorSessions(db, opId);
    expect(await resolveSession(db, s1.token, 168)).toBeNull();
  });
});

describe('rbac: 角色矩阵与 authenticate', () => {
  const root: SessionCtx = { operatorId: 1, email: 'r@example.com', role: 'root' };
  const operator: SessionCtx = { operatorId: 2, email: 'o@example.com', role: 'operator' };
  const viewer: SessionCtx = { operatorId: 3, email: 'v@example.com', role: 'viewer' };

  it('requireWrite: viewer 403，root/operator 放行', () => {
    expect(() => requireWrite(root)).not.toThrow();
    expect(() => requireWrite(operator)).not.toThrow();
    try {
      requireWrite(viewer);
      expect.unreachable('viewer 应被拒绝');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(403);
    }
  });

  it('requireRoot: 仅 root 放行', () => {
    expect(() => requireRoot(root)).not.toThrow();
    for (const ctx of [operator, viewer]) {
      try {
        requireRoot(ctx);
        expect.unreachable('非 root 应被拒绝');
      } catch (e) {
        expect((e as ApiError).statusCode).toBe(403);
      }
    }
  });

  it('canAccessSite: root/viewer 全站，operator 仅 own', () => {
    const own = { operatorId: 2 };
    const other = { operatorId: 9 };
    expect(canAccessSite(root, other)).toBe(true);
    expect(canAccessSite(viewer, other)).toBe(true);
    expect(canAccessSite(operator, own)).toBe(true);
    expect(canAccessSite(operator, other)).toBe(false);
  });

  it('authenticate: 有效 cookie 出 ctx；禁用账号/无 cookie 为 null', async () => {
    const opId = await seedOperator(db, { email: 'rbac-1@example.com', role: 'viewer' });
    const { token } = await createSession(db, opId, 168);
    const ctx = await authenticate(db, { cookies: { rp_session: token } }, 168);
    expect(ctx).toEqual({ operatorId: opId, email: 'rbac-1@example.com', role: 'viewer' });

    const disabledId = await seedOperator(db, { email: 'rbac-2@example.com', role: 'operator', status: 'disabled' });
    const s = await createSession(db, disabledId, 168);
    expect(await authenticate(db, { cookies: { rp_session: s.token } }, 168)).toBeNull();
    expect(await authenticate(db, {}, 168)).toBeNull();
    expect(await authenticate(db, { cookies: {} }, 168)).toBeNull();
  });

  it('authenticateDetailed: 滑动续期时透出 renewed=true + 原始 token 供钩子刷新 cookie', async () => {
    const opId = await seedOperator(db, { email: 'rbac-renew@example.com', role: 'operator' });
    const { token } = await createSession(db, opId, 168);
    // 压到只剩 10h（阈值 84h）→ 下次 resolve 触发续期
    await db.orm
      .update(sessions)
      .set({ expiresAt: toPgTimestamp(new Date(Date.now() + 10 * 3600_000)) })
      .where(eq(sessions.tokenHash, hashToken(token)));

    const detailed = await authenticateDetailed(db, { cookies: { rp_session: token } }, 168);
    expect(detailed).not.toBeNull();
    expect(detailed!.renewed).toBe(true);
    expect(detailed!.token).toBe(token);
    expect(detailed!.ctx).toEqual({ operatorId: opId, email: 'rbac-renew@example.com', role: 'operator' });

    // 续满后再取详情不再续期，token 仍原样透出
    const again = await authenticateDetailed(db, { cookies: { rp_session: token } }, 168);
    expect(again!.renewed).toBe(false);
    expect(again!.token).toBe(token);

    // 无 cookie / 无效 token 一律 null
    expect(await authenticateDetailed(db, {}, 168)).toBeNull();
    expect(await authenticateDetailed(db, { cookies: { rp_session: 'ab'.repeat(32) } }, 168)).toBeNull();
  });
});

describe('routes: login / me / logout', () => {
  const EMAIL = 'alice@example.com';
  const PASSWORD = 'Alice-pass-123456';

  beforeAll(async () => {
    await seedWithPassword(db, { email: EMAIL, password: PASSWORD, role: 'root', displayName: 'Alice' });
    await seedWithPassword(db, {
      email: 'dora@example.com',
      password: 'Dora-pass-123456',
      status: 'disabled',
    });
  });

  it('登录成功：cookie 属性 + last_login_at + audit', async () => {
    const res = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: EMAIL, displayName: 'Alice', role: 'root', signupMode: 'closed' });

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('rp_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');

    const op = await db.orm.select().from(operators).where(eq(operators.email, EMAIL));
    expect(op[0]!.lastLoginAt).toBeTruthy();

    const audits = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'auth.login'), eq(auditEvents.actor, EMAIL), eq(auditEvents.ok, true)));
    expect(audits.length).toBeGreaterThan(0);
  });

  it('失败统一 401 文案：错密/不存在/禁用账号不区分', async () => {
    for (const payload of [
      { email: EMAIL, password: 'wrong-password-1' },
      { email: 'nobody@example.com', password: 'whatever-123' },
      { email: 'dora@example.com', password: 'Dora-pass-123456' },
    ]) {
      const res = await appClosed.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe('邮箱或密码错误');
      expect(String(res.headers['set-cookie'] ?? '')).not.toContain('rp_session=');
    }
    // 审计不落口令明文
    const all = await db.orm.select().from(auditEvents);
    const dumped = JSON.stringify(all);
    expect(dumped).not.toContain(PASSWORD);
    expect(dumped).not.toContain('wrong-password-1');
    expect(dumped).not.toContain('Dora-pass-123456');
  });

  it('me: 带会话返回身份，无会话 401', async () => {
    const token = await login(appClosed, EMAIL, PASSWORD);
    const ok = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: EMAIL, displayName: 'Alice', role: 'root', signupMode: 'closed' });

    const anon = await appClosed.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    const bogus = await appClosed.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { rp_session: 'ee'.repeat(32) },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('logout: 清 cookie 并吊销会话', async () => {
    const token = await login(appClosed, EMAIL, PASSWORD);
    const res = await appClosed.inject({ method: 'POST', url: '/api/auth/logout', cookies: { rp_session: token } });
    expect(res.statusCode).toBe(200);
    const me = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: token } });
    expect(me.statusCode).toBe(401);
  });
});

describe('routes: signup 三模式', () => {
  it('closed 模式 403', async () => {
    const res = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'closed-user@example.com', password: 'Whatever-123456' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('open 模式直接建号（role=operator），重复邮箱 409，弱口令 400', async () => {
    const res = await appOpen.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'open-user@example.com', password: 'Open-pass-123456', displayName: '开放注册' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'open-user@example.com', displayName: '开放注册', role: 'operator' });
    // 注册后可登录
    await login(appOpen, 'open-user@example.com', 'Open-pass-123456');

    const dup = await appOpen.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'open-user@example.com', password: 'Open-pass-123456' },
    });
    expect(dup.statusCode).toBe(409);

    const weak = await appOpen.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'weak-user@example.com', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
  });

  it('invite 模式：无邀请码 400、伪造邀请码 400', async () => {
    const missing = await appInvite.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'no-invite@example.com', password: 'Invite-pass-123456' },
    });
    expect(missing.statusCode).toBe(400);

    const forged = await appInvite.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'no-invite@example.com', password: 'Invite-pass-123456', inviteToken: 'deadbeef'.repeat(4) },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().message).toBe('邀请码无效或已过期');
  });
});

describe('routes: invite 全生命周期', () => {
  const ROOT_EMAIL = 'invite-root@example.com';
  const ROOT_PASSWORD = 'RootPass-123456';
  let rootCookie: string;

  beforeAll(async () => {
    await seedWithPassword(db, { email: ROOT_EMAIL, password: ROOT_PASSWORD, role: 'root' });
    rootCookie = await login(appInvite, ROOT_EMAIL, ROOT_PASSWORD);
  });

  it('非 root 不能碰 /api/invites', async () => {
    const anon = await appInvite.inject({ method: 'GET', url: '/api/invites' });
    expect(anon.statusCode).toBe(401);
    const memberCookie = await login(appOpen, 'open-user@example.com', 'Open-pass-123456');
    const forbidden = await appInvite.inject({
      method: 'GET',
      url: '/api/invites',
      cookies: { rp_session: memberCookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('创建（一次性完整返回）→ 列表脱敏 → 消费注册 → 复用被拒', async () => {
    const created = await appInvite.inject({
      method: 'POST',
      url: '/api/invites',
      cookies: { rp_session: rootCookie },
      payload: { role: 'viewer', note: '给只读同事', ttlHours: 24 },
    });
    expect(created.statusCode).toBe(200);
    const inviteToken: string = created.json().token;
    expect(inviteToken).toMatch(/^[0-9a-f]{32}$/);
    expect(created.json().role).toBe('viewer');

    // 列表不含完整 token
    const list = await appInvite.inject({ method: 'GET', url: '/api/invites', cookies: { rp_session: rootCookie } });
    expect(list.statusCode).toBe(200);
    const listed = list.json().invites.find((i: { tokenPrefix: string }) => i.tokenPrefix === inviteToken.slice(0, 8));
    expect(listed).toBeTruthy();
    expect(listed.token).toBe(`${inviteToken.slice(0, 8)}…`);
    expect(JSON.stringify(list.json())).not.toContain(inviteToken);

    // 消费：新账号 role 来自 invite
    const signup = await appInvite.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'invited-viewer@example.com', password: 'Viewer-pass-123456', inviteToken },
    });
    expect(signup.statusCode).toBe(200);
    expect(signup.json().role).toBe('viewer');

    const after = await appInvite.inject({ method: 'GET', url: '/api/invites', cookies: { rp_session: rootCookie } });
    const usedRow = after.json().invites.find((i: { tokenPrefix: string }) => i.tokenPrefix === inviteToken.slice(0, 8));
    expect(usedRow.usedBy).toBe('invited-viewer@example.com');
    expect(usedRow.usedAt).toBeTruthy();

    // 一次性：复用被拒
    const reuse = await appInvite.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'second-user@example.com', password: 'Second-pass-123456', inviteToken },
    });
    expect(reuse.statusCode).toBe(400);

    // 已使用的邀请不可删除（留审计）
    const delUsed = await appInvite.inject({
      method: 'DELETE',
      url: `/api/invites/${inviteToken.slice(0, 8)}`,
      cookies: { rp_session: rootCookie },
    });
    expect(delUsed.statusCode).toBe(400);
  });

  it('过期邀请不可用', async () => {
    const created = await appInvite.inject({
      method: 'POST',
      url: '/api/invites',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    const token: string = created.json().token;
    await db.orm
      .update(invites)
      .set({ expiresAt: toPgTimestamp(new Date(Date.now() - 1000)) })
      .where(eq(invites.token, token));
    const res = await appInvite.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'late-user@example.com', password: 'Late-pass-123456', inviteToken: token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('邀请码无效或已过期');
  });

  it('按前缀删除未使用邀请；畸形/不存在标识 400/404', async () => {
    const created = await appInvite.inject({
      method: 'POST',
      url: '/api/invites',
      cookies: { rp_session: rootCookie },
      payload: { note: '将被删除' },
    });
    const token: string = created.json().token;
    const del = await appInvite.inject({
      method: 'DELETE',
      url: `/api/invites/${token.slice(0, 8)}`,
      cookies: { rp_session: rootCookie },
    });
    expect(del.statusCode).toBe(200);
    const again = await appInvite.inject({
      method: 'DELETE',
      url: `/api/invites/${token.slice(0, 8)}`,
      cookies: { rp_session: rootCookie },
    });
    expect(again.statusCode).toBe(404);
    const malformed = await appInvite.inject({
      method: 'DELETE',
      url: '/api/invites/zz',
      cookies: { rp_session: rootCookie },
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('routes: 修改密码', () => {
  it('改密吊销其他会话、保留当前会话，新旧口令切换', async () => {
    const EMAIL = 'pw-change@example.com';
    await seedWithPassword(db, { email: EMAIL, password: 'OldPass-123456' });
    const c1 = await login(appClosed, EMAIL, 'OldPass-123456');
    const c2 = await login(appClosed, EMAIL, 'OldPass-123456');

    const wrong = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/password',
      cookies: { rp_session: c1 },
      payload: { current: 'not-the-old-pass', next: 'NewPass-654321' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/password',
      cookies: { rp_session: c1 },
      payload: { current: 'OldPass-123456', next: 'NewPass-654321' },
    });
    expect(ok.statusCode).toBe(200);

    // 其他会话已吊销，当前会话仍有效
    const other = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: c2 } });
    expect(other.statusCode).toBe(401);
    const self = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: c1 } });
    expect(self.statusCode).toBe(200);

    // 旧口令失效，新口令可登录
    const oldLogin = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: 'OldPass-123456' },
    });
    expect(oldLogin.statusCode).toBe(401);
    await login(appClosed, EMAIL, 'NewPass-654321');

    // 口令明文不落审计
    const dumped = JSON.stringify(await db.orm.select().from(auditEvents));
    expect(dumped).not.toContain('OldPass-123456');
    expect(dumped).not.toContain('NewPass-654321');
  });
});

describe('routes: operators 列表与 PATCH', () => {
  const ROOT_EMAIL = 'admin-root@example.com';
  const ROOT_PASSWORD = 'AdminPass-123456';
  const MEMBER_EMAIL = 'op-member@example.com';
  const MEMBER_PASSWORD = 'MemberPass-123456';
  let rootCookie: string;
  let memberId: number;

  beforeAll(async () => {
    await seedWithPassword(db, { email: ROOT_EMAIL, password: ROOT_PASSWORD, role: 'root' });
    memberId = await seedWithPassword(db, { email: MEMBER_EMAIL, password: MEMBER_PASSWORD, role: 'operator' });
    rootCookie = await login(appClosed, ROOT_EMAIL, ROOT_PASSWORD);

    // 站点数：2 个在用 + 1 个 destroyed（不计入）
    await db.orm.insert(sites).values([
      {
        operatorId: memberId,
        slug: 'authtest-a',
        label: 'A',
        engine: 'sub2api',
        version: '1.0.0',
        hostPort: 18110,
        baseUrl: 'http://127.0.0.1:18110',
        status: 'active',
      },
      {
        operatorId: memberId,
        slug: 'authtest-b',
        label: 'B',
        engine: 'newapi',
        version: '1.0.0',
        hostPort: 18111,
        baseUrl: 'http://127.0.0.1:18111',
        status: 'stopped',
      },
      {
        operatorId: memberId,
        slug: 'authtest-dead',
        label: 'Dead',
        engine: 'sub2api',
        version: '1.0.0',
        hostPort: 18112,
        baseUrl: 'http://127.0.0.1:18112',
        status: 'destroyed',
      },
    ]);
    // 当前订阅取最晚到期的 active（过期的 scale 不算）
    await db.orm.insert(subscriptions).values([
      {
        operatorId: memberId,
        planKey: 'scale',
        status: 'active',
        currentPeriodEnd: toPgTimestamp(new Date(Date.now() - 24 * 3600_000)),
      },
      {
        operatorId: memberId,
        planKey: 'pro',
        status: 'active',
        currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 30 * 24 * 3600_000)),
      },
    ]);
  });

  it('root 看列表：站点数（不含 destroyed）+ 当前订阅；非 root 403/401', async () => {
    const res = await appClosed.inject({ method: 'GET', url: '/api/operators', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json().operators;
    const member = list.find((o: { email: string }) => o.email === MEMBER_EMAIL);
    expect(member.siteCount).toBe(2);
    expect(member.subscription).toEqual(expect.objectContaining({ planKey: 'pro' }));
    const rootRow = list.find((o: { email: string }) => o.email === ROOT_EMAIL);
    expect(rootRow.siteCount).toBe(0);
    expect(rootRow.subscription).toBeNull();
    // 列表不含任何口令散列
    expect(JSON.stringify(list)).not.toContain('scrypt:');

    const memberCookie = await login(appClosed, MEMBER_EMAIL, MEMBER_PASSWORD);
    const forbidden = await appClosed.inject({
      method: 'GET',
      url: '/api/operators',
      cookies: { rp_session: memberCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const anon = await appClosed.inject({ method: 'GET', url: '/api/operators' });
    expect(anon.statusCode).toBe(401);
  });

  it('PATCH 改 displayName/role；空 body 400；不存在 404；坏 id 400', async () => {
    const res = await appClosed.inject({
      method: 'PATCH',
      url: `/api/operators/${memberId}`,
      cookies: { rp_session: rootCookie },
      payload: { displayName: '成员甲', role: 'viewer' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ id: memberId, displayName: '成员甲', role: 'viewer', status: 'active' }),
    );

    const empty = await appClosed.inject({
      method: 'PATCH',
      url: `/api/operators/${memberId}`,
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const missing = await appClosed.inject({
      method: 'PATCH',
      url: '/api/operators/999999',
      cookies: { rp_session: rootCookie },
      payload: { role: 'viewer' },
    });
    expect(missing.statusCode).toBe(404);
    const badId = await appClosed.inject({
      method: 'PATCH',
      url: '/api/operators/abc',
      cookies: { rp_session: rootCookie },
      payload: { role: 'viewer' },
    });
    expect(badId.statusCode).toBe(400);
  });

  it('禁用账号即时吊销其会话', async () => {
    const memberCookie = await login(appClosed, MEMBER_EMAIL, MEMBER_PASSWORD);
    const before = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: memberCookie } });
    expect(before.statusCode).toBe(200);

    const res = await appClosed.inject({
      method: 'PATCH',
      url: `/api/operators/${memberId}`,
      cookies: { rp_session: rootCookie },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);

    const after = await appClosed.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: memberCookie } });
    expect(after.statusCode).toBe(401);
    // 禁用后无法登录（统一 401）
    const relogin = await appClosed.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(relogin.statusCode).toBe(401);
  });

  it('最后一个 active root 不得被禁用/降级（独立库）', async () => {
    const db2 = await makeTestDb();
    try {
      const app2 = await makeApp(db2);
      const soloId = await seedWithPassword(db2, {
        email: 'solo-root@example.com',
        password: 'SoloPass-123456',
        role: 'root',
      });
      const cookie = await login(app2, 'solo-root@example.com', 'SoloPass-123456');

      const demote = await app2.inject({
        method: 'PATCH',
        url: `/api/operators/${soloId}`,
        cookies: { rp_session: cookie },
        payload: { role: 'operator' },
      });
      expect(demote.statusCode).toBe(400);
      const disable = await app2.inject({
        method: 'PATCH',
        url: `/api/operators/${soloId}`,
        cookies: { rp_session: cookie },
        payload: { status: 'disabled' },
      });
      expect(disable.statusCode).toBe(400);

      // 有第二个 active root 后允许降级；且角色变化即时生效（后续再访问 root 接口 403）
      await seedOperator(db2, { email: 'second-root@example.com', role: 'root' });
      const now = await app2.inject({
        method: 'PATCH',
        url: `/api/operators/${soloId}`,
        cookies: { rp_session: cookie },
        payload: { role: 'operator' },
      });
      expect(now.statusCode).toBe(200);
      const denied = await app2.inject({ method: 'GET', url: '/api/operators', cookies: { rp_session: cookie } });
      expect(denied.statusCode).toBe(403);
    } finally {
      await db2.close().catch(() => undefined);
    }
  });
});
