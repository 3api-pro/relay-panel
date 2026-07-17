import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { operators } from '../db/schema.js';
import {
  SESSION_COOKIE,
  createSession,
  sessionCookieOptions,
  toPgTimestamp,
} from '../auth/sessions.js';
import { DEMO_EMAIL, DEMO_NOTE, DEMO_PASSWORD } from './seed.js';

/**
 * 演示路由（仅 demo 模式注册；见 server.ts 的 config.demo 分支 + 公开路径放行）。
 *
 *  - GET  /api/demo         公开免认证，返回一键进入演示所需的账号（沙箱罐装可回显）。
 *  - POST /api/demo/login   便捷一键登录：直接为演示 root 账号建会话并下发 cookie。
 *
 * 安全：这里回显的密码是纯罐装沙箱账号，不涉及任何真实凭据；仅在 demo 模式挂载。
 */

export interface DemoRoutesDeps {
  config: Config;
  db: Db;
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoRoutesDeps): void {
  const { config, db } = deps;

  // 公开：登录页据此显示“一键进入演示”
  app.get('/api/demo', async () => ({
    demo: true,
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    note: DEMO_NOTE,
  }));

  // 便捷一键登录（等价于用返回账号走 /api/auth/login）
  app.post('/api/demo/login', async (req, reply) => {
    const rows = await db.orm.select().from(operators).where(eq(operators.email, DEMO_EMAIL)).limit(1);
    const op = rows[0];
    if (!op) return reply.code(503).send({ error: 'Demo account not ready' });

    const ua = req.headers['user-agent'];
    const { token } = await createSession(db, op.id, config.sessionTtlHours, {
      ...(typeof req.ip === 'string' ? { ip: req.ip } : {}),
      ...(typeof ua === 'string' ? { userAgent: ua } : {}),
    });
    await db.orm
      .update(operators)
      .set({ lastLoginAt: toPgTimestamp(new Date()) })
      .where(eq(operators.id, op.id));
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config.sessionTtlHours));
    return { email: op.email, displayName: op.displayName, role: op.role };
  });
}
