import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { channelGrants, channelTemplates, sites, usageLedger } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { pullOnce, settlement, startPullLoop, upsertRows } from '../src/marketplace/ledger.js';
import { FakeGateway, type GatewayUsageRow } from './fakes.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 用量账本（G2，规格 §7）：upsert 幂等 / pullOnce 增量窗口 / settlement 毛利数学 /
 * 手工补账路由。pglite 冷启动约 4s，整文件共享一个测试服务。
 */

vi.setConfig({ testTimeout: 30_000 });

/** 构造账本行：2026 年某月 startDay 起跨 days 天的账期 */
function row(
  month: number,
  startDay: number,
  data: Partial<GatewayUsageRow> = {},
  days = 1,
): GatewayUsageRow {
  const mm = String(month).padStart(2, '0');
  const start = new Date(`2026-${mm}-${String(startDay).padStart(2, '0')}T00:00:00.000Z`);
  const end = new Date(start.getTime() + days * 86_400_000);
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    upstreamCost: 0,
    billedCost: 0,
    ...data,
  };
}

let ts: TestServer;
let rootCookie: string;
let opCookie: string;
let siteL1Id = 0;
// 授权：g1/g2 = 增量拉取用（meter-a/meter-b）；g3 = byo 无计量；g4/g5 = 结算数学用
let g1 = 0;
let g2 = 0;
let g3 = 0;
let g4 = 0;
let g5 = 0;

beforeAll(async () => {
  ts = await makeTestServer();
  const root = await ts.seedLogin({ email: 'root-ldg@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const op = await ts.seedLogin({ email: 'op-ldg@example.com', password: 'op-pass-1234', role: 'operator' });
  opCookie = op.cookie;

  const tpl = (
    await ts.db.orm
      .insert(channelTemplates)
      .values({ key: 'ldg-managed', title: '托管模板', protocol: 'openai', models: ['m-1'], source: 'managed' })
      .returning()
  )[0]!;

  const siteRows = await ts.db.orm
    .insert(sites)
    .values([
      {
        operatorId: op.operatorId,
        slug: 'site-l1',
        label: 'L1 站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18301,
        baseUrl: 'http://127.0.0.1:18301',
        status: 'active',
      },
      {
        operatorId: root.operatorId,
        slug: 'site-l2',
        label: 'L2 站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18302,
        baseUrl: 'http://127.0.0.1:18302',
        status: 'active',
      },
    ])
    .returning();
  siteL1Id = siteRows[0]!.id;
  const siteL2Id = siteRows[1]!.id;

  // createdAt 显式钉在过去——pullOnce 首拉窗口 from=created_at，需覆盖测试账期
  const createdAt = toPgTimestamp(new Date('2026-06-01T00:00:00.000Z'));
  const grants = await ts.db.orm
    .insert(channelGrants)
    .values([
      { siteId: siteL1Id, templateId: tpl.id, engineChannelId: '11', meterKeyRef: 'meter-a', createdBy: 'system', createdAt },
      { siteId: siteL2Id, templateId: tpl.id, engineChannelId: '12', meterKeyRef: 'meter-b', createdBy: 'system', createdAt },
      { siteId: siteL1Id, templateId: tpl.id, engineChannelId: '13', meterKeyRef: null, createdBy: 'system', createdAt },
      { siteId: siteL1Id, templateId: tpl.id, engineChannelId: '14', meterKeyRef: 'meter-c', channelName: '结算C', createdBy: 'system', createdAt },
      { siteId: siteL2Id, templateId: tpl.id, engineChannelId: '15', meterKeyRef: 'meter-d', channelName: '结算D', createdBy: 'system', createdAt },
    ])
    .returning({ id: channelGrants.id });
  [g1, g2, g3, g4, g5] = grants.map((g) => g.id) as [number, number, number, number, number];
}, 60_000);

afterAll(async () => {
  await ts.close();
});

describe('upsertRows 幂等', () => {
  const base = row(6, 1, { requests: 10, promptTokens: 1000, completionTokens: 500, upstreamCost: 1, billedCost: 2.5 });

  it('同 (grant, period, source) 重复写不翻倍，只更新', async () => {
    expect(await upsertRows(ts.db, g1, [base], 'gateway')).toBe(1);
    expect(await upsertRows(ts.db, g1, [base], 'gateway')).toBe(1);

    let rows = await ts.db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, g1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 10, promptTokens: 1000, source: 'gateway' });

    // 同期重拉且数值修正 → 覆盖更新
    await upsertRows(ts.db, g1, [{ ...base, requests: 12 }], 'gateway');
    rows = await ts.db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, g1));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBe(12);
  });

  it('同期不同 source 是两行（manual 补账不覆盖 gateway）', async () => {
    await upsertRows(ts.db, g1, [{ ...base, requests: 3 }], 'manual');
    const rows = await ts.db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, g1));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['gateway', 'manual']));
  });

  it('period_end 不晚于 period_start → 400', async () => {
    await expect(
      upsertRows(ts.db, g1, [{ ...base, periodEnd: base.periodStart }], 'manual'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('numeric 金额精确 round-trip（scale=6，无 float4 舍入漂移，读出为 number）', async () => {
    // real(float4) 只有 ~7 位有效数字，0.123457 会舍成 0.12345700…≠；numeric(14,6) 精确保 6 位
    const precise = row(8, 1, { requests: 999, upstreamCost: 0.123457, billedCost: 1.234561 });
    await upsertRows(ts.db, g1, [precise], 'gateway');
    const stored = (await ts.db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, g1))).find(
      (r) => r.requests === 999,
    )!;
    expect(typeof stored.upstreamCost).toBe('number');
    expect(stored.upstreamCost).toBe(0.123457);
    expect(stored.billedCost).toBe(1.234561);
    expect(stored.billedCost - stored.upstreamCost).toBeCloseTo(1.111104, 6);
  });
});

describe('pullOnce 增量窗口', () => {
  const gw = new FakeGateway();
  const calls: { keyRef: string; from: Date; to: Date }[] = [];

  beforeAll(() => {
    const orig = gw.pullUsage.bind(gw);
    gw.pullUsage = async (keyRef: string, from: Date, to: Date) => {
      calls.push({ keyRef, from, to });
      return orig(keyRef, from, to);
    };
  });

  const j1 = row(6, 1, { requests: 10, upstreamCost: 0.1, billedCost: 0.3 });
  const j2 = row(6, 2, { requests: 20, upstreamCost: 0.2, billedCost: 0.6 });
  const j3 = row(6, 3, { requests: 30, upstreamCost: 0.3, billedCost: 0.9 });

  it('首拉 from=grant.created_at；byo 授权不拉取', async () => {
    gw.setUsage('meter-b', [j1, j2]);
    const now = new Date('2026-06-10T00:00:00.000Z');
    const result = await pullOnce(ts.db, gw, now);
    expect(result.errors).toBe(0);

    const rows = await ts.db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, g2));
    expect(rows).toHaveLength(2);

    const call = calls.find((c) => c.keyRef === 'meter-b');
    expect(call!.from.getTime()).toBe(new Date('2026-06-01T00:00:00.000Z').getTime());
    expect(call!.to.getTime()).toBe(now.getTime());
    // g3 无 meterKeyRef，绝不出现在拉取里
    expect(calls.some((c) => c.keyRef === '13' || c.keyRef === '')).toBe(false);
  });

  it('再拉 from=最新 period_end，只取增量且不翻倍', async () => {
    gw.setUsage('meter-b', [j1, j2, j3]);
    calls.length = 0;
    await pullOnce(ts.db, gw, new Date('2026-06-11T00:00:00.000Z'));

    const call = calls.find((c) => c.keyRef === 'meter-b');
    // 最新 period_end = j2 的 6/3
    expect(call!.from.getTime()).toBe(new Date('2026-06-03T00:00:00.000Z').getTime());

    const rows = await ts.db.orm
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.grantId, g2), eq(usageLedger.source, 'gateway')));
    expect(rows).toHaveLength(3);
    // j1 未被重复累计
    const first = rows.find((r) => r.requests === 10);
    expect(first).toBeTruthy();
    expect(rows.reduce((s, r) => s + r.requests, 0)).toBe(60);
  });

  it('startPullLoop 启动即拉一轮，stop 后停止', async () => {
    const before = calls.length;
    const stop = startPullLoop(ts.db, gw, 60_000);
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThan(before);
    });
    stop();
  });
});

describe('settlement 毛利数学', () => {
  beforeAll(async () => {
    await upsertRows(
      ts.db,
      g4,
      [
        row(7, 1, { requests: 10, promptTokens: 1000, completionTokens: 500, upstreamCost: 1.0, billedCost: 2.5 }),
        row(7, 2, { requests: 5, promptTokens: 500, completionTokens: 250, upstreamCost: 0.5, billedCost: 1.0 }),
      ],
      'gateway',
    );
    await upsertRows(
      ts.db,
      g5,
      [row(7, 1, { requests: 7, promptTokens: 700, completionTokens: 300, upstreamCost: 2.0, billedCost: 2.6 })],
      'gateway',
    );
  });

  it('按 grant 汇总，margin = billed - upstream', async () => {
    const rows = await settlement(ts.db, { month: '2026-07' });
    expect(rows).toHaveLength(2);

    const r4 = rows.find((r) => r.grantId === g4)!;
    expect(r4).toMatchObject({
      siteSlug: 'site-l1',
      templateKey: 'ldg-managed',
      channelName: '结算C',
      requests: 15,
      promptTokens: 1500,
      completionTokens: 750,
      tokens: 2250,
    });
    expect(r4.upstreamCost).toBeCloseTo(1.5, 6);
    expect(r4.billedCost).toBeCloseTo(3.5, 6);
    expect(r4.margin).toBeCloseTo(2.0, 6);

    const r5 = rows.find((r) => r.grantId === g5)!;
    expect(r5.margin).toBeCloseTo(0.6, 6);
  });

  it('month 与 siteId 过滤；月份非法 → 400', async () => {
    const may = await settlement(ts.db, { month: '2026-05' });
    expect(may).toHaveLength(0);

    const bySite = await settlement(ts.db, { siteId: siteL1Id, month: '2026-07' });
    expect(bySite.map((r) => r.grantId)).toEqual([g4]);

    await expect(settlement(ts.db, { month: '2026-13' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(settlement(ts.db, { month: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ledger 路由', () => {
  it('root 全量；operator 只见自己站；不泄露 meterKeyRef', async () => {
    const asRoot = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/ledger?month=2026-07',
      cookies: { rp_session: rootCookie },
    });
    expect(asRoot.statusCode, asRoot.body).toBe(200);
    const rootBody = asRoot.json() as { rows: { grantId: number }[]; totals: { margin: number } };
    expect(rootBody.rows).toHaveLength(2);
    expect(rootBody.totals.margin).toBeCloseTo(2.6, 6);
    expect(asRoot.body).not.toContain('meter-');
    expect(asRoot.body).not.toContain('operatorId');

    const asOp = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/ledger?month=2026-07',
      cookies: { rp_session: opCookie },
    });
    const opBody = asOp.json() as { rows: { grantId: number }[]; totals: { margin: number } };
    expect(opBody.rows.map((r) => r.grantId)).toEqual([g4]);
    expect(opBody.totals.margin).toBeCloseTo(2.0, 6);
  });

  it('?siteSlug 无权 → 404；month 非法 → 400', async () => {
    const forbidden = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/ledger?siteSlug=site-l2',
      cookies: { rp_session: opCookie },
    });
    expect(forbidden.statusCode).toBe(404);

    const badMonth = await ts.app.inject({
      method: 'GET',
      url: '/api/marketplace/ledger?month=2026-7',
      cookies: { rp_session: rootCookie },
    });
    expect(badMonth.statusCode).toBe(400);
  });

  it('手工补账：root 导入 manual 行，重导不翻倍；非 root 403；grant 不存在 404', async () => {
    const payload = {
      grantId: g3,
      rows: [
        {
          periodStart: '2026-06-05T00:00:00.000Z',
          periodEnd: '2026-06-06T00:00:00.000Z',
          requests: 4,
          promptTokens: 400,
          completionTokens: 100,
          upstreamCost: 0.4,
          billedCost: 0.8,
        },
      ],
    };
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/ledger/import',
      cookies: { rp_session: rootCookie },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ imported: 1 });

    // 同期重导（修正数值）→ 更新不新增
    payload.rows[0]!.requests = 6;
    await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/ledger/import',
      cookies: { rp_session: rootCookie },
      payload,
    });
    const rows = await ts.db.orm
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.grantId, g3), eq(usageLedger.source, 'manual')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBe(6);

    const asOp = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/ledger/import',
      cookies: { rp_session: opCookie },
      payload,
    });
    expect(asOp.statusCode).toBe(403);

    const missing = await ts.app.inject({
      method: 'POST',
      url: '/api/marketplace/ledger/import',
      cookies: { rp_session: rootCookie },
      payload: { ...payload, grantId: 999999 },
    });
    expect(missing.statusCode).toBe(404);
  });
});
