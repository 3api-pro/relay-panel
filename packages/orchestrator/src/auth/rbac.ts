import type { Db } from '../db/client.js';
import type { SiteRow } from '../db/schema.js';
import { SESSION_COOKIE, resolveSession } from './sessions.js';

/**
 * RBAC 纯函数工具（规格 §4）。不含任何 fastify 钩子——onRequest 钩子由 F4 在
 * server.ts 装配，调用这里的 authenticate() 得到 SessionCtx 挂到 req.ctx。
 */

export type OperatorRole = 'root' | 'operator' | 'viewer';

export interface SessionCtx {
  operatorId: number;
  email: string;
  role: OperatorRole;
}

/** 带 statusCode 的错误：fastify 默认 error handler 会按此码回包并带 message */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/** 结构化最小请求形状（FastifyRequest 注册 @fastify/cookie 后天然兼容） */
export interface AuthRequestLike {
  cookies?: Record<string, string | undefined>;
}

/**
 * 从 cookie 解析会话 → 校验未过期（内部滑动续期）→ 账号必须 active。
 * 任何一环不满足返回 null（由调用方决定 401 还是放行）。
 */
export async function authenticate(db: Db, req: AuthRequestLike, ttlHours = 168): Promise<SessionCtx | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const resolved = await resolveSession(db, token, ttlHours);
  if (!resolved) return null;
  if (resolved.operator.status !== 'active') return null;
  return {
    operatorId: resolved.operator.id,
    email: resolved.operator.email,
    role: resolved.operator.role as OperatorRole,
  };
}

/** viewer 禁写 */
export function requireWrite(ctx: SessionCtx): void {
  if (ctx.role === 'viewer') throw new ApiError(403, '当前角色为只读，无写权限');
}

export function requireRoot(ctx: SessionCtx): void {
  if (ctx.role !== 'root') throw new ApiError(403, '仅 root 可执行此操作');
}

/** root/viewer 全站可见；operator 仅自己名下的站 */
export function canAccessSite(ctx: SessionCtx, site: Pick<SiteRow, 'operatorId'>): boolean {
  if (ctx.role === 'root' || ctx.role === 'viewer') return true;
  return site.operatorId === ctx.operatorId;
}
