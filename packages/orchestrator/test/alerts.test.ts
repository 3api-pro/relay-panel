import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ChannelRecord, EngineKind } from '@relay-panel/adapter-core';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { alerts, appSettings, auditEvents, sites, type AlertRow } from '../src/db/schema.js';
import { JobEngine } from '../src/jobs/engine.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { startMonitor, type MonitorDeps } from '../src/alerts/engine.js';
import { WEBHOOK_SETTINGS_KEY, WebhookNotifier, type Notifier } from '../src/alerts/notify.js';
import { makeTestConfig, makeTestDb, makeTestServer, seedOperator, type TestServer } from './helpers.js';
import { FakeAdapter, FakeNotifier } from './fakes.js';

// pglite WASM 冷启动约 4s，整文件共享一个库并放宽超时
vi.setConfig({ testTimeout: 30_000 });

let db: Db;
let ownerId: number;
let portSeq = 18300;

beforeAll(async () => {
  db = await makeTestDb();
  ownerId = await seedOperator(db, { email: 'mon-owner@example.com', role: 'operator' });
}, 60_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
});

// 兜底：每个用例后把残留 open 告警落成 resolved，避免后续用例的自动恢复逻辑误触发通知
afterEach(async () => {
  await db.orm.update(alerts).set({ status: 'resolved' }).where(eq(alerts.status, 'open'));
});

async function seedSite(slug: string, opts: { engine?: EngineKind; status?: string } = {}): Promise<number> {
  const port = portSeq++;
  const rows = await db.orm
    .insert(sites)
    .values({
      operatorId: ownerId,
      slug,
      label: `站点 ${slug}`,
      engine: opts.engine ?? 'sub2api',
      version: 'v1.0.0',
      hostPort: port,
      baseUrl: `http://127.0.0.1:${port}`,
      status: opts.status ?? 'active',
    })
    .returning({ id: sites.id });
  return rows[0]!.id;
}

function makeDeps(fake: FakeAdapter, notifier: Notifier, cfg: Partial<Config> = {}): MonitorDeps {
  return {
    config: makeTestConfig(cfg),
    db,
    adapters: { sub2api: fake, newapi: new FakeAdapter('newapi') } as unknown as MonitorDeps['adapters'],
    notifier,
  };
}

async function alertsFor(kind: string, siteId: number): Promise<AlertRow[]> {
  return db.orm
    .select()
    .from(alerts)
    .where(and(eq(alerts.kind, kind), eq(alerts.siteId, siteId)));
}

describe('告警引擎: site_down', () => {
  it('连续 3 次失败才 open，去重只刷新，恢复自动 resolve，双向通知', async () => {
    const fake = new FakeAdapter('sub2api');
    const notifier = new FakeNotifier();
    const siteId = await seedSite('mon-down');
    await seedSite('mon-dead', { status: 'destroyed' });
    const monitor = startMonitor(makeDeps(fake, notifier), 0);

    fake.setUnhealthy('mon-down');
    await monitor.tick();
    await monitor.tick();
    // 两连败还不告警
    expect(await alertsFor('site_down', siteId)).toHaveLength(0);
    expect(notifier.events).toHaveLength(0);

    await monitor.tick(); // 第 3 连败 → open
    let rows = await alertsFor('site_down', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.severity).toBe('critical');
    expect(rows[0]!.title).toBe('站点不可达');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({ type: 'open' });
    expect((notifier.events[0]!.site as { slug: string }).slug).toBe('mon-down');

    // 去重：继续失败只更新 last_seen/detail（连续次数递增），不新开行、不重复通知
    await monitor.tick();
    rows = await alertsFor('site_down', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('连续 4 次');
    expect(notifier.events).toHaveLength(1);

    // 恢复 → 自动 resolve + resolve 事件
    fake.setUnhealthy('mon-down', false);
    await monitor.tick();
    rows = await alertsFor('site_down', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('resolved');
    expect(rows[0]!.resolvedAt).toBeTruthy();
    expect(notifier.events).toHaveLength(2);
    expect(notifier.events[1]).toMatchObject({ type: 'resolve' });

    // destroyed 站从不探测
    expect(fake.calls.filter((c) => c === 'health:mon-dead')).toHaveLength(0);
    monitor.stop();
  });

  it('intervalMs>0 时轮询自动驱动，stop 后停止', async () => {
    const fake = new FakeAdapter('sub2api');
    await seedSite('mon-loop');
    const monitor = startMonitor(makeDeps(fake, new FakeNotifier()), 25);
    try {
      await vi.waitFor(() => {
        expect(fake.calls.some((c) => c === 'health:mon-loop')).toBe(true);
      });
    } finally {
      monitor.stop();
    }
  });
});

describe('告警引擎: channel_disabled / low_balance', () => {
  function mkChan(
    id: string,
    name: string,
    enabled: boolean,
    raw?: Record<string, unknown>,
  ): ChannelRecord {
    return {
      id,
      name,
      enabled,
      protocol: 'openai',
      baseUrl: 'https://upstream.example.com/v1',
      apiKey: '<redacted>',
      models: ['model-a'],
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  it('channel_disabled: 首轮建基线不告警，enabled→disabled 转变才 open，恢复自动 resolve，每 5 轮巡检一次', async () => {
    const fake = new FakeAdapter('sub2api');
    const notifier = new FakeNotifier();
    const siteId = await seedSite('mon-chan');
    const state = fake.stateFor('mon-chan');
    state.channels.push(mkChan('c1', '渠道甲', true), mkChan('c2', '渠道乙', false));

    const monitor = startMonitor(makeDeps(fake, notifier), 0);
    await monitor.tick(); // 轮 1：首查建基线（c2 基线即禁用，不算转变）
    expect(fake.calls.filter((c) => c === 'channels.list:mon-chan')).toHaveLength(1);
    expect(await alertsFor('channel_disabled', siteId)).toHaveLength(0);

    // c1 被禁用；轮 2..5 不做渠道巡检
    state.channels[0]!.enabled = false;
    for (let i = 0; i < 4; i++) await monitor.tick();
    expect(fake.calls.filter((c) => c === 'channels.list:mon-chan')).toHaveLength(1);
    expect(await alertsFor('channel_disabled', siteId)).toHaveLength(0);

    await monitor.tick(); // 轮 6：第二次渠道巡检 → open
    expect(fake.calls.filter((c) => c === 'channels.list:mon-chan')).toHaveLength(2);
    let rows = await alertsFor('channel_disabled', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.severity).toBe('warning');
    expect(rows[0]!.detail).toContain('渠道甲');
    expect(rows[0]!.detail).not.toContain('渠道乙');
    expect(notifier.events.filter((e) => e.type === 'open')).toHaveLength(1);

    // 恢复 enabled → 下一个渠道巡检轮（轮 11）自动 resolve
    state.channels[0]!.enabled = true;
    for (let i = 0; i < 4; i++) await monitor.tick(); // 轮 7..10
    expect((await alertsFor('channel_disabled', siteId))[0]!.status).toBe('open');
    await monitor.tick(); // 轮 11
    rows = await alertsFor('channel_disabled', siteId);
    expect(rows[0]!.status).toBe('resolved');
    expect(notifier.events.filter((e) => e.type === 'resolve')).toHaveLength(1);
    monitor.stop();
  });

  it('low_balance: 阈值>0 时读 raw.balance/quota，低于阈值 open，回升 resolve，读不到跳过', async () => {
    const fake = new FakeAdapter('sub2api');
    const notifier = new FakeNotifier();
    const siteId = await seedSite('mon-bal');
    const state = fake.stateFor('mon-bal');
    state.channels.push(mkChan('b1', '渠道丙', true, { balance: 3 }), mkChan('b2', '渠道丁', true));

    const monitor = startMonitor(makeDeps(fake, notifier, { balanceThreshold: 10 }), 0);
    await monitor.tick(); // 轮 1 即渠道巡检
    let rows = await alertsFor('low_balance', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.severity).toBe('warning');
    expect(rows[0]!.detail).toContain('渠道丙');
    expect(rows[0]!.detail).not.toContain('渠道丁');

    // 余额回升 → 下一个渠道巡检轮（轮 6）resolve
    state.channels[0]!.raw = { balance: 99 };
    for (let i = 0; i < 5; i++) await monitor.tick(); // 轮 2..6
    rows = await alertsFor('low_balance', siteId);
    expect(rows[0]!.status).toBe('resolved');
    monitor.stop();
  });
});

describe('告警引擎: job_failed 经 onFinish', () => {
  it('失败任务出告警、成功不出、同 (kind,site) 去重、不自动 resolve、无 siteId 落全局告警', async () => {
    const fake = new FakeAdapter('sub2api');
    const notifier = new FakeNotifier();
    const siteId = await seedSite('mon-job');
    const jobs = new JobEngine(db);
    jobs.registerHandler('stop', async () => {});
    jobs.registerHandler('start', async () => {
      throw new Error('compose 拉起失败');
    });
    jobs.registerHandler('destroy', async () => {
      throw new Error('销毁失败');
    });
    const monitor = startMonitor({ ...makeDeps(fake, notifier), jobs }, 0);

    // 成功任务不出告警
    await jobs.enqueue('stop', 'mon-job', undefined, 'root@example.com', { siteId });
    await jobs.tick();
    await jobs.idle();
    expect(await alertsFor('job_failed', siteId)).toHaveLength(0);

    // 失败任务 → open(warning, "<kind> 任务失败")
    await jobs.enqueue('start', 'mon-job', undefined, 'root@example.com', { siteId });
    await jobs.tick();
    await jobs.idle();
    let rows = await alertsFor('job_failed', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.severity).toBe('warning');
    expect(rows[0]!.title).toBe('start 任务失败');
    expect(rows[0]!.detail).toContain('compose 拉起失败');
    expect(notifier.events).toHaveLength(1);
    expect((notifier.events[0]!.site as { slug: string }).slug).toBe('mon-job');

    // 再次失败 → 去重合并，不重复通知
    await jobs.enqueue('start', 'mon-job', undefined, 'root@example.com', { siteId });
    await jobs.tick();
    await jobs.idle();
    rows = await alertsFor('job_failed', siteId);
    expect(rows).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);

    // 站点健康巡检不会自动 resolve job_failed
    await monitor.tick();
    expect((await alertsFor('job_failed', siteId))[0]!.status).toBe('open');

    // 无 siteId 的任务失败 → site_id null 的全局告警
    await jobs.enqueue('destroy', 'ghost-slug', undefined, 'root@example.com');
    await jobs.tick();
    await jobs.idle();
    const globalRows = await db.orm
      .select()
      .from(alerts)
      .where(and(eq(alerts.kind, 'job_failed'), isNull(alerts.siteId)));
    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]!.title).toBe('destroy 任务失败');
    monitor.stop();
  });
});

describe('WebhookNotifier', () => {
  it('open 与 resolve 事件 POST JSON 到配置地址（本地 fastify 收包），负载不含凭据', async () => {
    const received: Record<string, unknown>[] = [];
    const hook = Fastify();
    hook.post('/hook', async (req) => {
      received.push(req.body as Record<string, unknown>);
      return { ok: true };
    });
    const address = await hook.listen({ port: 0, host: '127.0.0.1' });
    const hookUrl = `${address}/hook`;
    await db.orm
      .insert(appSettings)
      .values({ key: WEBHOOK_SETTINGS_KEY, value: { url: hookUrl } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { url: hookUrl } } });

    try {
      const fake = new FakeAdapter('sub2api');
      await seedSite('mon-hook');
      const monitor = startMonitor(makeDeps(fake, new WebhookNotifier(db)), 0);
      fake.setUnhealthy('mon-hook');
      await monitor.tick();
      await monitor.tick();
      await monitor.tick(); // 三连败 → open 事件
      fake.setUnhealthy('mon-hook', false);
      await monitor.tick(); // 恢复 → resolve 事件
      monitor.stop();

      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({ type: 'open' });
      expect((received[0]!.alert as { kind: string; title: string }).kind).toBe('site_down');
      expect((received[0]!.site as { slug: string }).slug).toBe('mon-hook');
      expect(received[1]).toMatchObject({ type: 'resolve' });
      // 负载兜底自查：不含任何密钥形态内容
      expect(JSON.stringify(received)).not.toMatch(/sk-[A-Za-z0-9]/);
    } finally {
      await hook.close();
      await db.orm.delete(appSettings).where(eq(appSettings.key, WEBHOOK_SETTINGS_KEY));
    }
  });

  it('未配置时静默跳过；地址不可达只 log 不 throw', async () => {
    const notifier = new WebhookNotifier(db);
    await expect(notifier.fire({ type: 'open', alert: { id: 1 } })).resolves.toBeUndefined();

    await db.orm
      .insert(appSettings)
      .values({ key: WEBHOOK_SETTINGS_KEY, value: { url: 'http://127.0.0.1:9/hook' } })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { url: 'http://127.0.0.1:9/hook' } },
      });
    await expect(notifier.fire({ type: 'resolve', alert: { id: 1 } })).resolves.toBeUndefined();
    await db.orm.delete(appSettings).where(eq(appSettings.key, WEBHOOK_SETTINGS_KEY));
  });
});

describe('告警路由: 权限矩阵与设置', () => {
  let ts: TestServer;
  let rootCookie: string;
  let viewerCookie: string;
  let opCookie: string;
  let ownSiteId: number;
  let otherSiteId: number;
  let ownAlertId: number;
  let otherAlertId: number;
  let globalAlertId: number;
  let resolvedAlertId: number;

  async function seedAlert(input: {
    kind: string;
    siteId?: number;
    status?: string;
    title: string;
  }): Promise<number> {
    const rows = await ts.db.orm
      .insert(alerts)
      .values({
        kind: input.kind,
        severity: 'warning',
        title: input.title,
        status: input.status ?? 'open',
        ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
      })
      .returning({ id: alerts.id });
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ts = await makeTestServer();
    rootCookie = (await ts.seedLogin({ email: 'r@example.com', password: 'pw-12345678', role: 'root' })).cookie;
    viewerCookie = (await ts.seedLogin({ email: 'v@example.com', password: 'pw-12345678', role: 'viewer' })).cookie;
    const op = await ts.seedLogin({ email: 'o@example.com', password: 'pw-12345678', role: 'operator' });
    opCookie = op.cookie;
    const other = await ts.seedLogin({ email: 'x@example.com', password: 'pw-12345678', role: 'operator' });

    ownSiteId = (
      await ts.db.orm
        .insert(sites)
        .values({
          operatorId: op.operatorId,
          slug: 'route-own',
          label: '自有站',
          engine: 'sub2api',
          version: 'v1.0.0',
          hostPort: 18401,
          baseUrl: 'http://127.0.0.1:18401',
          status: 'active',
        })
        .returning({ id: sites.id })
    )[0]!.id;
    otherSiteId = (
      await ts.db.orm
        .insert(sites)
        .values({
          operatorId: other.operatorId,
          slug: 'route-other',
          label: '他人站',
          engine: 'newapi',
          version: 'v1.0.0',
          hostPort: 18402,
          baseUrl: 'http://127.0.0.1:18402',
          status: 'active',
        })
        .returning({ id: sites.id })
    )[0]!.id;

    ownAlertId = await seedAlert({ kind: 'site_down', siteId: ownSiteId, title: '站点不可达' });
    otherAlertId = await seedAlert({ kind: 'site_down', siteId: otherSiteId, title: '站点不可达' });
    globalAlertId = await seedAlert({ kind: 'job_failed', title: 'destroy 任务失败' });
    resolvedAlertId = await seedAlert({
      kind: 'channel_disabled',
      siteId: ownSiteId,
      status: 'resolved',
      title: '渠道被禁用',
    });
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  function idsOf(res: { json(): unknown }): number[] {
    return ((res.json() as { alerts: { id: number }[] }).alerts ?? []).map((a) => a.id);
  }

  it('未登录 → 401', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/alerts' });
    expect(res.statusCode).toBe(401);
  });

  it('root/viewer 默认只看 open 且全量可见（含全局告警），响应带站点信息', async () => {
    for (const cookie of [rootCookie, viewerCookie]) {
      const res = await ts.app.inject({ method: 'GET', url: '/api/alerts', cookies: { rp_session: cookie } });
      expect(res.statusCode).toBe(200);
      const ids = idsOf(res);
      expect(ids).toContain(ownAlertId);
      expect(ids).toContain(otherAlertId);
      expect(ids).toContain(globalAlertId);
      expect(ids).not.toContain(resolvedAlertId);
    }
    const res = await ts.app.inject({ method: 'GET', url: '/api/alerts', cookies: { rp_session: rootCookie } });
    const own = (res.json() as { alerts: { id: number; siteSlug: string | null }[] }).alerts.find(
      (a) => a.id === ownAlertId,
    );
    expect(own?.siteSlug).toBe('route-own');
  });

  it('operator 只见 own 站告警；全局告警与他站告警均不可见', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/alerts?status=all', cookies: { rp_session: opCookie } });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res);
    expect(ids).toContain(ownAlertId);
    expect(ids).toContain(resolvedAlertId);
    expect(ids).not.toContain(otherAlertId);
    expect(ids).not.toContain(globalAlertId);
  });

  it('可见性下推：他站 100 条更新的 open 告警塞满 LIMIT 窗口，operator 仍能拿到自己那条', async () => {
    // 他站（other 名下）灌 100 条 lastSeenAt 更新的 open 告警：若可见性在 LIMIT 之后
    // 过滤，这 100 条会挤满默认 LIMIT=100 窗口，operator own 站的旧告警被挤出→看不到。
    const base = Date.now() + 3_600_000; // 保证严格新于 beforeAll 里 own 告警
    const decoys = Array.from({ length: 100 }, (_, i) => ({
      kind: 'site_down',
      severity: 'warning',
      title: '他站噪声告警',
      status: 'open',
      siteId: otherSiteId,
      lastSeenAt: toPgTimestamp(new Date(base + i * 1000)),
    }));
    const inserted = await ts.db.orm.insert(alerts).values(decoys).returning({ id: alerts.id });
    const decoyIds = inserted.map((r) => r.id);
    try {
      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/alerts',
        cookies: { rp_session: opCookie },
      });
      expect(res.statusCode).toBe(200);
      const ids = idsOf(res);
      // own 站的 open 告警仍在，且没有任何他站噪声泄露
      expect(ids).toContain(ownAlertId);
      for (const id of decoyIds) expect(ids).not.toContain(id);
    } finally {
      // 仅清理本用例注入的噪声，保留 beforeAll 里的原始 otherAlertId 供后续用例断言
      await ts.db.orm.delete(alerts).where(inArray(alerts.id, decoyIds));
    }
  });

  it('status 过滤：resolved / all / 非法值 400', async () => {
    const resolved = await ts.app.inject({
      method: 'GET',
      url: '/api/alerts?status=resolved',
      cookies: { rp_session: rootCookie },
    });
    expect(idsOf(resolved)).toContain(resolvedAlertId);
    expect(idsOf(resolved)).not.toContain(ownAlertId);

    const all = await ts.app.inject({
      method: 'GET',
      url: '/api/alerts?status=all',
      cookies: { rp_session: rootCookie },
    });
    for (const id of [ownAlertId, otherAlertId, globalAlertId, resolvedAlertId]) {
      expect(idsOf(all)).toContain(id);
    }

    const bad = await ts.app.inject({
      method: 'GET',
      url: '/api/alerts?status=bogus',
      cookies: { rp_session: rootCookie },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('resolve 权限矩阵：viewer 403；operator 对他站/全局 404；对 own 站 200 并出审计与通知', async () => {
    const asViewer = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${ownAlertId}/resolve`,
      cookies: { rp_session: viewerCookie },
    });
    expect(asViewer.statusCode).toBe(403);

    const asOpOther = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${otherAlertId}/resolve`,
      cookies: { rp_session: opCookie },
    });
    expect(asOpOther.statusCode).toBe(404);

    const asOpGlobal = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${globalAlertId}/resolve`,
      cookies: { rp_session: opCookie },
    });
    expect(asOpGlobal.statusCode).toBe(404);

    const ok = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${ownAlertId}/resolve`,
      cookies: { rp_session: opCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { alert: { status: string } }).alert.status).toBe('resolved');
    const row = (
      await ts.db.orm.select().from(alerts).where(eq(alerts.id, ownAlertId)).limit(1)
    )[0]!;
    expect(row.status).toBe('resolved');
    expect(row.resolvedAt).toBeTruthy();
    // 手动 resolve 也触发 resolve 通知事件
    const resolveEvents = ts.notifier.events.filter(
      (e) => e.type === 'resolve' && (e.alert as { id: number }).id === ownAlertId,
    );
    expect(resolveEvents).toHaveLength(1);
    // 审计落盘
    const audits = await ts.db.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'alert.resolve'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe('o@example.com');
    expect(audits[0]!.siteId).toBe(ownSiteId);
    expect(audits[0]!.payload).toMatchObject({ alertId: ownAlertId, kind: 'site_down' });

    // 已解决的告警再 resolve → 400
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${ownAlertId}/resolve`,
      cookies: { rp_session: opCookie },
    });
    expect(again.statusCode).toBe(400);

    // root 可 resolve 全局告警
    const rootGlobal = await ts.app.inject({
      method: 'POST',
      url: `/api/alerts/${globalAlertId}/resolve`,
      cookies: { rp_session: rootCookie },
    });
    expect(rootGlobal.statusCode).toBe(200);

    // 非法 id 与不存在
    const badId = await ts.app.inject({
      method: 'POST',
      url: '/api/alerts/abc/resolve',
      cookies: { rp_session: rootCookie },
    });
    expect(badId.statusCode).toBe(400);
    const missing = await ts.app.inject({
      method: 'POST',
      url: '/api/alerts/999999/resolve',
      cookies: { rp_session: rootCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('设置端点仅 root：读写 webhook 地址，非法地址 400，审计不落原值', async () => {
    for (const cookie of [opCookie, viewerCookie]) {
      const g = await ts.app.inject({ method: 'GET', url: '/api/settings/alerts', cookies: { rp_session: cookie } });
      expect(g.statusCode).toBe(403);
      const p = await ts.app.inject({
        method: 'PUT',
        url: '/api/settings/alerts',
        cookies: { rp_session: cookie },
        payload: { webhookUrl: 'https://hooks.example.com/alert' },
      });
      expect(p.statusCode).toBe(403);
    }

    const initial = await ts.app.inject({
      method: 'GET',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ webhookUrl: null, alertEmailTo: null });

    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
      payload: { webhookUrl: 'https://hooks.example.com/alert' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, webhookUrl: 'https://hooks.example.com/alert' });

    const readBack = await ts.app.inject({
      method: 'GET',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
    });
    expect(readBack.json()).toEqual({ webhookUrl: 'https://hooks.example.com/alert', alertEmailTo: null });

    // 审计只记"是否配置"，不落地址原值（地址可能内嵌调用凭据）
    const audits = await ts.db.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'settings.alerts'));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain('hooks.example.com');
    expect(audits[audits.length - 1]!.payload).toMatchObject({ hasWebhook: true });

    // 清空
    const clear = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
      payload: { webhookUrl: '' },
    });
    expect(clear.statusCode).toBe(200);
    const cleared = await ts.app.inject({
      method: 'GET',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
    });
    expect(cleared.json()).toEqual({ webhookUrl: null, alertEmailTo: null });

    // 非法地址与非 http/https 协议
    for (const badUrl of ['not-a-url', 'ftp://x.example.com/hook']) {
      const bad = await ts.app.inject({
        method: 'PUT',
        url: '/api/settings/alerts',
        cookies: { rp_session: rootCookie },
        payload: { webhookUrl: badUrl },
      });
      expect(bad.statusCode, badUrl).toBe(400);
    }
  });

  it('告警邮箱设置：仅 root 读写 alert_email_to，独立于 webhook，非法邮箱 400，审计不落原值', async () => {
    // operator/viewer 无权（GET/PUT 均 403）
    for (const cookie of [opCookie, viewerCookie]) {
      const p = await ts.app.inject({
        method: 'PUT',
        url: '/api/settings/alerts',
        cookies: { rp_session: cookie },
        payload: { alertEmailTo: 'ops@example.com' },
      });
      expect(p.statusCode).toBe(403);
    }

    // 设置邮箱（不带 webhookUrl → webhook 不受影响）
    const put = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
      payload: { alertEmailTo: 'oncall@example.com' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, alertEmailTo: 'oncall@example.com', webhookUrl: null });

    const readBack = await ts.app.inject({
      method: 'GET',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
    });
    expect(readBack.json()).toEqual({ webhookUrl: null, alertEmailTo: 'oncall@example.com' });

    // 审计不落邮箱原值，只记 hasEmail
    const audits = await ts.db.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'settings.alerts'));
    expect(JSON.stringify(audits)).not.toContain('oncall@example.com');
    expect(audits[audits.length - 1]!.payload).toMatchObject({ hasEmail: true });

    // 非法邮箱 400，且不改动已存值
    const bad = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
      payload: { alertEmailTo: 'not-an-email' },
    });
    expect(bad.statusCode).toBe(400);
    const stillSet = await ts.app.inject({
      method: 'GET',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
    });
    expect((stillSet.json() as { alertEmailTo: string | null }).alertEmailTo).toBe('oncall@example.com');

    // 清空邮箱
    const clear = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/alerts',
      cookies: { rp_session: rootCookie },
      payload: { alertEmailTo: '' },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({ alertEmailTo: null });
  });
});
