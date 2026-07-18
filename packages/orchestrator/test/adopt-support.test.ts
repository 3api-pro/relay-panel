import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { credentials, sites, subscriptions } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 自助接管（POST /api/sites/adopt）+ readonly 保险丝 + 支持面设置 测试。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let opCookie: string;
let opId: number;

beforeAll(async () => {
  ts = await makeTestServer();
  const root = await ts.seedLogin({ email: 'ad-root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const op = await ts.seedLogin({ email: 'ad-op@example.com', password: 'op-pass-1234', role: 'operator' });
  opCookie = op.cookie;
  opId = op.operatorId;
  // operator 给 pro 配额（5 站），配额边界单测另行覆盖 free 档
  await ts.db.orm.insert(subscriptions).values({
    operatorId: opId,
    planKey: 'pro',
    currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 30 * 86_400_000)),
  });
}, 60_000);

afterAll(async () => {
  await ts.close();
});

function adoptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'legacy-a',
    label: '存量站 A',
    baseUrl: 'http://127.0.0.1:3272',
    engine: 'sub2api',
    adminApiKey: 'sk-legacy-admin',
    ...overrides,
  };
}

describe('adopt 自助接管', () => {
  it('凭据缺失 → 400', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: adoptPayload({ adminApiKey: undefined }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('健康探测失败 → 409 且不留半接入行/凭据', async () => {
    ts.adapters.sub2api.failOn('health', 'connection refused');
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: adoptPayload(),
    });
    expect(res.statusCode).toBe(409);
    ts.adapters.sub2api.clearFailure('health');

    const rows = await ts.db.orm.select().from(sites).where(eq(sites.slug, 'legacy-a'));
    expect(rows).toHaveLength(0);
    const creds = await ts.db.orm.select().from(credentials).where(eq(credentials.ref, 'enc:legacy-a'));
    expect(creds).toHaveLength(0);
  });

  it('admin 凭据实连失败（connect 抛错）→ 409 回滚', async () => {
    ts.adapters.sub2api.failOn('connect', 'invalid admin key');
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: adoptPayload(),
    });
    expect(res.statusCode).toBe(409);
    ts.adapters.sub2api.clearFailure('connect');
    expect(await ts.db.orm.select().from(sites).where(eq(sites.slug, 'legacy-a'))).toHaveLength(0);
  });

  it('成功接管：managed=external、readonly 生效、凭据密文入库、归属 operator', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: adoptPayload({ readonly: true }),
    });
    expect(res.statusCode).toBe(201);

    const row = (await ts.db.orm.select().from(sites).where(eq(sites.slug, 'legacy-a')))[0]!;
    expect(row.managed).toBe('external');
    expect(row.readonly).toBe(true);
    expect(row.operatorId).toBe(opId);
    expect(row.status).toBe('active');
    expect(row.hostPort).toBe(3272);

    const cred = (await ts.db.orm.select().from(credentials).where(eq(credentials.ref, 'enc:legacy-a')))[0]!;
    expect(cred.ciphertext.startsWith('v1:')).toBe(true);
    expect(cred.ciphertext).not.toContain('sk-legacy-admin');

    // 列表视图带 readonly 标记且不泄露 baseUrl/credentialRef
    const list = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: opCookie } });
    const view = (list.json() as { sites: Array<Record<string, unknown>> }).sites.find((s) => s.slug === 'legacy-a')!;
    expect(view.managed).toBe('external');
    expect(view.readonly).toBe(true);
    expect(JSON.stringify(view)).not.toContain('credentialRef');
    expect(JSON.stringify(view)).not.toContain('sk-legacy-admin');
  });

  it('slug 重复 → 409', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: adoptPayload(),
    });
    expect(res.statusCode).toBe(409);
  });

  it('readonly 保险丝：引擎写 403；关只读后放行；external 站生命周期仍拒绝', async () => {
    const channelPayload = {
      name: 'ch-1',
      protocol: 'openai',
      baseUrl: 'https://up.example.com',
      apiKey: 'sk-up',
      models: ['gpt-test'],
    };
    const denied = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/legacy-a/channels',
      cookies: { rp_session: opCookie },
      payload: channelPayload,
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error?: string; message?: string }).message ?? denied.body).toContain('只读');

    const patch = await ts.app.inject({
      method: 'PATCH',
      url: '/api/sites/legacy-a',
      cookies: { rp_session: opCookie },
      payload: { readonly: false },
    });
    expect(patch.statusCode).toBe(200);

    const allowed = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/legacy-a/channels',
      cookies: { rp_session: opCookie },
      payload: channelPayload,
    });
    expect(allowed.statusCode).toBe(201);

    const lifecycle = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/legacy-a/stop',
      cookies: { rp_session: opCookie },
    });
    expect(lifecycle.statusCode).toBe(400); // external 站不支持生命周期操作（原有约束不变）
  });

  it('operator 无订阅时受 free 配额限制', async () => {
    const poor = await ts.seedLogin({ email: 'ad-poor@example.com', password: 'poor-pass-1234', role: 'operator' });
    const first = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: poor.cookie },
      payload: adoptPayload({ slug: 'poor-1', baseUrl: 'http://127.0.0.1:3299' }),
    });
    expect(first.statusCode).toBe(201);
    const second = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: poor.cookie },
      payload: adoptPayload({ slug: 'poor-2', baseUrl: 'http://127.0.0.1:3300' }),
    });
    expect(second.statusCode).toBe(403); // free 档 1 站
  });
});

describe('支持面设置', () => {
  it('未配置时全 null；root 配置后全员可见；operator 写 403', async () => {
    const empty = await ts.app.inject({ method: 'GET', url: '/api/support', cookies: { rp_session: opCookie } });
    expect(empty.json()).toEqual({ email: null, url: null, docsUrl: null });

    const forbidden = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/support',
      cookies: { rp_session: opCookie },
      payload: { email: 'support@example.com' },
    });
    expect(forbidden.statusCode).toBe(403);

    const set = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/support',
      cookies: { rp_session: rootCookie },
      payload: { email: 'support@example.com', docsUrl: 'https://docs.example.com' },
    });
    expect(set.statusCode).toBe(200);

    const seen = await ts.app.inject({ method: 'GET', url: '/api/support', cookies: { rp_session: opCookie } });
    expect(seen.json()).toEqual({ email: 'support@example.com', url: null, docsUrl: 'https://docs.example.com' });

    // null 清除单字段
    const clear = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/support',
      cookies: { rp_session: rootCookie },
      payload: { docsUrl: null },
    });
    expect(clear.statusCode).toBe(200);
    const after = await ts.app.inject({ method: 'GET', url: '/api/support', cookies: { rp_session: rootCookie } });
    expect(after.json()).toEqual({ email: 'support@example.com', url: null, docsUrl: null });
  });
});
