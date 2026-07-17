import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditEvents, sites, subscriptions } from '../src/db/schema.js';
import { toPgTimestamp, fromPgTimestamp } from '../src/auth/sessions.js';
import {
  ManualProvider,
  activeSites,
  quotaFor,
  subscribeOperator,
  type PaymentProvider,
} from '../src/billing/service.js';
import * as sitesService from '../src/sites/service.js';
import { makeTestServer, seedOperator, type TestServer } from './helpers.js';

/**
 * G4 计费模块测试：quotaFor 全矩阵、provision 配额语义（单元级）、
 * 订阅开通/顺延/取消与权限、/metrics 快照指标。
 * pglite 冷启动约 4s，整文件共享一个服务实例。
 */

vi.setConfig({ testTimeout: 30_000 });

const DAY_MS = 86_400_000;

/** G1 契约导出（并行施工期间可能尚未落地，相关用例 skipIf） */
const snapshotCache = (
  sitesService as unknown as {
    latestSnapshotCache?: Map<string, { ok: boolean; cost24h?: number }>;
  }
).latestSnapshotCache;

let ts: TestServer;
let rootCookie: string;
let opCookie: string;
let opId: number;
let viewerCookie: string;

beforeAll(async () => {
  ts = await makeTestServer();
  const root = await ts.seedLogin({ email: 'bill-root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const op = await ts.seedLogin({ email: 'bill-op@example.com', password: 'op-pass-1234', role: 'operator' });
  opCookie = op.cookie;
  opId = op.operatorId;
  const viewer = await ts.seedLogin({
    email: 'bill-viewer@example.com',
    password: 'viewer-pass-1234',
    role: 'viewer',
  });
  viewerCookie = viewer.cookie;
}, 60_000);

afterAll(async () => {
  await ts.close();
});

function ctxOf(operatorId: number, role: string): { operatorId: number; email: string; role: string } {
  return { operatorId, email: `ctx-${operatorId}@example.com`, role };
}

describe('quotaFor 全矩阵', () => {
  it('root / viewer 不限额（Infinity）', async () => {
    const rootId = await seedOperator(ts.db, { role: 'root' });
    const viewerId = await seedOperator(ts.db, { role: 'viewer' });
    expect(await quotaFor(ts.db, ctxOf(rootId, 'root'))).toBe(Infinity);
    expect(await quotaFor(ts.db, ctxOf(viewerId, 'viewer'))).toBe(Infinity);
  });

  it('operator 无订阅 → free 档（1）', async () => {
    const id = await seedOperator(ts.db, { role: 'operator' });
    expect(await quotaFor(ts.db, ctxOf(id, 'operator'))).toBe(1);
  });

  it('operator 有效订阅 → 套餐档（pro=5）', async () => {
    const id = await seedOperator(ts.db, { role: 'operator' });
    await ts.db.orm.insert(subscriptions).values({
      operatorId: id,
      planKey: 'pro',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 10 * DAY_MS)),
    });
    expect(await quotaFor(ts.db, ctxOf(id, 'operator'))).toBe(5);
  });

  it('operator 过期订阅（status 仍 active）→ 回落 free', async () => {
    const id = await seedOperator(ts.db, { role: 'operator' });
    await ts.db.orm.insert(subscriptions).values({
      operatorId: id,
      planKey: 'pro',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() - DAY_MS)),
    });
    expect(await quotaFor(ts.db, ctxOf(id, 'operator'))).toBe(1);
  });

  it('operator 已取消订阅（未到期）→ 回落 free', async () => {
    const id = await seedOperator(ts.db, { role: 'operator' });
    await ts.db.orm.insert(subscriptions).values({
      operatorId: id,
      planKey: 'scale',
      status: 'cancelled',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 10 * DAY_MS)),
    });
    expect(await quotaFor(ts.db, ctxOf(id, 'operator'))).toBe(1);
  });
});

describe('activeSites 与 provision 配额语义（单元级，不依赖 G1）', () => {
  it('destroyed 不占额；quota 用满即应拒绝新开站', async () => {
    const id = await seedOperator(ts.db, { role: 'operator' });
    await ts.db.orm.insert(sites).values([
      {
        operatorId: id,
        slug: `quota-a-${id}`,
        label: '占额站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18801,
        baseUrl: 'http://127.0.0.1:18801',
        status: 'active',
      },
      {
        operatorId: id,
        slug: `quota-b-${id}`,
        label: '已销毁站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18802,
        baseUrl: 'http://127.0.0.1:18802',
        status: 'destroyed',
      },
    ]);
    expect(await activeSites(ts.db, id)).toBe(1);

    // provision 前置检查语义：used >= quota 即拒绝
    const quota = await quotaFor(ts.db, ctxOf(id, 'operator'));
    expect(quota).toBe(1);
    expect((await activeSites(ts.db, id)) >= quota).toBe(true);

    // 开通 pro 后配额放宽
    await subscribeOperator(ts.db, { operatorId: id, planKey: 'pro', months: 1 });
    const quota2 = await quotaFor(ts.db, ctxOf(id, 'operator'));
    expect(quota2).toBe(5);
    expect((await activeSites(ts.db, id)) < quota2).toBe(true);
  });
});

describe('订阅路由', () => {
  it('GET /api/billing/plans 保持种子三档（既有行为不变）', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/billing/plans', cookies: { rp_session: opCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plans: { key: string; siteQuota: number }[] };
    expect(body.plans.map((p) => p.key)).toEqual(['free', 'pro', 'scale']);
  });

  it('operator 无订阅：subscription 显示 free 档', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan: { key: 'free', siteQuota: 1 },
      periodEnd: null,
      quota: 1,
      usedSites: 0,
    });
  });

  it('root/viewer 的 subscription：quota null（不限额）', async () => {
    for (const cookie of [rootCookie, viewerCookie]) {
      const res = await ts.app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        cookies: { rp_session: cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ plan: null, periodEnd: null, quota: null });
    }
  });

  it('非 root 禁止管理订阅', async () => {
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: opCookie },
    });
    expect(list.statusCode).toBe(403);

    const create = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: viewerCookie },
      payload: { operatorEmail: 'bill-op@example.com', planKey: 'pro', months: 1 },
    });
    expect(create.statusCode).toBe(403);
  });

  it('root 开通 → 顺延 → 取消 全链路', async () => {
    // 开通：months=1 → now + 30 天
    const create = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
      payload: { operatorEmail: 'bill-op@example.com', planKey: 'pro', months: 1 },
    });
    expect(create.statusCode).toBe(200);
    const created = (create.json() as { subscription: { id: number; currentPeriodEnd: string; planKey: string } })
      .subscription;
    expect(created.planKey).toBe('pro');
    const end1 = fromPgTimestamp(created.currentPeriodEnd).getTime();
    expect(Math.abs(end1 - (Date.now() + 30 * DAY_MS))).toBeLessThan(15_000);

    // operator 视角生效
    const mine = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      cookies: { rp_session: opCookie },
    });
    expect(mine.json()).toMatchObject({
      plan: { key: 'pro', siteQuota: 5 },
      periodEnd: created.currentPeriodEnd,
      quota: 5,
    });

    // 顺延：months=2 → 在原到期日上 +60 天（精确）
    const renew = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
      payload: { operatorEmail: 'bill-op@example.com', planKey: 'pro', months: 2 },
    });
    expect(renew.statusCode).toBe(200);
    const renewed = (renew.json() as { subscription: { id: number; currentPeriodEnd: string } }).subscription;
    expect(renewed.id).toBe(created.id); // 顺延复用同一条订阅
    expect(fromPgTimestamp(renewed.currentPeriodEnd).getTime()).toBe(end1 + 60 * DAY_MS);

    // root 列表可见（含 operatorEmail）
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { subscriptions: { id: number; operatorEmail: string }[] }).subscriptions;
    expect(rows.some((r) => r.id === created.id && r.operatorEmail === 'bill-op@example.com')).toBe(true);

    // 取消 → operator 回落 free
    const cancel = await ts.app.inject({
      method: 'DELETE',
      url: `/api/billing/subscriptions/${created.id}`,
      cookies: { rp_session: rootCookie },
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { subscription: { status: string } }).subscription.status).toBe('cancelled');

    const after = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      cookies: { rp_session: opCookie },
    });
    expect(after.json()).toMatchObject({ plan: { key: 'free' }, quota: 1, periodEnd: null });
  });

  it('参数与目标校验：未知操作员/套餐 404，非法 months/id 400', async () => {
    const badOp = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
      payload: { operatorEmail: 'no-such@example.com', planKey: 'pro', months: 1 },
    });
    expect(badOp.statusCode).toBe(404);

    const badPlan = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
      payload: { operatorEmail: 'bill-op@example.com', planKey: 'no-such-plan', months: 1 },
    });
    expect(badPlan.statusCode).toBe(404);

    const badMonths = await ts.app.inject({
      method: 'POST',
      url: '/api/billing/subscriptions',
      cookies: { rp_session: rootCookie },
      payload: { operatorEmail: 'bill-op@example.com', planKey: 'pro', months: 0 },
    });
    expect(badMonths.statusCode).toBe(400);

    const badId = await ts.app.inject({
      method: 'DELETE',
      url: '/api/billing/subscriptions/abc',
      cookies: { rp_session: rootCookie },
    });
    expect(badId.statusCode).toBe(400);

    const missingId = await ts.app.inject({
      method: 'DELETE',
      url: '/api/billing/subscriptions/999999',
      cookies: { rp_session: rootCookie },
    });
    expect(missingId.statusCode).toBe(404);
  });

  it('审计落盘：billing.subscribe / billing.cancel，套餐字段未被误脱敏', async () => {
    const rows = await ts.db.orm.select().from(auditEvents);
    const subscribe = rows.filter((r) => r.action === 'billing.subscribe' && r.ok);
    const cancel = rows.filter((r) => r.action === 'billing.cancel' && r.ok);
    expect(subscribe.length).toBeGreaterThan(0);
    expect(cancel.length).toBeGreaterThan(0);
    // payload 用 'plan' 而非 'planKey'（key* 字段名会被 redact 整值抹掉）
    expect(subscribe[0]!.payload).toMatchObject({ plan: 'pro', operatorEmail: 'bill-op@example.com' });
    expect(JSON.stringify(subscribe[0]!.payload)).not.toContain('<redacted>');
  });
});

describe('PaymentProvider 扩展位', () => {
  it('ManualProvider 无自助支付（createCheckout 缺省）', () => {
    const provider: PaymentProvider = new ManualProvider();
    expect(provider.name).toBe('manual');
    expect(provider.createCheckout).toBeUndefined();
  });
});

describe('/metrics 快照指标（G4 新增两组）', () => {
  it('指标组头恒在（快照缓存为空/缺失时无样本行）', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/metrics', cookies: { rp_session: rootCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# TYPE rp_site_up gauge');
    expect(res.body).toContain('# TYPE rp_usage24h_cost gauge');
  });

  describe.skipIf(!snapshotCache)('手工填充 latestSnapshotCache 后断言输出行', () => {
    it('rp_site_up 0/1；rp_usage24h_cost 仅有 cost24h 的站输出', async () => {
      snapshotCache!.set('metrics-site-a', { ok: true, cost24h: 1.25 });
      snapshotCache!.set('metrics-site-b', { ok: false });
      try {
        const res = await ts.app.inject({ method: 'GET', url: '/metrics', cookies: { rp_session: rootCookie } });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('rp_site_up{slug="metrics-site-a"} 1');
        expect(res.body).toContain('rp_site_up{slug="metrics-site-b"} 0');
        expect(res.body).toContain('rp_usage24h_cost{slug="metrics-site-a"} 1.25');
        expect(res.body).not.toContain('rp_usage24h_cost{slug="metrics-site-b"}');
      } finally {
        snapshotCache!.delete('metrics-site-a');
        snapshotCache!.delete('metrics-site-b');
      }
    });
  });
});
