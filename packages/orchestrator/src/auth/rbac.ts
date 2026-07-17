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
 * 认证详情：ctx 之外透出本次是否滑动续期（renewed）与原始 token，
 * 供 server.ts 钩子据此刷新浏览器 cookie 的 maxAge（否则滑动续期对客户端零效果）。
 */
export interface AuthResult {
  ctx: SessionCtx;
  /** 本次 resolveSession 是否顺延了 DB expiresAt */
  renewed: boolean;
  /** cookie 里的原始 token（仅用于回写 Set-Cookie，绝不落库/落日志） */
  token: string;
}

/**
 * 从 cookie 解析会话 → 校验未过期（内部滑动续期）→ 账号必须 active，返回认证详情。
 * 任何一环不满足返回 null。authenticate() 是它只取 ctx 的薄封装（保持既有调用点兼容）。
 */
export async function authenticateDetailed(
  db: Db,
  req: AuthRequestLike,
  ttlHours = 168,
): Promise<AuthResult | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const resolved = await resolveSession(db, token, ttlHours);
  if (!resolved) return null;
  if (resolved.operator.status !== 'active') return null;
  return {
    ctx: {
      operatorId: resolved.operator.id,
      email: resolved.operator.email,
      role: resolved.operator.role as OperatorRole,
    },
    renewed: resolved.renewed,
    token,
  };
}

/**
 * 从 cookie 解析会话 → 校验未过期（内部滑动续期）→ 账号必须 active。
 * 任何一环不满足返回 null（由调用方决定 401 还是放行）。
 */
export async function authenticate(db: Db, req: AuthRequestLike, ttlHours = 168): Promise<SessionCtx | null> {
  const result = await authenticateDetailed(db, req, ttlHours);
  return result === null ? null : result.ctx;
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
