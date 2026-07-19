import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, channelGrants, sites, subscriptions } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import type { SessionCtx } from '../src/auth/rbac.js';
import { applyGrant, importTemplates } from '../src/marketplace/grant.js';
import { HttpMeteringGateway } from '../src/marketplace/gateway.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 渠道市场（G2，规格 §7）：模板 CRUD 权限矩阵 / byo+managed 授权全链 /
 * 注入失败回滚 / 撤销(含 force) / HttpMeteringGateway HTTP 契约 / importTemplates。
 * pglite 冷启动约 4s，整文件共享一个测试服务。
 */

vi.setConfig({ testTimeout: 30_000 });

const BYO_SECRET = 'sk-byo-secret-1';

let ts: TestServer;
let rootCookie: string;
let rootId: number;
let opCookie: string;
let opBCookie: string;
let viewerCookie: string;

let tplByoId = 0;
let managedGrantId = 0;
let managedKeyRef = '';

async function createTemplate(fields: Record<string, unknown>): Promise<{ id: number; key: string }> {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/marketplace/templates',
    cookies: { rp_session: rootCookie },
    payload: { title: '模板', protocol: 'anthropic', models: ['model-a'], ...fields },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: number; key: string };
}

beforeAll(async () => {
  ts = await makeTestServer();
  const root = await ts.seedLogin({ email: 'root-mkt@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  rootId = root.operatorId;
  const opA = await ts.seedLogin({ email: 'op-a-mkt@example.com', password: 'op-pass-1234', role: 'operator' });
  opCookie = opA.cookie;
  const opB = await ts.seedLogin({ email: 'op-b-mkt@example.com', password: 'op-pass-1234', role: 'operator' });
  opBCookie = opB.cookie;
  const viewer = await ts.seedLogin({ email: 'viewer-mkt@example.com', password: 'vw-pass-1234', role: 'viewer' });
  viewerCookie = viewer.cookie;

  // opA 配有效订阅：managed 授权门槛（§1）要求付费订阅，本文件的 managed 流程用例据此放行。
  // 免费 operator → 403 的门槛本身在 marketplace-sub-gate.test.ts 单独覆盖。
  await ts.db.orm.insert(subscriptions).values({
    operatorId: opA.operatorId,
    planKey: 'pro',
    currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 30 * 86_400_000)),
  });

  await ts.db.orm.insert(sites).values([
    {
      operatorId: opA.operatorId,
      slug: 'site-a',
      label: 'A 站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18201,
      baseUrl: 'http://127.0.0.1:18201',
      status: 'active',
    },
    {
      operatorId: opB.operatorId,
      slug: 'site-b',
      label: 'B 站',
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18202,
      baseUrl: 'http://127.0.0.1:18202',
      status: 'active',
    },
  ]);
}, 60_000);

afterAll(async () => {
  await ts.close();
});

describe('模板 CRUD 权限矩阵', () => {
  it('root 创建；重复 key → 409；参数缺失 → 400', async () => {
    const created = await createTemplate({ key: 'tpl-perm', source: 'byo' });
    expect(created.key).toBe('tpl-perm');

    const dup = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/templates',
      cookies: { rp_session: rootCookie },
      payload: { key: 'tpl-perm', title: 'x', protocol: 'anthropic', models: ['m'] },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/templates',
      cookies: { rp_session: rootCookie },
      payload: { title: '缺 key' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('operator/viewer 写模板 → 403', async () => {
    const cases = [
      { method: 'POST' as const, url: '/api/marketplace/templates', cookie: opCookie },
      { method: 'POST' as const, url: '/api/marketplace/templates', cookie: viewerCookie },
      { method: 'PATCH' as const, url: '/api/marketplace/templates/1', cookie: opCookie },
      { method: 'DELETE' as const, url: '/api/marketplace/templates/1', cookie: viewerCookie },
    ];
    for (const c of cases) {
      const res = await ts.app.inject({
        method: c.method,
        url: c.url,
        cookies: { rp_session: c.cookie },
        payload: { key: 'nope', title: 'x', protocol: 'anthropic', models: ['m'] },
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
  });

  it('停用模板从普通列表消失；root ?all=1 可见；operator ?all=1 无效', async () => {
    const hide = await createTemplate({ key: 'tpl-hide' });
    const patched = await ts.app.inject({
      method: 'PATCH',
      url: `/api/marketplace/templates/${hide.id}`,
      cookies: { rp_session: rootCookie },
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);

    const keysOf = (body: string): string[] =>
      (JSON.parse(body) as { templates: { key: string }[] }).templates.map((t) => t.key);

    const asOp = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/templates',
      cookies: { rp_session: opCookie },
    });
    expect(asOp.statusCode).toBe(200);
    expect(keysOf(asOp.body)).not.toContain('tpl-hide');

    const asRootAll = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/templates?all=1',
      cookies: { rp_session: rootCookie },
    });
    expect(keysOf(asRootAll.body)).toContain('tpl-hide');

    const asOpAll = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/templates?all=1',
      cookies: { rp_session: opCookie },
    });
    expect(keysOf(asOpAll.body)).not.toContain('tpl-hide');
  });

  it('PATCH/DELETE 不存在 → 404；未被引用可删', async () => {
    const missing = await ts.app.inject({
      method: 'PATCH',
      url: '/api/marketplace/templates/999999',
      cookies: { rp_session: rootCookie },
      payload: { title: '新标题' },
    });
    expect(missing.statusCode).toBe(404);

    const del = await createTemplate({ key: 'tpl-del' });
    const removed = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/templates/${del.id}`,
      cookies: { rp_session: rootCookie },
    });
    expect(removed.statusCode).toBe(200);
  });
});

describe('byo 授权全链', () => {
  beforeAll(async () => {
    const tpl = await createTemplate({
      key: 'tpl-byo',
      title: 'Claude BYO',
      source: 'byo',
      models: ['claude-sonnet-4'],
      modelMapping: { 'claude-sonnet-4': 'claude-sonnet-4-latest' },
    });
    tplByoId = tpl.id;
  });

  it('注入渠道 + 落 channel_grants + 审计；key 绝不出现在响应与审计', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: {
        siteSlug: 'site-a',
        templateKey: 'tpl-byo',
        channelName: '渠道A',
        byo: { baseUrl: 'https://upstream.example.com', apiKey: BYO_SECRET },
        groupIds: ['g1'],
        priority: 3,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { id: number; siteSlug: string; status: string; managed: boolean };
    expect(view).toMatchObject({
      siteSlug: 'site-a',
      templateKey: 'tpl-byo',
      channelName: '渠道A',
      status: 'active',
      managed: false,
      createdBy: 'op-a-mkt@example.com',
    });
    // 响应绝不含 apiKey 明文
    expect(res.body).not.toContain(BYO_SECRET);

    // 渠道真实注入到目标站引擎（fake 状态）
    const chan = ts.adapters.sub2api.stateFor('site-a').channels.find((c) => c.name === '渠道A');
    expect(chan).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://upstream.example.com',
      apiKey: BYO_SECRET,
      models: ['claude-sonnet-4'],
      modelMapping: { 'claude-sonnet-4': 'claude-sonnet-4-latest' },
      groups: ['g1'],
      priority: 3,
    });

    // channel_grants 行：byo 无 meterKeyRef
    const rows = await ts.db.orm.select().from(channelGrants).where(eq(channelGrants.id, view.id));
    expect(rows[0]).toMatchObject({ meterKeyRef: null, status: 'active', createdBy: 'op-a-mkt@example.com' });

    // 审计存在且不含 key 明文
    const audits = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'marketplace.grant'));
    const okRow = audits.find((a) => a.ok);
    expect(okRow?.payload?.template).toBe('tpl-byo');
    expect(JSON.stringify(audits)).not.toContain(BYO_SECRET);
  });

  it('byo 模板缺 byo 参数 → 400；模板不存在 → 404；停用模板 → 400', async () => {
    const noByo = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: { siteSlug: 'site-a', templateKey: 'tpl-byo' },
    });
    expect(noByo.statusCode).toBe(400);

    const unknown = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: { siteSlug: 'site-a', templateKey: 'no-such-tpl' },
    });
    expect(unknown.statusCode).toBe(404);

    const disabled = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: { siteSlug: 'site-a', templateKey: 'tpl-hide' },
    });
    expect(disabled.statusCode).toBe(400);
    // ApiError 的中文消息经 fastify 默认序列化落在 message 字段
    expect((disabled.json() as { message: string }).message).toContain('停用');
  });

  it('operator 不能授权他人站（404 不泄露存在性）；viewer → 403', async () => {
    const other = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opBCookie },
      payload: {
        siteSlug: 'site-a',
        templateKey: 'tpl-byo',
        byo: { baseUrl: 'https://upstream.example.com', apiKey: 'sk-x' },
      },
    });
    expect(other.statusCode).toBe(404);

    const viewer = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: viewerCookie },
      payload: {
        siteSlug: 'site-a',
        templateKey: 'tpl-byo',
        byo: { baseUrl: 'https://upstream.example.com', apiKey: 'sk-x' },
      },
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('managed 授权与回滚', () => {
  beforeAll(async () => {
    await createTemplate({
      key: 'tpl-managed',
      title: 'GPT 托管',
      source: 'managed',
      protocol: 'openai',
      models: ['gpt-4o'],
    });
  });

  it('网关签发 key → 注入 → meterKeyRef 落库；响应不泄露 keyRef/apiKey', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: { siteSlug: 'site-a', templateKey: 'tpl-managed' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { id: number; managed: boolean };
    expect(view.managed).toBe(true);
    managedGrantId = view.id;

    const issued = ts.gateway.issued.at(-1)!;
    expect(issued).toMatchObject({ siteSlug: 'site-a', templateKey: 'tpl-managed', models: ['gpt-4o'] });
    managedKeyRef = issued.keyRef;

    const rows = await ts.db.orm.select().from(channelGrants).where(eq(channelGrants.id, view.id));
    expect(rows[0]!.meterKeyRef).toBe(managedKeyRef);

    // 注入的渠道用网关签发的 baseUrl/apiKey
    const chan = ts.adapters.sub2api.stateFor('site-a').channels.find((c) => c.name === 'GPT 托管');
    expect(chan).toMatchObject({ baseUrl: 'https://gateway.example.com/v1', apiKey: `sk-fake-${managedKeyRef}` });

    // 响应不含 keyRef 与签发的 key
    expect(res.body).not.toContain(managedKeyRef);
    expect(res.body).not.toContain('sk-fake-');
  });

  it('managed 模板带 byo 参数 → 400', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: {
        siteSlug: 'site-a',
        templateKey: 'tpl-managed',
        byo: { baseUrl: 'https://upstream.example.com', apiKey: 'sk-x' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('注入失败 → 回滚吊销已签发的 key，不落授权行', async () => {
    ts.adapters.sub2api.failOn('channels.create');
    try {
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/marketplace/grants',
        cookies: { rp_session: opCookie },
        payload: { siteSlug: 'site-a', templateKey: 'tpl-managed' },
      });
      expect(res.statusCode).toBe(502);
      const issuedRef = ts.gateway.issued.at(-1)!.keyRef;
      expect(issuedRef).not.toBe(managedKeyRef); // 确认是本次新签发的
      expect(ts.gateway.revoked).toContain(issuedRef);
      const orphan = await ts.db.orm
        .select()
        .from(channelGrants)
        .where(eq(channelGrants.meterKeyRef, issuedRef));
      expect(orphan).toHaveLength(0);
    } finally {
      ts.adapters.sub2api.clearFailure('channels.create');
    }
  });

  it('网关未配置 → 400 计量网关未配置（服务级直调）', async () => {
    const ctx: SessionCtx = { operatorId: rootId, email: 'root-mkt@example.com', role: 'root' };
    await expect(
      applyGrant(
        { config: ts.config, db: ts.db, adapters: ts.adapters, gateway: null },
        ctx,
        { siteSlug: 'site-a', templateKey: 'tpl-managed' },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: '计量网关未配置' });
  });
});

describe('撤销', () => {
  it('managed 正常撤销：站内删渠道 + 网关吊销 + 状态 revoked + 审计', async () => {
    const before = ts.adapters.sub2api.stateFor('site-a').channels.length;
    const res = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${managedGrantId}`,
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { status: string }).status).toBe('revoked');

    expect(ts.adapters.sub2api.stateFor('site-a').channels.length).toBe(before - 1);
    expect(ts.gateway.revoked).toContain(managedKeyRef);

    const rows = await ts.db.orm.select().from(channelGrants).where(eq(channelGrants.id, managedGrantId));
    expect(rows[0]!.status).toBe('revoked');
    expect(rows[0]!.revokedAt).not.toBeNull();

    const audits = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'marketplace.revoke'));
    expect(audits.some((a) => a.ok && a.payload?.grantId === managedGrantId)).toBe(true);
  });

  it('重复撤销 → 400', async () => {
    const res = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${managedGrantId}`,
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('渠道删除失败：无 force → 502；?force=1 → 仅改状态成功', async () => {
    const create = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
      payload: {
        siteSlug: 'site-a',
        templateKey: 'tpl-byo',
        channelName: '待强撤',
        byo: { baseUrl: 'https://upstream.example.com', apiKey: 'sk-force-1' },
      },
    });
    expect(create.statusCode).toBe(200);
    const view = create.json() as { id: number; engineChannelId: string };

    // 模拟渠道已在站内被人工删除 → channels.remove 报错
    const state = ts.adapters.sub2api.stateFor('site-a');
    state.channels = state.channels.filter((c) => c.id !== view.engineChannelId);

    const noForce = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${view.id}`,
      cookies: { rp_session: opCookie },
    });
    expect(noForce.statusCode).toBe(502);

    const forced = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${view.id}?force=1`,
      cookies: { rp_session: opCookie },
    });
    expect(forced.statusCode, forced.body).toBe(200);
    const rows = await ts.db.orm.select().from(channelGrants).where(eq(channelGrants.id, view.id));
    expect(rows[0]!.status).toBe('revoked');
  });

  it('viewer → 403；他人授权 → 404；模板已有授权 → 模板不可删', async () => {
    const anyGrant = (await ts.db.orm.select().from(channelGrants).limit(1))[0]!;
    const viewer = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${anyGrant.id}`,
      cookies: { rp_session: viewerCookie },
    });
    expect(viewer.statusCode).toBe(403);

    const other = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/grants/${anyGrant.id}`,
      cookies: { rp_session: opBCookie },
    });
    expect(other.statusCode).toBe(404);

    const delTpl = await ts.app.inject({
      method: 'DELETE',
      url: `/api/marketplace/templates/${tplByoId}`,
      cookies: { rp_session: rootCookie },
    });
    expect(delTpl.statusCode).toBe(400);
  });
});

describe('授权列表', () => {
  it('operator 只见自己站；root 全量；?siteSlug 过滤；不泄露 meterKeyRef', async () => {
    const asOpA = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/grants',
      cookies: { rp_session: opCookie },
    });
    expect(asOpA.statusCode).toBe(200);
    const opGrants = (asOpA.json() as { grants: { siteSlug: string }[] }).grants;
    expect(opGrants.length).toBeGreaterThan(0);
    expect(opGrants.every((g) => g.siteSlug === 'site-a')).toBe(true);
    expect(asOpA.body).not.toContain('meter-');
    expect(asOpA.body).not.toContain('sk-');

    const asOpB = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/grants?siteSlug=site-a',
      cookies: { rp_session: opBCookie },
    });
    expect((asOpB.json() as { grants: unknown[] }).grants).toHaveLength(0);

    const asRoot = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/grants?siteSlug=site-a',
      cookies: { rp_session: rootCookie },
    });
    expect((asRoot.json() as { grants: unknown[] }).grants.length).toBe(opGrants.length);
  });
});

describe('HttpMeteringGateway HTTP 契约', () => {
  const GW_TOKEN = 'gw-test-token-xyz';
  let server: Server;
  let port = 0;
  let mode: 'ok' | 'http500' | 'badshape' | 'del404' = 'ok';
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];

  function respond(req: IncomingMessage, res: ServerResponse): void {
    if (mode === 'http500') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (mode === 'badshape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/keys') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keyRef: 'kr-1', apiKey: 'sk-live-abc', baseUrl: 'https://gw.example.com/v1' }));
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/v1/keys/')) {
      // 契约 §3.2：keyRef 不存在返回 404（与 204 同视为幂等成功）
      res.writeHead(mode === 'del404' ? 404 : 204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          rows: [
            {
              periodStart: '2026-07-01T00:00:00.000Z',
              periodEnd: '2026-07-02T00:00:00.000Z',
              requests: 3,
              promptTokens: 100,
              completionTokens: 50,
              upstreamCost: 0.1,
              billedCost: 0.2,
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('issueKey: POST /v1/keys 带 Bearer；body {site,template,models}', async () => {
    mode = 'ok';
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}`, GW_TOKEN);
    const issued = await gw.issueKey({ siteSlug: 'site-a', templateKey: 'tpl-x', models: ['m-1'] });
    expect(issued).toEqual({ keyRef: 'kr-1', apiKey: 'sk-live-abc', baseUrl: 'https://gw.example.com/v1' });
    const req = seen.at(-1)!;
    expect(req).toMatchObject({ method: 'POST', url: '/v1/keys', auth: `Bearer ${GW_TOKEN}` });
    expect(JSON.parse(req.body)).toEqual({ site: 'site-a', template: 'tpl-x', models: ['m-1'] });
  });

  it('revokeKey: DELETE /v1/keys/{keyRef}（编码）', async () => {
    mode = 'ok';
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}/`, GW_TOKEN);
    await gw.revokeKey('kr 1/x');
    const req = seen.at(-1)!;
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe(`/v1/keys/${encodeURIComponent('kr 1/x')}`);
  });

  it('revokeKey: 未知 keyRef 返回 404 视为幂等成功（契约 §3.2，不抛错）', async () => {
    mode = 'del404';
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}`, GW_TOKEN);
    await expect(gw.revokeKey('kr_doesnotexist')).resolves.toBeUndefined();
    mode = 'ok';
  });

  it('revokeKey: 其余非 2xx（500）仍抛错，错误不含 token', async () => {
    mode = 'http500';
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}`, GW_TOKEN);
    const err = await gw
      .revokeKey('kr-1')
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('HTTP 500');
    expect(err!.message).not.toContain(GW_TOKEN);
    mode = 'ok';
  });

  it('pullUsage: GET /v1/usage?keyRef=&from=&to=', async () => {
    mode = 'ok';
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}`, GW_TOKEN);
    const from = new Date('2026-07-01T00:00:00Z');
    const to = new Date('2026-07-05T00:00:00Z');
    const rows = await gw.pullUsage('kr-1', from, to);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBe(3);
    const req = seen.at(-1)!;
    expect(req.url).toContain('keyRef=kr-1');
    expect(req.url).toContain(encodeURIComponent(from.toISOString()));
  });

  it('非 2xx 抛错且错误信息不含 token；响应形状非法抛格式错误', async () => {
    const gw = new HttpMeteringGateway(`http://127.0.0.1:${port}`, GW_TOKEN);
    mode = 'http500';
    const err = await gw
      .issueKey({ siteSlug: 's', templateKey: 't', models: [] })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('HTTP 500');
    expect(err!.message).not.toContain(GW_TOKEN);

    mode = 'badshape';
    await expect(gw.issueKey({ siteSlug: 's', templateKey: 't', models: [] })).rejects.toThrow(/格式无效/);
    await expect(gw.pullUsage('kr-1', new Date(), new Date())).rejects.toThrow(/格式无效/);
    mode = 'ok';
  });
});

describe('importTemplates（CLI import-templates 主体）', () => {
  it('key 幂等 upsert：首次新增，二次更新', async () => {
    const items = [
      { key: 'imp-a', title: '导入A', protocol: 'anthropic', models: ['m-1'] },
      { key: 'imp-b', title: '导入B', protocol: 'openai', models: ['m-2'], source: 'managed' },
    ];
    const first = await importTemplates(ts.db, items);
    expect(first).toEqual({ inserted: 2, updated: 0 });

    const second = await importTemplates(ts.db, [{ ...items[0], title: '导入A v2' }, items[1]]);
    expect(second).toEqual({ inserted: 0, updated: 2 });

    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/templates',
      cookies: { rp_session: rootCookie },
    });
    const tpl = (JSON.parse(res.body) as { templates: { key: string; title: string }[] }).templates.find(
      (t) => t.key === 'imp-a',
    );
    expect(tpl?.title).toBe('导入A v2');
  });

  it('templates.example.json 示例文件可直接导入', async () => {
    const raw = await readFile(new URL('../src/marketplace/templates.example.json', import.meta.url), 'utf8');
    const result = await importTemplates(ts.db, JSON.parse(raw));
    expect(result.inserted + result.updated).toBe(2);
  });

  it('非法输入 → 400', async () => {
    await expect(importTemplates(ts.db, [{ key: 'BAD KEY' }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(importTemplates(ts.db, { not: 'array' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
