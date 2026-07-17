import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeDb, runMigrations, type Db } from '../src/db/client.js';
import { JobEngine } from '../src/jobs/engine.js';
import { buildServer } from '../src/server.js';
import { clearSiteCaches, lifecycleStepSink } from '../src/sites/service.js';
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  demoNotifier,
  makeDemoAdapters,
  makeDemoLifecycles,
  seedDemo,
} from '../src/demo/index.js';
import { makeTestConfig } from './helpers.js';

/**
 * 演示模式端到端（安全第一）：起 demo 服务 → GET /api/demo 一键账号 → 登录 →
 * /api/sites 5 个 active 富数据站 → 站点 usage 有曲线 → marketplace/ledger/billing/alerts/jobs
 * 都有数据 → “演示里建站”秒 active → destroy 变 destroyed 不报错。
 *
 * 用与 index.ts 相同的演示装配（makeDemoAdapters/makeDemoLifecycles/demoNotifier/seedDemo），
 * 保证测的就是线上跑的那套接线。
 */

let app: FastifyInstance;
let db: Db;
let jobs: JobEngine;
let cookie: string;

/** 驱动 JobEngine 到收敛 */
async function drainJobs(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await jobs.tick();
    await jobs.idle();
    if (n === 0) break;
  }
}

beforeAll(async () => {
  clearSiteCaches();
  db = await makeDb('pglite:memory');
  await runMigrations(db);
  const config = makeTestConfig({ demo: true });
  await seedDemo(db);

  jobs = new JobEngine(db);
  const adapters = makeDemoAdapters();
  const lifecycles = makeDemoLifecycles((slug, step, status, detail) =>
    lifecycleStepSink(slug, step, status, detail),
  );

  app = await buildServer({
    config,
    db,
    adapters,
    lifecycles,
    gateway: null,
    jobs,
    notifier: demoNotifier,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  clearSiteCaches();
  jobs.stop();
  await app.close().catch(() => undefined);
  await db.close().catch(() => undefined);
});

describe('一键演示账号', () => {
  it('GET /api/demo 公开免认证，返回沙箱账号', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/demo' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { demo: boolean; email: string; password: string; note: string };
    expect(body.demo).toBe(true);
    expect(body.email).toBe(DEMO_EMAIL);
    expect(body.password).toBe(DEMO_PASSWORD);
    expect(body.note).toBeTruthy();
  });

  it('用一键账号走正常 /api/auth/login 可登录', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'rp_session');
    expect(c).toBeDefined();
    cookie = c!.value;
    expect((res.json() as { role: string }).role).toBe('root');
  });

  it('POST /api/demo/login 便捷一键登录也下发会话', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demo/login' });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((x) => x.name === 'rp_session')).toBeDefined();
  });
});

describe('富罐装数据', () => {
  it('/api/sites 返回 5 个 active 富数据站', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites', cookies: { rp_session: cookie } });
    expect(res.statusCode).toBe(200);
    const { sites } = res.json() as { sites: Array<Record<string, unknown>> };
    expect(sites.length).toBe(5);
    for (const s of sites) {
      expect(s.status).toBe('active');
      expect(s.ok).toBe(true); // health 恒 ok
      // 实时探测富字段
      expect((s.accounts as { total: number }).total).toBeGreaterThan(0);
      expect((s.usage24h as { requests: number }).requests).toBeGreaterThan(0);
    }
    const engines = new Set(sites.map((s) => s.engine));
    expect(engines.has('sub2api')).toBe(true);
    expect(engines.has('newapi')).toBe(true);
  });

  it('站点 channels/groups/users 有确定性罐装数据，apiKey 恒 <redacted>', async () => {
    const ch = await app.inject({ method: 'GET', url: '/api/sites/acme-relay/channels', cookies: { rp_session: cookie } });
    const { channels } = ch.json() as { channels: Array<{ apiKey: string }> };
    expect(channels.length).toBeGreaterThanOrEqual(3);
    for (const c of channels) expect(c.apiKey).toBe('<redacted>');

    const gr = await app.inject({ method: 'GET', url: '/api/sites/acme-relay/groups', cookies: { rp_session: cookie } });
    expect((gr.json() as { groups: unknown[] }).groups.length).toBeGreaterThanOrEqual(2);

    const us = await app.inject({ method: 'GET', url: '/api/sites/acme-relay/users', cookies: { rp_session: cookie } });
    expect((us.json() as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(20);
  });

  it('站点 usage 14 天有起伏曲线', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sites/acme-relay/usage?days=14',
      cookies: { rp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const { buckets, costUnit } = res.json() as {
      buckets: Array<{ date: string; requests: number; tokens: number; cost: number }>;
      costUnit: string;
    };
    expect(buckets.length).toBe(14);
    expect(costUnit).toBe('USD');
    for (const b of buckets) {
      expect(b.requests).toBeGreaterThan(0);
      expect(b.tokens).toBeGreaterThan(0);
      expect(b.cost).toBeGreaterThan(0);
    }
    // 有起伏：最大与最小不相等
    const reqs = buckets.map((b) => b.requests);
    expect(Math.max(...reqs)).toBeGreaterThan(Math.min(...reqs));
  });

  it('marketplace 模板 6 个', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/marketplace/templates', cookies: { rp_session: cookie } });
    expect((res.json() as { templates: unknown[] }).templates.length).toBe(6);
  });

  it('ledger 有账本行且毛利为正', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/marketplace/ledger', cookies: { rp_session: cookie } });
    const { rows, totals } = res.json() as {
      rows: unknown[];
      totals: { billedCost: number; upstreamCost: number; margin: number };
    };
    expect(rows.length).toBeGreaterThan(0);
    expect(totals.billedCost).toBeGreaterThan(totals.upstreamCost);
    expect(totals.margin).toBeGreaterThan(0);
  });

  it('billing 有套餐与订阅', async () => {
    const plans = await app.inject({ method: 'GET', url: '/api/billing/plans', cookies: { rp_session: cookie } });
    expect((plans.json() as { plans: unknown[] }).plans.length).toBeGreaterThan(0);
    const subs = await app.inject({ method: 'GET', url: '/api/billing/subscriptions', cookies: { rp_session: cookie } });
    expect((subs.json() as { subscriptions: unknown[] }).subscriptions.length).toBeGreaterThanOrEqual(3);
  });

  it('alerts 有 2 open + 3 resolved', async () => {
    const open = await app.inject({ method: 'GET', url: '/api/alerts?status=open', cookies: { rp_session: cookie } });
    expect((open.json() as { alerts: unknown[] }).alerts.length).toBe(2);
    const all = await app.inject({ method: 'GET', url: '/api/alerts?status=all', cookies: { rp_session: cookie } });
    expect((all.json() as { alerts: unknown[] }).alerts.length).toBe(5);
  });

  it('jobs 有历史（含 1 条 running）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs', cookies: { rp_session: cookie } });
    const { jobs: rows } = res.json() as { jobs: Array<{ status: string }> };
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.some((j) => j.status === 'running')).toBe(true);
  });
});

describe('演示里生命周期操作', () => {
  it('建站秒变 active 且有罐装数据；destroy 变 destroyed 不报错', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: { rp_session: cookie },
      payload: { slug: 'demo-new-site', label: '新演示站', engine: 'sub2api', version: '0.1.160', adminEmail: 'admin@demo.example' },
    });
    expect(create.statusCode).toBe(201);

    await drainJobs();

    const view = await app.inject({ method: 'GET', url: '/api/sites/demo-new-site', cookies: { rp_session: cookie } });
    const site = view.json() as { status: string; ok: boolean; accounts?: { total: number } };
    expect(site.status).toBe('active');
    expect(site.ok).toBe(true);
    expect(site.accounts!.total).toBeGreaterThan(0); // 立即有罐装渠道数据

    // 建站产生的 provision job 应 succeeded，且有假进度步骤
    const jobsRes = await app.inject({ method: 'GET', url: '/api/jobs?slug=demo-new-site', cookies: { rp_session: cookie } });
    const pj = (jobsRes.json() as { jobs: Array<{ status: string; steps: unknown[] }> }).jobs[0]!;
    expect(pj.status).toBe('succeeded');
    expect(pj.steps.length).toBeGreaterThan(0);

    // 销毁
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/sites/demo-new-site',
      cookies: { rp_session: cookie },
      payload: { confirm: 'demo-new-site' },
    });
    expect(del.statusCode).toBe(200);

    await drainJobs();

    const after = await app.inject({ method: 'GET', url: '/api/sites/demo-new-site', cookies: { rp_session: cookie } });
    expect((after.json() as { status: string }).status).toBe('destroyed');
  });
});
