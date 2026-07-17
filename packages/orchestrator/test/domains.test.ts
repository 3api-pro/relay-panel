import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, sites } from '../src/db/schema.js';
import { applyDomains, buildRoute, removeDomains } from '../src/domains/caddy.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * G4 域名模块测试：CRUD + 校验 + 权限（无 caddy 纯 DB 模式）、
 * caddy 客户端请求形状（本地 fastify 假 caddy admin）、下发失败回滚。
 * pglite 冷启动约 4s，整文件共享一个 db（两个 server 实例复用同一 db）。
 */

vi.setConfig({ testTimeout: 30_000 });

interface RecordedReq {
  method: string;
  url: string;
  body?: unknown;
}

interface FakeCaddy {
  url: string;
  requests: RecordedReq[];
  state: { fail: boolean; routeExists: boolean };
  close(): Promise<void>;
}

/** 本地假 caddy admin server：记录请求形状，可注入 500 失败 */
async function makeFakeCaddy(): Promise<FakeCaddy> {
  const app = Fastify();
  const requests: RecordedReq[] = [];
  const state = { fail: false, routeExists: false };

  app.delete<{ Params: { id: string } }>('/id/:id', async (req, reply) => {
    requests.push({ method: 'DELETE', url: req.url });
    if (state.fail) return reply.code(500).send({ error: 'injected caddy failure' });
    if (!state.routeExists) return reply.code(404).send({ error: 'unknown object' });
    state.routeExists = false;
    return {};
  });
  app.put('/config/apps/http/servers/rp/routes', async (req, reply) => {
    requests.push({ method: 'PUT', url: req.url, body: req.body });
    if (state.fail) return reply.code(500).send({ error: 'injected caddy failure' });
    state.routeExists = true;
    return {};
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.addresses().find((a) => a.family === 'IPv4') ?? app.addresses()[0]!;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    state,
    close: async () => {
      await app.close();
    },
  };
}

let ts: TestServer; // 无 caddy（纯 DB 模式）
let tsCaddy: TestServer; // 配置了 caddyAdminUrl，复用同一 db
let caddy: FakeCaddy;
let rootCookie: string;
let opCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  ts = await makeTestServer();
  caddy = await makeFakeCaddy();
  tsCaddy = await makeTestServer({ db: ts.db, config: { caddyAdminUrl: caddy.url } });

  const root = await ts.seedLogin({ email: 'dom-root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const op = await ts.seedLogin({ email: 'dom-op@example.com', password: 'op-pass-1234', role: 'operator' });
  opCookie = op.cookie;
  const viewer = await ts.seedLogin({
    email: 'dom-viewer@example.com',
    password: 'viewer-pass-1234',
    role: 'viewer',
  });
  viewerCookie = viewer.cookie;

  await ts.db.orm.insert(sites).values([
    {
      operatorId: op.operatorId,
      slug: 'dom-a',
      label: 'operator 的站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18201,
      baseUrl: 'http://127.0.0.1:18201',
      status: 'active',
    },
    {
      operatorId: root.operatorId,
      slug: 'dom-b',
      label: 'root 的站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18202,
      baseUrl: 'http://127.0.0.1:18202',
      status: 'active',
    },
    {
      operatorId: op.operatorId,
      slug: 'dom-c',
      label: 'caddy 联动站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18203,
      baseUrl: 'http://127.0.0.1:18203',
      status: 'active',
    },
  ]);
}, 60_000);

afterAll(async () => {
  await tsCaddy.close();
  await ts.close();
  await caddy.close();
});

async function domainsInDb(slug: string): Promise<string[]> {
  const row = (await ts.db.orm.select().from(sites).where(eq(sites.slug, slug)).limit(1))[0];
  return row!.domains;
}

describe('无 caddy：纯 DB 模式', () => {
  it('初始为空列表', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/dom-a/domains',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ domains: [] });
  });

  it('非法域名 400', async () => {
    for (const domain of ['bad_domain', 'foo', 'foo.x', 'has space.com', 'a.example.com/path']) {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/sites/dom-a/domains',
        cookies: { rp_session: opCookie },
        payload: { domain },
      });
      expect(res.statusCode, domain).toBe(400);
    }
  });

  it('添加域名（大小写归一）→ DB 落盘', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/dom-a/domains',
      cookies: { rp_session: opCookie },
      payload: { domain: 'A.Example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ domains: ['a.example.com'] });
    expect(await domainsInDb('dom-a')).toEqual(['a.example.com']);
  });

  it('重复添加 409', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/dom-a/domains',
      cookies: { rp_session: opCookie },
      payload: { domain: 'a.example.com' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('viewer 禁写 403；operator 他人站 404（读写均不泄露存在性）', async () => {
    const viewerPost = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/dom-a/domains',
      cookies: { rp_session: viewerCookie },
      payload: { domain: 'v.example.com' },
    });
    expect(viewerPost.statusCode).toBe(403);

    const otherGet = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/dom-b/domains',
      cookies: { rp_session: opCookie },
    });
    expect(otherGet.statusCode).toBe(404);

    const otherPost = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/dom-b/domains',
      cookies: { rp_session: opCookie },
      payload: { domain: 'x.example.com' },
    });
    expect(otherPost.statusCode).toBe(404);
  });

  it('删除不存在的域名 404；删除存在的域名成功', async () => {
    const missing = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/dom-a/domains/missing.example.com',
      cookies: { rp_session: opCookie },
    });
    expect(missing.statusCode).toBe(404);

    const ok = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/dom-a/domains/a.example.com',
      cookies: { rp_session: opCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ domains: [] });
    expect(await domainsInDb('dom-a')).toEqual([]);
  });

  it('审计落盘 domain.add / domain.remove（带 siteId）', async () => {
    const rows = await ts.db.orm.select().from(auditEvents);
    const add = rows.filter((r) => r.action === 'domain.add' && r.ok);
    const remove = rows.filter((r) => r.action === 'domain.remove' && r.ok);
    expect(add.length).toBeGreaterThan(0);
    expect(remove.length).toBeGreaterThan(0);
    expect(add[0]!.siteId).not.toBeNull();
    expect(add[0]!.payload).toMatchObject({ slug: 'dom-a', domain: 'a.example.com' });
  });

  it('未登录 401', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites/dom-a/domains' });
    expect(res.statusCode).toBe(401);
  });
});

describe('caddy 客户端（直调，假 caddy admin 断言请求形状）', () => {
  it('applyDomains：DELETE @id（404 忽略）→ PUT 路由对象', async () => {
    caddy.requests.length = 0;
    caddy.state.routeExists = false; // 首次下发：DELETE 会 404，必须被忽略
    await applyDomains(caddy.url, 'site-x', ['x.example.com', 'y.example.com'], 18201);

    expect(caddy.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'DELETE /id/rp-site-x',
      'PUT /config/apps/http/servers/rp/routes',
    ]);
    expect(caddy.requests[1]!.body).toEqual({
      '@id': 'rp-site-x',
      match: [{ host: ['x.example.com', 'y.example.com'] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:18201' }] }],
    });
    expect(caddy.requests[1]!.body).toEqual(buildRoute('site-x', ['x.example.com', 'y.example.com'], 18201));
  });

  it('applyDomains 空列表 / removeDomains：只 DELETE 不 PUT', async () => {
    caddy.requests.length = 0;
    await applyDomains(caddy.url, 'site-x', [], 18201);
    await removeDomains(caddy.url, 'site-x');
    expect(caddy.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'DELETE /id/rp-site-x',
      'DELETE /id/rp-site-x',
    ]);
  });

  it('caddy 非 2xx（非 404）→ 抛错，错误信息含状态码', async () => {
    caddy.state.fail = true;
    try {
      await expect(applyDomains(caddy.url, 'site-x', ['x.example.com'], 18201)).rejects.toThrow(/500/);
    } finally {
      caddy.state.fail = false;
    }
  });
});

describe('配置了 caddy：路由级下发与失败回滚', () => {
  it('添加域名 → caddy 收到 DELETE + PUT（形状正确）', async () => {
    caddy.requests.length = 0;
    caddy.state.routeExists = false;
    const res = await tsCaddy.app.inject({
      method: 'POST',
      url: '/api/sites/dom-c/domains',
      cookies: { rp_session: opCookie },
      payload: { domain: 'c.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ domains: ['c.example.com'] });
    expect(caddy.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'DELETE /id/rp-dom-c',
      'PUT /config/apps/http/servers/rp/routes',
    ]);
    expect(caddy.requests[1]!.body).toEqual({
      '@id': 'rp-dom-c',
      match: [{ host: ['c.example.com'] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:18203' }] }],
    });
  });

  it('下发失败 → 502 且 DB 回滚（含失败审计）', async () => {
    caddy.state.fail = true;
    try {
      const res = await tsCaddy.app.inject({
        method: 'POST',
        url: '/api/sites/dom-c/domains',
        cookies: { rp_session: opCookie },
        payload: { domain: 'd.example.com' },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      caddy.state.fail = false;
    }
    // DB 已回滚到下发前
    expect(await domainsInDb('dom-c')).toEqual(['c.example.com']);
    const rows = await ts.db.orm.select().from(auditEvents);
    const failed = rows.filter((r) => r.action === 'domain.add' && !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.payload).toMatchObject({ domain: 'd.example.com' });
  });

  it('删除最后一个域名 → caddy 只 DELETE（空列表不再 PUT）', async () => {
    caddy.requests.length = 0;
    const res = await tsCaddy.app.inject({
      method: 'DELETE',
      url: '/api/sites/dom-c/domains/c.example.com',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ domains: [] });
    expect(await domainsInDb('dom-c')).toEqual([]);
    expect(caddy.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['DELETE /id/rp-dom-c']);
  });

  it('删除时下发失败 → 502 且 DB 回滚', async () => {
    // 先加回一个域名
    const add = await tsCaddy.app.inject({
      method: 'POST',
      url: '/api/sites/dom-c/domains',
      cookies: { rp_session: opCookie },
      payload: { domain: 'e.example.com' },
    });
    expect(add.statusCode).toBe(200);

    caddy.state.fail = true;
    try {
      const res = await tsCaddy.app.inject({
        method: 'DELETE',
        url: '/api/sites/dom-c/domains/e.example.com',
        cookies: { rp_session: opCookie },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      caddy.state.fail = false;
    }
    expect(await domainsInDb('dom-c')).toEqual(['e.example.com']);
  });
});
