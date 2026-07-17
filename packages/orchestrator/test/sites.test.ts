import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, credentials, jobs as jobsTable, sites } from '../src/db/schema.js';
import { decryptSecret } from '../src/secrets.js';
import {
  clearSiteCaches,
  latestSnapshotCache,
  lifecycleStepSink,
  makeStoreCredential,
} from '../src/sites/service.js';
import { makeTestServer, type TestServer } from './helpers.js';
import type { FakeLifecycleOptions } from './fakes.js';

/**
 * 站点模块（G1，规格 §6）：provision 全链、失败步骤、端口分配、409 重复 job、
 * destroy confirm/keepData、渠道 apiKey 脱敏、operator 隔离、external 400、审计脱敏。
 * pglite 冷启动约 4s——整文件共享一个服务实例，用例按顺序推进状态。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let rootId: number;
let opCookie: string;
let viewerCookie: string;

/** helpers.ts 冻结：FakeLifecycle 的凭据入库与步骤汇聚在测试侧注入（与 index.ts 同一装配方式） */
function wireLifecycles(server: TestServer): void {
  const store = makeStoreCredential(server.db, server.config);
  for (const lc of [server.lifecycles.sub2api, server.lifecycles.newapi]) {
    const opts = (lc as unknown as { opts: FakeLifecycleOptions }).opts;
    opts.storeCredential = (slug, secrets) => store(slug, secrets);
    opts.onStep = (slug, step, status, detail) => lifecycleStepSink(slug, step, status, detail);
  }
}

/** 驱动 JobEngine 到收敛（tick 每轮最多派发 2 个） */
async function drainJobs(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await ts.jobs.tick();
    await ts.jobs.idle();
    if (n === 0) break;
  }
}

async function siteRow(slug: string) {
  const rows = await ts.db.orm.select().from(sites).where(eq(sites.slug, slug)).limit(1);
  expect(rows[0], `sites 行应存在: ${slug}`).toBeDefined();
  return rows[0]!;
}

beforeAll(async () => {
  clearSiteCaches();
  ts = await makeTestServer({ config: { portRange: { min: 18200, max: 18205 } } });
  wireLifecycles(ts);
  const root = await ts.seedLogin({ email: 'root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  rootId = root.operatorId;
  opCookie = (await ts.seedLogin({ email: 'op@example.com', password: 'op-pass-1234', role: 'operator' })).cookie;
  viewerCookie = (await ts.seedLogin({ email: 'view@example.com', password: 'view-pass-1234', role: 'viewer' })).cookie;
}, 60_000);

afterAll(async () => {
  clearSiteCaches();
  await ts.close();
});

describe('POST /api/sites: 校验与权限', () => {
  it('viewer 无写权限 → 403', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: viewerCookie },
      payload: { slug: 'site-x', label: 'X', engine: 'sub2api', version: 'v1.0.0', adminEmail: 'a@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('非法 slug / latest 版本 → 400', async () => {
    const bad = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: { slug: 'Bad_Slug', label: 'X', engine: 'sub2api', version: 'v1.0.0', adminEmail: 'a@example.com' },
    });
    expect(bad.statusCode).toBe(400);

    const latest = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: { slug: 'site-y', label: 'Y', engine: 'sub2api', version: 'latest', adminEmail: 'a@example.com' },
    });
    expect(latest.statusCode).toBe(400);
    expect((latest.json() as { message: string }).message).toContain('latest');
  });
});

describe('provision 全链', () => {
  it('建站 → 端口自动分配 → job 执行 → sites 行更新 → 凭据加密入库可解密', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: { slug: 'site-a', label: 'A 站', engine: 'sub2api', version: 'v1.2.3', adminEmail: 'admin@example.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { slug: string; jobId: number; hostPort: number };
    expect(body.slug).toBe('site-a');
    expect(body.hostPort).toBe(18200); // 端口池最小可用端口
    expect(body.jobId).toBeGreaterThan(0);

    expect((await siteRow('site-a')).status).toBe('pending');

    await drainJobs();

    const row = await siteRow('site-a');
    expect(row.status).toBe('active');
    expect(row.version).toBe('v1.2.3');
    expect(row.baseUrl).toBe('http://127.0.0.1:18200');
    expect(row.composeProject).toBe('rp-site-a');
    expect(row.dataDir).toBe('data/sites/site-a');
    expect(row.credentialRef).toBe('enc:site-a');

    // job 终态与 lifecycle 步骤（经 lifecycleStepSink 汇入）
    const job = (await ts.db.orm.select().from(jobsTable).where(eq(jobsTable.id, body.jobId)).limit(1))[0]!;
    expect(job.status).toBe('succeeded');
    const okSteps = job.steps.filter((s) => s.status === 'ok').map((s) => s.step);
    expect(okSteps).toEqual(['render', 'compose-up', 'health', 'store-credential']);

    // 凭据密文入库，字段名原样，解密可得（明文绝不出现在 job/audit 里）
    const cred = (await ts.db.orm.select().from(credentials).where(eq(credentials.ref, 'enc:site-a')).limit(1))[0]!;
    expect(cred.ciphertext.startsWith('v1:')).toBe(true);
    const plain = JSON.parse(decryptSecret(cred.ciphertext, ts.config.secretKey!)) as Record<string, string>;
    expect(plain).toEqual({ adminEmail: 'admin@example.com', adminPassword: 'fake-password-site-a' });
    expect(JSON.stringify(job)).not.toContain('fake-password');
  });

  it('slug 重复 → 409', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: { slug: 'site-a', label: '重复', engine: 'sub2api', version: 'v1.0.0', adminEmail: 'a@example.com' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('失败步骤与端口分配', () => {
  it('provision 中途失败 → job failed，站点 status=failed:<step>', async () => {
    ts.lifecycles.sub2api.failAt('compose-up');
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: { slug: 'site-b', label: 'B 站', engine: 'sub2api', version: 'v1.0.0', adminEmail: 'b@example.com' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { hostPort: number }).hostPort).toBe(18201); // 18200 已被 site-a 占用

    await drainJobs();
    ts.lifecycles.sub2api.clearFailure('compose-up');

    const row = await siteRow('site-b');
    expect(row.status).toBe('failed:compose-up');
    const job = (
      await ts.db.orm.select().from(jobsTable).where(eq(jobsTable.slug, 'site-b')).limit(1)
    )[0]!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('injected failure');
  });

  it('显式端口与现有站冲突 → 409', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: {
        slug: 'site-c',
        label: 'C 站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18200,
        adminEmail: 'c@example.com',
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { message: string }).message).toContain('端口');
  });
});

describe('重复 job 409 与 start/stop', () => {
  it('provision 排队中再发 start → 409（同 slug 未完成任务）', async () => {
    const created = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: rootCookie },
      payload: {
        slug: 'site-d',
        label: 'D 站',
        engine: 'sub2api',
        version: 'v2.0.0',
        hostPort: 18333,
        adminEmail: 'd@example.com',
      },
    });
    expect(created.statusCode).toBe(201);

    const start = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/start',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    expect(start.statusCode).toBe(409);

    await drainJobs();
    expect((await siteRow('site-d')).status).toBe('active');
  });

  it('stop → stopped，start → active，upgrade → 版本更新', async () => {
    const stop = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/stop',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    await drainJobs();
    expect((await siteRow('site-d')).status).toBe('stopped');

    const start = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/start',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    await drainJobs();
    expect((await siteRow('site-d')).status).toBe('active');

    const upgrade = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/upgrade',
      cookies: { rp_session: rootCookie },
      payload: { toVersion: 'v2.1.0' },
    });
    expect(upgrade.statusCode).toBe(200);
    await drainJobs();
    const row = await siteRow('site-d');
    expect(row.version).toBe('v2.1.0');
    expect(row.status).toBe('active');
  });
});

describe('operator 隔离与配额', () => {
  it('operator 建自己的站（free 配额 1）', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: opCookie },
      payload: { slug: 'site-op-a', label: 'op 的站', engine: 'newapi', version: 'v0.9.0', adminEmail: 'op@example.com' },
    });
    expect(res.statusCode).toBe(201);
    await drainJobs();
    expect((await siteRow('site-op-a')).status).toBe('active');
  });

  it('无订阅 operator 建第二个站 → 403 配额', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: opCookie },
      payload: { slug: 'site-op-b', label: '第二站', engine: 'newapi', version: 'v0.9.0', adminEmail: 'op@example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain('配额');
  });

  it('operator 列表只见 own；他人站读写一律 404', async () => {
    const list = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: opCookie } });
    expect(list.statusCode).toBe(200);
    const slugs = (list.json() as { sites: { slug: string }[] }).sites.map((s) => s.slug);
    expect(slugs).toEqual(['site-op-a']);

    const read = await ts.app.inject({ method: 'GET', url: '/api/sites/site-d', cookies: { rp_session: opCookie } });
    expect(read.statusCode).toBe(404);

    const write = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/stop',
      cookies: { rp_session: opCookie },
      payload: {},
    });
    expect(write.statusCode).toBe(404);
  });
});

describe('渠道/用户/品牌/usage（引擎 admin 面）', () => {
  it('渠道列表 apiKey 强制 <redacted>，明文绝不出现在响应', async () => {
    ts.adapters.newapi.stateFor('site-op-a').channels.push({
      id: '9',
      name: 'up-a',
      protocol: 'openai',
      baseUrl: 'https://upstream-a.example.com/v1',
      apiKey: 'sk-super-secret-123456',
      models: ['model-a'],
      enabled: true,
    });
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-op-a/channels',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-super-secret-123456');
    const channels = (res.json() as { channels: { id: string; apiKey: string }[] }).channels;
    expect(channels.find((c) => c.id === '9')!.apiKey).toBe('<redacted>');
  });

  it('创建渠道：响应脱敏、引擎收到真实 key、审计落库不含明文', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-op-a/channels',
      cookies: { rp_session: opCookie },
      payload: {
        name: 'up-b',
        protocol: 'openai',
        baseUrl: 'https://upstream-b.example.com/v1',
        apiKey: 'sk-plain-key-abcdef123',
        models: ['model-b'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('sk-plain-key-abcdef123');
    const channel = (res.json() as { channel: { id: string; apiKey: string } }).channel;
    expect(channel.apiKey).toBe('<redacted>');

    // 引擎侧（adapter 内存态）持有真实 key —— 只在引擎内，不经面板出口
    const state = ts.adapters.newapi.stateFor('site-op-a');
    expect(state.channels.find((c) => c.name === 'up-b')!.apiKey).toBe('sk-plain-key-abcdef123');

    const audits = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'channel.create'));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain('sk-plain-key-abcdef123');
  });

  it('渠道 更新/测试/删除 与 用户禁用、品牌更新', async () => {
    const patch = await ts.app.inject({
      method: 'PATCH',
      url: '/api/sites/site-op-a/channels/9',
      cookies: { rp_session: opCookie },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(ts.adapters.newapi.stateFor('site-op-a').channels.find((c) => c.id === '9')!.enabled).toBe(false);

    const test = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-op-a/channels/9/test',
      cookies: { rp_session: opCookie },
      payload: { model: 'model-a' },
    });
    expect(test.statusCode).toBe(200);
    expect((test.json() as { result: { ok: boolean } }).result.ok).toBe(true);

    const del = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/site-op-a/channels/9',
      cookies: { rp_session: opCookie },
      payload: {},
    });
    expect(del.statusCode).toBe(200);
    expect(ts.adapters.newapi.stateFor('site-op-a').channels.some((c) => c.id === '9')).toBe(false);

    ts.adapters.newapi.stateFor('site-op-a').users.push({
      id: 'u1',
      email: 'user@example.com',
      role: 'user',
      status: 'active',
    });
    const userPatch = await ts.app.inject({
      method: 'PATCH',
      url: '/api/sites/site-op-a/users/u1',
      cookies: { rp_session: opCookie },
      payload: { status: 'disabled' },
    });
    expect(userPatch.statusCode).toBe(200);
    expect(ts.adapters.newapi.stateFor('site-op-a').users[0]!.status).toBe('disabled');

    const branding = await ts.app.inject({
      method: 'PUT',
      url: '/api/sites/site-op-a/branding',
      cookies: { rp_session: opCookie },
      payload: { siteName: '品牌新名' },
    });
    expect(branding.statusCode).toBe(200);
    expect(ts.adapters.newapi.stateFor('site-op-a').branding.siteName).toBe('品牌新名');
  });

  it('usage 按天分桶 + 10min 缓存（第二次不再打引擎）', async () => {
    ts.adapters.newapi.stateFor('site-op-a').usage = {
      requests: 4,
      promptTokens: 10,
      completionTokens: 5,
      cost: 0.5,
      costUnit: 'USD',
    };
    const first = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-op-a/usage?days=3',
      cookies: { rp_session: opCookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { buckets: { date: string; requests: number; tokens: number; cost: number }[]; costUnit: string };
    expect(body.costUnit).toBe('USD');
    expect(body.buckets).toHaveLength(3);
    expect(body.buckets[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.buckets[2]!).toMatchObject({ requests: 4, tokens: 15, cost: 0.5 });

    const callsBefore = ts.adapters.newapi.calls.filter((c) => c === 'stats.usage:site-op-a').length;
    const second = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-op-a/usage?days=3',
      cookies: { rp_session: opCookie },
    });
    expect(second.statusCode).toBe(200);
    const callsAfter = ts.adapters.newapi.calls.filter((c) => c === 'stats.usage:site-op-a').length;
    expect(callsAfter).toBe(callsBefore);

    const bad = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-op-a/usage?days=31',
      cookies: { rp_session: opCookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('SiteView 快照聚合与降级', () => {
  it('探测字段聚合 + latestSnapshotCache 契约（G4 /metrics 读它）', async () => {
    clearSiteCaches();
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    const views = (res.json() as { sites: Record<string, unknown>[] }).sites;
    const opSite = views.find((v) => v.slug === 'site-op-a')!;
    expect(opSite.ok).toBe(true);
    expect(opSite.activeJob).toBeNull();
    expect(typeof opSite.groups).toBe('number');
    expect((opSite.usage24h as { cost: number }).cost).toBe(0.5);
    expect(opSite.branding).toBe('品牌新名');
    // 列表出口绝不泄露内部定位字段
    expect(res.body).not.toContain('credentialRef');
    expect(res.body).not.toContain('dataDir');
    expect(res.body).not.toContain('composeProject');

    expect(latestSnapshotCache.get('site-op-a')).toEqual({ ok: true, cost24h: 0.5 });

    // 15s 内重复列表读取命中缓存，不再打引擎
    const healthCalls = ts.adapters.newapi.calls.filter((c) => c === 'health:site-op-a').length;
    await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    expect(ts.adapters.newapi.calls.filter((c) => c === 'health:site-op-a').length).toBe(healthCalls);
  });

  it('单站探测失败降级 error 字段，不影响他站', async () => {
    ts.adapters.newapi.setUnhealthy('site-op-a');
    clearSiteCaches();
    const res = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    const views = (res.json() as { sites: Record<string, unknown>[] }).sites;
    const down = views.find((v) => v.slug === 'site-op-a')!;
    expect(down.ok).toBe(false);
    expect(down.error).toBeTruthy();
    const up = views.find((v) => v.slug === 'site-d')!;
    expect(up.ok).toBe(true);
    expect(latestSnapshotCache.get('site-op-a')).toEqual({ ok: false });
    ts.adapters.newapi.setUnhealthy('site-op-a', false);
    clearSiteCaches();
  });
});

describe('external 站与 destroy', () => {
  it('external 站生命周期端点一律 400', async () => {
    await ts.db.orm.insert(sites).values({
      operatorId: rootId,
      slug: 'site-ext',
      label: '外部接管站',
      engine: 'sub2api',
      version: 'prod',
      hostPort: 18999,
      baseUrl: 'http://127.0.0.1:18999',
      status: 'active',
      managed: 'external',
    });
    for (const url of ['/api/sites/site-ext/start', '/api/sites/site-ext/stop', '/api/sites/site-ext/upgrade']) {
      const res = await ts.app.inject({
        method: 'POST',
        url,
        cookies: { rp_session: rootCookie },
        payload: url.endsWith('upgrade') ? { toVersion: 'v9.9.9' } : {},
      });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { message: string }).message).toContain('外部接管');
    }
    const del = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/site-ext',
      cookies: { rp_session: rootCookie },
      payload: { confirm: 'site-ext' },
    });
    expect(del.statusCode).toBe(400);
  });

  it('confirm 不匹配 → 400，匹配 → destroyed；keepData=false 删除 enc: 凭据', async () => {
    const wrong = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/site-a',
      cookies: { rp_session: rootCookie },
      payload: { confirm: 'site-oops' },
    });
    expect(wrong.statusCode).toBe(400);

    const del = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/site-a',
      cookies: { rp_session: rootCookie },
      payload: { confirm: 'site-a', keepData: false },
    });
    expect(del.statusCode).toBe(200);
    await drainJobs();

    const row = await siteRow('site-a');
    expect(row.status).toBe('destroyed');
    expect(row.credentialRef).toBe('');
    const cred = await ts.db.orm.select().from(credentials).where(eq(credentials.ref, 'enc:site-a'));
    expect(cred).toHaveLength(0);
    expect(ts.lifecycles.sub2api.calls).toContain('destroy:site-a:keepData=false');
  });

  it('keepData=true 保留 enc: 凭据（供重新接管）', async () => {
    const del = await ts.app.inject({
      method: 'DELETE',
      url: '/api/sites/site-d',
      cookies: { rp_session: rootCookie },
      payload: { confirm: 'site-d', keepData: true },
    });
    expect(del.statusCode).toBe(200);
    await drainJobs();

    const row = await siteRow('site-d');
    expect(row.status).toBe('destroyed');
    expect(row.credentialRef).toBe('enc:site-d');
    const cred = await ts.db.orm.select().from(credentials).where(eq(credentials.ref, 'enc:site-d'));
    expect(cred).toHaveLength(1);
  });

  it('destroyed 站拒绝生命周期操作，且列表跳过实时探测', async () => {
    const start = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/site-d/start',
      cookies: { rp_session: rootCookie },
      payload: {},
    });
    expect(start.statusCode).toBe(400);
    expect((start.json() as { message: string }).message).toContain('已销毁');

    clearSiteCaches();
    ts.adapters.sub2api.calls.length = 0;
    const list = await ts.app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: rootCookie } });
    expect(list.statusCode).toBe(200);
    expect(ts.adapters.sub2api.calls).not.toContain('health:site-a');
    expect(ts.adapters.sub2api.calls).not.toContain('health:site-d');
    const views = (list.json() as { sites: Record<string, unknown>[] }).sites;
    expect(views.find((v) => v.slug === 'site-a')!.ok).toBe(false);
    expect(latestSnapshotCache.has('site-a')).toBe(false);
    expect(latestSnapshotCache.has('site-d')).toBe(false);
  });
});

describe('审计流水', () => {
  it('站点审计端点：动作齐全且全库无凭据明文', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-d/audit?limit=100',
      cookies: { rp_session: rootCookie },
    });
    expect(res.statusCode).toBe(200);
    const events = (res.json() as { events: { action: string; ok: boolean }[] }).events;
    const actions = events.map((e) => e.action);
    expect(actions).toContain('site.provision');
    expect(actions).toContain('lifecycle.provision');
    expect(actions).toContain('site.destroy');
    expect(actions).toContain('lifecycle.destroy');

    // 全量审计兜底自查：任何行不得携带凭据明文
    const all = await ts.db.orm.select().from(auditEvents);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain('fake-password');
    expect(dump).not.toContain('sk-plain-key-abcdef123');
    expect(dump).not.toContain('sk-super-secret-123456');
  });

  it('operator 读他人站审计 → 404', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/sites/site-d/audit',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
