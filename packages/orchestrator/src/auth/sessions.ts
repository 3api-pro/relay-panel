import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { operators, sessions, type OperatorRow } from '../db/schema.js';

/**
 * 会话管理（规格 §4）。DB 只存 sha256(token)，raw token 只出现在 cookie 里。
 * cookie 常量集中在此，routes 与 F4 的 server.ts 共用。
 */

export const SESSION_COOKIE = 'rp_session';

export interface SessionCookieOptions {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

/** maxAge 单位秒；不设 secure（自部署常见 http 内网/localhost，HTTPS 由反代层保障） */
export function sessionCookieOptions(ttlHours: number): SessionCookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge: Math.floor(ttlHours * 3600) };
}

/**
 * timestamp mode:'string' 列的读写格式（UTC）。写入 'YYYY-MM-DD HH:MM:SS.sss'，
 * 读取按 UTC 解析——本模块自写自读，口径一致即可比较。
 */
export function toPgTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export function fromPgTimestamp(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface CreatedSession {
  /** 32B 随机 hex，只回给 cookie，绝不落库/落日志 */
  token: string;
  expiresAt: string;
}

export async function createSession(
  db: Db,
  operatorId: number,
  ttlHours: number,
  meta: SessionMeta = {},
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = toPgTimestamp(new Date(Date.now() + ttlHours * 3600_000));
  await db.orm.insert(sessions).values({
    tokenHash: hashToken(token),
    operatorId,
    expiresAt,
    ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
    ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
  });
  return { token, expiresAt };
}

export interface ResolvedSession {
  operator: OperatorRow;
  expiresAt: string;
  /** 本次是否发生了滑动续期 */
  renewed: boolean;
}

/**
 * 校验 token：查 hash → 过期则删行返回 null → 剩余寿命 < ttl/2 时滑动续期。
 * 不判 operator.status——策略在 rbac.authenticate（本函数只管会话本身）。
 */
export async function resolveSession(db: Db, token: string, ttlHours: number): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(token);
  const rows = await db.orm
    .select({ session: sessions, operator: operators })
    .from(sessions)
    .innerJoin(operators, eq(sessions.operatorId, operators.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  const expiresMs = fromPgTimestamp(row.session.expiresAt).getTime();
  if (expiresMs <= now) {
    await db.orm.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }

  const ttlMs = ttlHours * 3600_000;
  let expiresAt = row.session.expiresAt;
  let renewed = false;
  if (expiresMs - now < ttlMs / 2) {
    expiresAt = toPgTimestamp(new Date(now + ttlMs));
    await db.orm.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
    renewed = true;
  }
  return { operator: row.operator, expiresAt, renewed };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.orm.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** 吊销某账号全部会话；exceptToken 用于改密时保留当前会话 */
export async function destroyOperatorSessions(
  db: Db,
  operatorId: number,
  opts: { exceptToken?: string } = {},
): Promise<void> {
  const conds = [eq(sessions.operatorId, operatorId)];
  if (opts.exceptToken !== undefined) conds.push(ne(sessions.tokenHash, hashToken(opts.exceptToken)));
  await db.orm.delete(sessions).where(and(...conds));
}
