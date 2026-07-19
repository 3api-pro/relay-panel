import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { authenticateDetailed, type SessionCtx } from './auth/rbac.js';
import { SESSION_COOKIE, sessionCookieOptions } from './auth/sessions.js';
import { JobEngine } from './jobs/engine.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerJobsRoutes } from './jobs/routes.js';
import { registerSitesRoutes } from './sites/routes.js';
import { registerBatchRoutes } from './batch/routes.js';
import { registerEngineVersionRoutes } from './engines/versions.js';
import { registerMarketplaceRoutes } from './marketplace/routes.js';
import { registerAlertsRoutes } from './alerts/routes.js';
import { registerBillingRoutes } from './billing/routes.js';
import { registerPaymentRoutes, registerPaymentWebhooks } from './billing/payments/routes.js';
import { registerDomainsRoutes } from './domains/routes.js';
import { registerMetricsRoutes } from './metrics.js';
import { registerSupportRoutes } from './support/routes.js';
import { registerDemoRoutes } from './demo/routes.js';

/**
 * server 装配（规格 §12）：Fastify 实例、cookie、认证钩子、CSRF、静态托管、
 * 集中注册全部路由模块。导出 buildServer 供 index.ts 与测试共用。
 */

// req.ctx 的声明合并由本文件唯一负责（F2/F3 模块内部只做结构化 cast 读取）
declare module 'fastify' {
  interface FastifyRequest {
    ctx?: SessionCtx;
  }
}

/** 计量网关用量行（与规格 §7 网关 HTTP 契约同构；G2 的 HttpMeteringGateway 按此结构实现） */
export interface MeteringUsageRow {
  periodStart: string;
  periodEnd: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  upstreamCost: number;
  billedCost: number;
}

/**
 * 计量网关接口占位（G2 在 marketplace/gateway.ts 交付 HttpMeteringGateway 实现，
 * 结构化兼容即可，无须 import 本类型）。test/fakes.ts 的 FakeGateway 与此同构。
 */
export interface MeteringGateway {
  issueKey(input: {
    siteSlug: string;
    templateKey: string;
    models: string[];
  }): Promise<{ keyRef: string; apiKey: string; baseUrl: string }>;
  revokeKey(keyRef: string): Promise<void>;
  pullUsage(keyRef: string, from: Date, to: Date): Promise<MeteringUsageRow[]>;
}

export interface NotifyEvent {
  type: 'open' | 'resolve';
  alert: unknown;
  site?: unknown;
}

/** 告警通知接口占位（G3 在 alerts/notify.ts 交付 WebhookNotifier）；FakeNotifier 与此同构 */
export interface Notifier {
  fire(event: NotifyEvent): Promise<void>;
}

/** buildServer 依赖注入形状（规格 §12，所有路由模块的 deps 都是它的结构化子集） */
export interface ServerDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  lifecycles: Record<EngineKind, EngineLifecycle>;
  gateway: MeteringGateway | null;
  jobs: JobEngine;
  notifier: Notifier;
}

export interface BuildServerOptions {
  /** index.ts 传 true 打开 fastify 请求日志；测试默认关闭 */
  logger?: boolean;
}

/** 免认证的 API 路径（其余 /api/* 一律要求合法 session） */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/config']);

const WEB_NOT_BUILT_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>relay-panel</title></head>
<body style="font-family:system-ui;background:#08090c;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:18px;font-weight:600">web 未构建</h1>
<p style="color:#8b91a1">运行 <code>npm run build -w @relay-panel/web</code> 后刷新本页。API 服务正常运行中。</p></div>
</body></html>`;

function pathOf(url: string): string {
  return url.split('?')[0] ?? '/';
}

/**
 * 组装完整服务。注意必须 await @fastify/cookie 注册完成后再 addHook，
 * 否则 cookie 解析钩子会排在认证钩子之后导致 req.cookies 为空。
 */
export async function buildServer(deps: ServerDeps, opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({ logger: opts.logger === true });

  await app.register(fastifyCookie);

  // ---- 防缓存：/api/* 响应一律 no-store，杜绝浏览器/中间层缓存鉴权响应 ----
  // （否则 GET /api/auth/me 的"已登录"响应会被浏览器缓存，登出后访问首页守卫拿到旧响应 → 误进后台）
  app.addHook('onSend', async (req, reply) => {
    if (pathOf(req.url).startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      reply.header('Pragma', 'no-cache');
    }
  });

  // ---- CSRF 钩子：非 GET 的 /api/* 若带 Origin 且 host 部分 != 请求 Host → 403 ----
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET') return;
    const path = pathOf(req.url);
    if (!path.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin === undefined) return; // 同源导航/非浏览器客户端不带 Origin，放行
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null; // 'null' 等不可解析 Origin 一律拒绝
    }
    if (originHost === null || originHost !== (req.headers.host ?? '')) {
      return reply.code(403).send({ error: '跨站请求被拒绝' });
    }
  });

  // ---- 认证钩子：/api/*（除放行清单）必须有合法 session → req.ctx ----
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req.url);
    if (path === '/healthz') return;
    const isApi = path.startsWith('/api/');
    // 非 /api 的静态路径放行；/metrics 也在此解析 session（Bearer 判定在 handler 内）
    if (!isApi && path !== '/metrics') return;
    if (isApi && PUBLIC_API_PATHS.has(path)) return;
    // 演示模式：/api/demo* 公开免认证（仅当 config.demo，非 demo 行为完全不变）
    if (isApi && config.demo && (path === '/api/demo' || path.startsWith('/api/demo/'))) return;
    const auth = await authenticateDetailed(db, req, config.sessionTtlHours);
    if (auth) {
      req.ctx = auth.ctx;
      // 滑动续期发生时回写 Set-Cookie 刷新浏览器 maxAge，否则活跃用户仍按登录时的固定 TTL 被强制登出
      if (auth.renewed) {
        reply.setCookie(SESSION_COOKIE, auth.token, sessionCookieOptions(config.sessionTtlHours));
      }
    }
    if (!isApi) return;
    if (!auth) return reply.code(401).send({ error: '未登录或会话已过期' });
  });

  app.get('/healthz', async () => ({ ok: true, service: 'relay-panel-orchestrator' }));

  // ---- 路由模块集中注册（签名统一 registerXxxRoutes(app, deps)） ----
  registerAuthRoutes(app, deps);
  registerJobsRoutes(app, deps);
  registerSitesRoutes(app, deps);
  registerBatchRoutes(app, deps);
  registerEngineVersionRoutes(app);
  registerMarketplaceRoutes(app, deps);
  registerAlertsRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerPaymentWebhooks(app, deps); // /webhooks/*：免认证 + 原始 body（验签）
  registerDomainsRoutes(app, deps);
  registerMetricsRoutes(app, deps);
  registerSupportRoutes(app, deps);
  // 演示路由仅在 demo 模式挂载（GET /api/demo 一键账号 + POST /api/demo/login）
  if (config.demo) registerDemoRoutes(app, deps);

  // ---- SPA 静态托管：RP_WEB_DIST 相对 orchestrator 包根解析（src/ 与 dist/ 下均是上一级） ----
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const webDistAbs = resolve(pkgRoot, config.webDist);
  const hasWebDist = existsSync(join(webDistAbs, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: webDistAbs });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (pathOf(req.url).startsWith('/api/')) {
      return reply.code(404).send({ error: '接口不存在' });
    }
    if (hasWebDist) return reply.sendFile('index.html'); // SPA history 路由回落
    return reply.type('text/html; charset=utf-8').send(WEB_NOT_BUILT_HTML);
  });

  return app;
}
