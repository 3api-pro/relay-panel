import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sites } from '../src/db/schema.js';
import {
  clearSiteCaches,
  lifecycleStepSink,
  makeStoreCredential,
} from '../src/sites/service.js';
import { makeTestServer, type TestServer } from './helpers.js';
import type { FakeLifecycleOptions } from './fakes.js';

/**
 * 批量操作（POST /api/sites/batch）：多选站点扇出公告/品牌/渠道，逐站结果，
 * 尊重 readonly 保险丝 + operator 归属隔离；部分失败不影响其它站。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let opCookie: string;

function wireLifecycles(server: TestServer): void {
  const store = makeStoreCredential(server.db, server.config);
  for (const lc of [server.lifecycles.sub2api, server.lifecycles.newapi]) {
    const opts = (lc as unknown as { opts: FakeLifecycleOptions }).opts;
    opts.storeCredential = (slug, secrets) => store(slug, secrets);
    opts.onStep = (slug, step, status, detail) => lifecycleStepSink(slug, step, status, detail);
  }
}

async function drainJobs(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await ts.jobs.tick();
    await ts.jobs.idle();
    if (n === 0) break;
  }
}

async function provisionActive(cookie: string, slug: string): Promise<void> {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/sites',
    cookies: { rp_session: cookie },
    payload: { slug, label: slug, engine: 'sub2api', version: 'v1.2.3', adminEmail: 'admin@example.com' },
  });
  expect(res.statusCode, res.body).toBe(201);
  await drainJobs();
}

async function batch(cookie: string, body: Record<string, unknown>) {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/sites/batch',
    cookies: { rp_session: cookie },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as { total: number; ok: number; failed: number; results: Array<{ slug: string; ok: boolean; error?: string; detail?: string }> } };
}

beforeAll(async () => {
  clearSiteCaches();
  ts = await makeTestServer({ config: { portRange: { min: 18300, max: 18310 } } });
  wireLifecycles(ts);
  rootCookie = (await ts.seedLogin({ email: 'batch-root@example.com', password: 'root-pass-1234', role: 'root' })).cookie;
  opCookie = (await ts.seedLogin({ email: 'batch-op@example.com', password: 'op-pass-1234', role: 'operator' })).cookie;
  for (const slug of ['b-a', 'b-b', 'b-c']) await provisionActive(rootCookie, slug);
}, 90_000);

afterAll(async () => {
  await ts.close();
});

describe('批量公告/品牌', () => {
  it('三站批量设公告，逐站 ok，引擎状态生效', async () => {
    const { status, json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-b', 'b-c'],
      announcement: '统一维护公告 2026-07-18',
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(3);
    expect(json.failed).toBe(0);
    for (const slug of ['b-a', 'b-b', 'b-c']) {
      expect(ts.adapters.sub2api.stateFor(slug).branding.announcement).toBe('统一维护公告 2026-07-18');
    }
  });

  it('批量改品牌名', async () => {
    const { json } = await batch(rootCookie, {
      kind: 'branding',
      slugs: ['b-a', 'b-b'],
      siteName: '统一品牌名',
    });
    expect(json.ok).toBe(2);
    expect(ts.adapters.sub2api.stateFor('b-a').branding.siteName).toBe('统一品牌名');
    expect(ts.adapters.sub2api.stateFor('b-b').branding.siteName).toBe('统一品牌名');
  });

  it('去重：重复 slug 只执行一次', async () => {
    const { json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-a', 'b-a'],
      announcement: 'dedup',
    });
    expect(json.total).toBe(1);
    expect(json.ok).toBe(1);
  });
});

describe('批量建渠道 + 启停', () => {
  it('批量建渠道后按名批量停用', async () => {
    const create = await batch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a', 'b-b'],
      channel: { name: 'batch-up', protocol: 'openai', baseUrl: 'https://up.example.com', apiKey: 'sk-x', models: ['m1'] },
    });
    expect(create.ok ?? create.json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      expect(ts.adapters.sub2api.stateFor(slug).channels.some((c) => c.name === 'batch-up' && c.enabled)).toBe(true);
    }

    const toggle = await batch(rootCookie, {
      kind: 'channel.toggle',
      slugs: ['b-a', 'b-b'],
      channelName: 'batch-up',
      enabled: false,
    });
    expect(toggle.json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      expect(ts.adapters.sub2api.stateFor(slug).channels.find((c) => c.name === 'batch-up')!.enabled).toBe(false);
    }
  });

  it('渠道名不存在的站返回逐站 error，不拖垮其它站', async () => {
    // b-c 没有 batch-up 渠道；b-a 有
    const { json } = await batch(rootCookie, {
      kind: 'channel.toggle',
      slugs: ['b-a', 'b-c'],
      channelName: 'batch-up',
      enabled: true,
    });
    expect(json.total).toBe(2);
    expect(json.ok).toBe(1);
    expect(json.failed).toBe(1);
    const bc = json.results.find((r) => r.slug === 'b-c')!;
    expect(bc.ok).toBe(false);
    expect(bc.error).toContain('未找到');
  });
});

describe('权限与只读保险丝', () => {
  it('readonly 站在批量里返回 403 error，其它站照常', async () => {
    await ts.db.orm.update(sites).set({ readonly: true }).where(eq(sites.slug, 'b-c'));
    const { json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-c'],
      announcement: 'readonly-test',
    });
    expect(json.ok).toBe(1);
    const bc = json.results.find((r) => r.slug === 'b-c')!;
    expect(bc.ok).toBe(false);
    expect(bc.error).toContain('只读');
    await ts.db.orm.update(sites).set({ readonly: false }).where(eq(sites.slug, 'b-c'));
  });

  it('operator 只能批量操作自己名下的站；他人站计为 error(站点不存在)', async () => {
    // op 名下建一个站（free 配额 1）
    await provisionActive(opCookie, 'op-own');
    const { json } = await batch(opCookie, {
      kind: 'announcement',
      slugs: ['op-own', 'b-a'], // b-a 属于 root
      announcement: 'op-scope',
    });
    expect(json.ok).toBe(1);
    const foreign = json.results.find((r) => r.slug === 'b-a')!;
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain('站点不存在');
  });

  it('viewer 批量写被拒（每站 403）', async () => {
    const viewer = await ts.seedLogin({ email: 'batch-viewer@example.com', password: 'v-pass-1234', role: 'viewer' });
    const { json } = await batch(viewer.cookie, {
      kind: 'announcement',
      slugs: ['b-a'],
      announcement: 'nope',
    });
    expect(json.ok).toBe(0);
    expect(json.results[0]!.error).toContain('只读');
  });

  it('空 slugs → 400', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      cookies: { rp_session: rootCookie },
      payload: { kind: 'announcement', slugs: [], announcement: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
