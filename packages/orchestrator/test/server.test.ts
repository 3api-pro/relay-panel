import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sites } from '../src/db/schema.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * buildServer 级冒烟（F4）：认证钩子 / CSRF / 静态回落 / 占位路由 / metrics。
 * pglite 冷启动约 4s，整文件共享一个服务实例。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let operatorCookie: string;
let operatorId: number;

const METRICS_TOKEN = 'metrics-test-token';

beforeAll(async () => {
  ts = await makeTestServer({ config: { metricsToken: METRICS_TOKEN } });
  const root = await ts.seedLogin({ email: 'root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const op = await ts.seedLogin({ email: 'op@example.com', password: 'op-pass-1234', role: 'operator' });
  operatorCookie = op.cookie;
  operatorId = op.operatorId;

  await ts.db.orm.insert(sites).values([
    {
      operatorId: root.operatorId,
      slug: 'site-root',
      label: 'root 的站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18101,
      baseUrl: 'http://127.0.0.1:18101',
      status: 'active',
    },
    {
      operatorId,
      slug: 'site-op',
      label: 'operator 的站',
      engine: 'newapi',
      version: 'v1.0.0',
      hostPort: 18102,
      baseUrl: 'http://127.0.0.1:18102',
    },
  ]);
}, 60_000);

afterAll(async () => {
  await ts.close();
});

describe('认证钩子', () => {
  it('/healthz 免认证', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('未登录 /api/sites → 401', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });

  it('伪造 cookie → 401', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/sites',
      cookies: { rp_session: 'f'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('登录后 req.ctx 流入 F2 路由（/api/auth/me）', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'root@example.com', role: 'root' });
  });

  it('登录后 req.ctx 流入 F3 jobs 路由', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/jobs', cookies: { rp_session: operatorCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobs: [] });
  });
});

describe('sites 占位路由: 角色过滤', () => {
  it('root 看全部站', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sites: { slug: string; operatorEmail: string }[]; generatedAt: string };
    expect(body.generatedAt).toBeTruthy();
    expect(body.sites.map((s) => s.slug).sort()).toEqual(['site-op', 'site-root']);
  });

  it('operator 只见 own 站', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: operatorCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sites: { slug: string; operatorId: number }[] };
    expect(body.sites.map((s) => s.slug)).toEqual(['site-op']);
    expect(body.sites[0]!.operatorId).toBe(operatorId);
  });

  it('单站详情: own 200，他人站 404（不泄露存在性），不存在 404', async () => {
    const ok = await ts.app.inject({ method: 'GET', url: '/api/sites/site-op', cookies: { rp_session: operatorCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ slug: 'site-op', operatorEmail: 'op@example.com' });

    const other = await ts.app.inject({ method: 'GET', url: '/api/sites/site-root', cookies: { rp_session: operatorCookie } });
    expect(other.statusCode).toBe(404);

    const missing = await ts.app.inject({ method: 'GET', url: '/api/sites/no-such', cookies: { rp_session: rootCookie } });
    expect(missing.statusCode).toBe(404);
  });

  it('响应不含 credentialRef 等内部字段', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    expect(res.body).not.toContain('credentialRef');
    expect(res.body).not.toContain('dataDir');
  });
});

describe('CSRF 钩子', () => {
  it('异源 Origin 的 POST /api/* → 403（带合法会话同样拒绝）', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      headers: { origin: 'https://evil.example.com' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain('跨站');
  });

  it('同源 Origin 放行（host 部分一致）', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      headers: { host: 'panel.example.com', origin: 'https://panel.example.com' },
      payload: {},
    });
    // 通过 CSRF 与认证后落到 G1 真实现：空 body 校验失败 400（而非 403）
    expect(res.statusCode).toBe(400);
  });

  it('无 Origin 的非浏览器请求放行；GET 不检查 Origin', async () => {
    const post = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    // G1 真实现：空 body 校验失败 400（放行了 CSRF 即达到断言目的）
    expect(post.statusCode).toBe(400);

    const get = await ts.app.inject({
      method: 'GET',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      headers: { origin: 'https://evil.example.com' },
    });
    expect(get.statusCode).toBe(200);
  });
});

describe('占位端点与真实读', () => {
  it('全部模块端点已真实现（无 501 残留）', async () => {
    const cases: { url: string }[] = [
      { url: '/api/alerts' },
      { url: '/api/billing/subscription' },
      { url: '/api/sites/site-op/domains' },
    ];
    for (const c of cases) {
      const res = await ts.app.inject({ method: 'GET', url: c.url, cookies: { rp_session: rootCookie } });
      expect(res.statusCode, `GET ${c.url}`).toBe(200);
    }
  });

  it('GET /api/billing/plans 真读 DB 种子三档', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/billing/plans', cookies: { rp_session: operatorCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plans: { key: string; siteQuota: number }[] };
    expect(body.plans.map((p) => p.key)).toEqual(['free', 'pro', 'scale']);
    expect(body.plans[0]!.siteQuota).toBe(1);
  });
});

describe('/metrics', () => {
  it('无 session 无 token → 401；错误 token → 401', async () => {
    const none = await ts.app.inject({ method: 'GET', url: '/metrics' });
    expect(none.statusCode).toBe(401);
    const bad = await ts.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('Bearer RP_METRICS_TOKEN → 200 Prometheus 文本', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE rp_sites_total gauge');
    expect(res.body).toContain('rp_sites_total{status="active"} 1');
    expect(res.body).toContain('rp_sites_total{status="pending"} 1');
    expect(res.body).toContain('# TYPE rp_jobs_total gauge');
    expect(res.body).toContain('# TYPE rp_alerts_open gauge');
  });

  it('合法 session 也可访问', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/metrics', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('rp_sites_total');
  });
});

describe('静态托管与 404 回落', () => {
  it('未知 /api/* → 404 JSON', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/no-such-endpoint', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: '接口不存在' });
  });

  it('web dist 缺失时非 API 路径回中文提示页', async () => {
    // 显式指向不存在目录：不受 packages/web/dist 是否已构建影响
    const bare = await makeTestServer({ config: { webDist: './no-such-dist-dir' } });
    try {
      const res = await bare.app.inject({ method: 'GET', url: '/some-spa-page' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('web 未构建');
    } finally {
      await bare.close();
    }
  });
});
