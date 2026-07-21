import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, EngineKind, PlatformQuota } from '@relay-panel/adapter-core';
import type { Db } from '../src/db/client.js';
import { sites } from '../src/db/schema.js';
import { clearSiteCaches } from '../src/sites/service.js';
import {
  RiskService,
  detectSpikes,
  mergeQuotaInput,
  parseRiskRules,
  type QuotaChange,
  type RiskDeps,
  type RiskRules,
} from '../src/risk/service.js';
import { makeTestConfig, makeTestDb, makeTestServer, seedOperator } from './helpers.js';
import { FakeAdapter, FakeNotifier } from './fakes.js';

/**
 * F3 风控单测：
 *  ① detectSpikes：超倍率 + 过绝对下限才告警；新增大额（无基线）判骤增；小额不误报
 *  ② mergeQuotaInput：GET-合并保留未涉及 platform 与同 platform 其它窗口；null≠0
 *  ③ parseRiskRules：越界/缺省回落默认
 *  ④ RiskService.scan：骤增开 spend_spike 告警；降级站剔除（连不上不误报/不崩）
 *  ⑤ enforceQuota：RP_RISK_ENFORCE=off 直接 403 且绝不调 setPlatformQuotas；
 *     on 时 GET-合并-PUT 写回（保留其它 platform/窗口，null≠0）
 *  ⑥ /api/risk/* 非 root → 403；off 时 enforce 端点 403
 */

// makeTestServer + scrypt 登录 + 全量迁移较慢，放宽超时（同 finance-report.test.ts）
vi.setConfig({ testTimeout: 30_000 });

const RULES: RiskRules = { spikeMultiplier: 3, absFloorUsd: 10, baselineDays: 7 };

function ranking(userId: number, email: string, actualCost: number) {
  return { userId, email, actualCost, requests: 100, tokens: 1000 };
}

// ---------------------------------------------------------------------------
// ① detectSpikes（纯函数）
// ---------------------------------------------------------------------------

describe('detectSpikes 骤增判定', () => {
  it('超倍率且过绝对下限才告警；小额/未超倍率不报', () => {
    const recent = [
      ranking(1, 'a@x.com', 60), // 基线日均 10 → 6× → 骤增
      ranking(2, 'b@x.com', 5), // < absFloor 10 → 不报（即便无基线）
      ranking(3, 'c@x.com', 30), // 基线日均 30 → 1× → 不报
      ranking(4, 'd@x.com', 40), // 无基线 → Infinity → 骤增（新增大额）
    ];
    const baseline = [
      ranking(1, 'a@x.com', 70), // 7 日总 70 → 日均 10
      ranking(3, 'c@x.com', 210), // 7 日总 210 → 日均 30
    ];
    const spikes = detectSpikes(recent, baseline, RULES);
    // 按 recentCost 降序：user1(60) 再 user4(40)
    expect(spikes.map((s) => s.userId)).toEqual([1, 4]);
    expect(spikes[0]!.ratio).toBeCloseTo(6, 5);
    expect(spikes[0]!.baselineDaily).toBeCloseTo(10, 5);
    expect(spikes[1]!.ratio).toBe(Infinity);
    expect(spikes[1]!.baselineDaily).toBe(0);
  });

  it('绝对下限过滤小额高倍率噪音', () => {
    const recent = [ranking(1, 'a@x.com', 3)]; // 无基线但 3 < 10
    expect(detectSpikes(recent, [], RULES)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ② mergeQuotaInput（GET-合并纯函数）
// ---------------------------------------------------------------------------

function win(limitUsd: number | null, usageUsd = 0) {
  return { usageUsd, limitUsd };
}
function quota(platform: string, d: number | null, w: number | null, m: number | null): PlatformQuota {
  return { platform, daily: win(d), weekly: win(w), monthly: win(m) };
}

describe('mergeQuotaInput GET-合并（全量替换前的合并）', () => {
  const current: PlatformQuota[] = [
    quota('anthropic', 100, null, 500), // daily 100 / weekly 不限 / monthly 500
    quota('openai', null, 0, null), // daily 不限 / weekly 禁用(0) / monthly 不限
  ];

  it('改 anthropic.daily 保留其它 platform 与同 platform 其它窗口；null≠0', () => {
    const merged = mergeQuotaInput(current, { platform: 'anthropic', window: 'daily', limitUsd: 20 });
    const a = merged.find((q) => q.platform === 'anthropic')!;
    const o = merged.find((q) => q.platform === 'openai')!;
    expect(a.dailyLimitUsd).toBe(20); // 改
    expect(a.weeklyLimitUsd).toBeNull(); // 保留不限
    expect(a.monthlyLimitUsd).toBe(500); // 保留
    // 未涉及的 openai 整行保留：null(不限) 与 0(禁用) 严格区分
    expect(o.dailyLimitUsd).toBeNull();
    expect(o.weeklyLimitUsd).toBe(0);
    expect(o.monthlyLimitUsd).toBeNull();
  });

  it('新 platform（不在 current）追加行，其余窗口=不限 null，且保留既有全部行', () => {
    const merged = mergeQuotaInput(current, { platform: 'gemini', window: 'monthly', limitUsd: 300 });
    expect(merged.map((q) => q.platform).sort()).toEqual(['anthropic', 'gemini', 'openai']);
    const g = merged.find((q) => q.platform === 'gemini')!;
    expect(g.monthlyLimitUsd).toBe(300);
    expect(g.dailyLimitUsd).toBeNull();
    expect(g.weeklyLimitUsd).toBeNull();
  });

  it('清空输入=不限(null) 不等于 禁用(0)', () => {
    const merged = mergeQuotaInput(current, { platform: 'anthropic', window: 'daily', limitUsd: null });
    expect(merged.find((q) => q.platform === 'anthropic')!.dailyLimitUsd).toBeNull();
    const disabled = mergeQuotaInput(current, { platform: 'anthropic', window: 'daily', limitUsd: 0 });
    expect(disabled.find((q) => q.platform === 'anthropic')!.dailyLimitUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ③ parseRiskRules
// ---------------------------------------------------------------------------

describe('parseRiskRules 越界/缺省回落默认', () => {
  it('undefined → 默认；越界字段各自回落默认', () => {
    expect(parseRiskRules(undefined)).toEqual({ spikeMultiplier: 3, absFloorUsd: 10, baselineDays: 7 });
    expect(parseRiskRules({ spikeMultiplier: 0.5, absFloorUsd: -5, baselineDays: 200 })).toEqual({
      spikeMultiplier: 3,
      absFloorUsd: 10,
      baselineDays: 7,
    });
    expect(parseRiskRules({ spikeMultiplier: 5, absFloorUsd: 20, baselineDays: 14 })).toEqual({
      spikeMultiplier: 5,
      absFloorUsd: 20,
      baselineDays: 14,
    });
  });
});

// ---------------------------------------------------------------------------
// ④⑤ RiskService（scan + enforce），真 pglite 库
// ---------------------------------------------------------------------------

describe('RiskService scan / enforce', () => {
  let db: Db;

  beforeAll(async () => {
    db = await makeTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  beforeEach(() => {
    clearSiteCaches();
  });

  let siteSeq = 0;
  async function seedSite(slug: string): Promise<void> {
    const opId = await seedOperator(db, { role: 'root' });
    siteSeq += 1;
    await db.orm.insert(sites).values({
      operatorId: opId,
      slug,
      label: slug.toUpperCase(),
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 19000 + siteSeq,
      baseUrl: 'http://127.0.0.1:19001',
      status: 'active',
    });
  }

  function makeDeps(adapter: FakeAdapter, riskEnforce = false): { deps: RiskDeps; notifier: FakeNotifier } {
    const notifier = new FakeNotifier();
    const deps: RiskDeps = {
      config: makeTestConfig({ riskEnforce }),
      db,
      adapters: { sub2api: adapter, newapi: new FakeAdapter('newapi') } as unknown as Record<EngineKind, EngineAdapter>,
      notifier,
    };
    return { deps, notifier };
  }

  it('scan：健康站骤增开 spend_spike 告警；降级站(connect 失败)剔除不崩', async () => {
    await seedSite('risk-ok');
    await seedSite('risk-down');
    const adapter = new FakeAdapter('sub2api');
    adapter.setRanking('risk-ok', [ranking(1, 'big@x.com', 90)], [ranking(1, 'big@x.com', 70)]); // 90 vs 日均10 → 9×
    adapter.setUnreachable('risk-down'); // connect 抛错 → 剔除

    const { deps, notifier } = makeDeps(adapter);
    const service = new RiskService(deps);
    const results = await service.scan({ openAlerts: true });

    expect(results.map((r) => r.siteSlug)).toEqual(['risk-ok']);
    expect(results[0]!.spikes.map((s) => s.userId)).toEqual([1]);
    // 开了一条 spend_spike 告警（detail 枚举骤增用户）
    const opened = notifier.events.filter((e) => e.type === 'open');
    expect(opened).toHaveLength(1);
    expect((opened[0]!.alert as { kind: string }).kind).toBe('spend_spike');
    expect((opened[0]!.alert as { detail: string }).detail).toContain('big@x.com');
  });

  it('enforce off：直接 403，且绝不调 getPlatformQuotas/setPlatformQuotas', async () => {
    await seedSite('risk-enf-off');
    const adapter = new FakeAdapter('sub2api');
    adapter.setPlatformQuotas('risk-enf-off', '5', [quota('anthropic', 100, null, 500)]);
    const { deps } = makeDeps(adapter, false);
    const service = new RiskService(deps);
    const change: QuotaChange = { platform: 'anthropic', window: 'daily', limitUsd: 20 };

    await expect(
      service.enforceQuota({ operatorId: 1, email: 'root@x.com', role: 'root' }, 'risk-enf-off', '5', change),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(adapter.calls.some((c) => c.startsWith('users.setPlatformQuotas'))).toBe(false);
    expect(adapter.calls.some((c) => c.startsWith('users.getPlatformQuotas'))).toBe(false);
  });

  it('enforce on：GET-合并-PUT 写回，保留其它 platform/窗口，null≠0', async () => {
    await seedSite('risk-enf-on');
    const adapter = new FakeAdapter('sub2api');
    adapter.setPlatformQuotas('risk-enf-on', '5', [
      quota('anthropic', 100, null, 500),
      quota('openai', null, 0, null),
    ]);
    const { deps } = makeDeps(adapter, true);
    const service = new RiskService(deps);
    const change: QuotaChange = { platform: 'anthropic', window: 'daily', limitUsd: 20 };

    const res = await service.enforceQuota({ operatorId: 1, email: 'root@x.com', role: 'root' }, 'risk-enf-on', '5', change);
    // GET 与 PUT 都调过
    expect(adapter.calls.some((c) => c.startsWith('users.getPlatformQuotas'))).toBe(true);
    expect(adapter.calls.some((c) => c.startsWith('users.setPlatformQuotas'))).toBe(true);

    const anthropic = res.quotas.find((q) => q.platform === 'anthropic')!;
    const openai = res.quotas.find((q) => q.platform === 'openai')!;
    expect(anthropic.daily.limitUsd).toBe(20); // 改
    expect(anthropic.weekly.limitUsd).toBeNull(); // 保留不限
    expect(anthropic.monthly.limitUsd).toBe(500); // 保留
    expect(openai.daily.limitUsd).toBeNull(); // 未涉及 platform 保留
    expect(openai.weekly.limitUsd).toBe(0); // 禁用(0) 保留，未被误清为 null
    expect(openai.monthly.limitUsd).toBeNull();
  });

  it('writeRules 合并式：只覆盖传入字段，其余保留', async () => {
    const adapter = new FakeAdapter('sub2api');
    const { deps } = makeDeps(adapter);
    const service = new RiskService(deps);
    await service.writeRules({ spikeMultiplier: 5 });
    const r1 = await service.readRules();
    expect(r1).toMatchObject({ spikeMultiplier: 5, absFloorUsd: 10, baselineDays: 7 });
    await service.writeRules({ absFloorUsd: 25 });
    const r2 = await service.readRules();
    expect(r2).toMatchObject({ spikeMultiplier: 5, absFloorUsd: 25, baselineDays: 7 });
  });
});

// ---------------------------------------------------------------------------
// ⑥ /api/risk/* HTTP 门控
// ---------------------------------------------------------------------------

describe('/api/risk/* 权限门控', () => {
  it('非 root（operator）访问 → 403', async () => {
    const ts = await makeTestServer();
    try {
      const { cookie } = await ts.seedLogin({ email: 'op@x.com', password: 'pw-123456', role: 'operator' });
      const rules = await ts.app.inject({ method: 'GET', url: '/api/risk/rules', cookies: { rp_session: cookie } });
      expect(rules.statusCode).toBe(403);
      const scan = await ts.app.inject({ method: 'POST', url: '/api/risk/scan', cookies: { rp_session: cookie } });
      expect(scan.statusCode).toBe(403);
    } finally {
      await ts.close();
    }
  });

  it('root + RP_RISK_ENFORCE=off：GET rules enforce=false；enforce 端点 403 仅告警', async () => {
    const ts = await makeTestServer(); // 默认 riskEnforce=false
    try {
      const { operatorId, cookie } = await ts.seedLogin({ email: 'root@x.com', password: 'pw-123456', role: 'root' });
      await ts.db.orm.insert(sites).values({
        operatorId,
        slug: 'http-enf',
        label: 'HTTP',
        engine: 'sub2api',
        version: 'v1',
        hostPort: 19500,
        baseUrl: 'http://127.0.0.1:19501',
        status: 'active',
      });

      const rules = await ts.app.inject({ method: 'GET', url: '/api/risk/rules', cookies: { rp_session: cookie } });
      expect(rules.statusCode).toBe(200);
      expect(rules.json().enforce).toBe(false);

      const enf = await ts.app.inject({
        method: 'POST',
        url: '/api/risk/users/http-enf/5/enforce',
        cookies: { rp_session: cookie },
        payload: { platform: 'anthropic', window: 'daily', limitUsd: 20 },
      });
      expect(enf.statusCode).toBe(403);
      // off 时绝不触发写回
      expect(ts.adapters.sub2api.calls.some((c) => c.startsWith('users.setPlatformQuotas'))).toBe(false);
    } finally {
      await ts.close();
    }
  });

  it('root + RP_RISK_ENFORCE=on：enforce 写回成功', async () => {
    const ts = await makeTestServer({ config: { riskEnforce: true } });
    try {
      const { operatorId, cookie } = await ts.seedLogin({ email: 'root2@x.com', password: 'pw-123456', role: 'root' });
      await ts.db.orm.insert(sites).values({
        operatorId,
        slug: 'http-on',
        label: 'HTTP2',
        engine: 'sub2api',
        version: 'v1',
        hostPort: 19600,
        baseUrl: 'http://127.0.0.1:19601',
        status: 'active',
      });
      ts.adapters.sub2api.setPlatformQuotas('http-on', '5', [quota('anthropic', 100, null, 500)]);

      const enf = await ts.app.inject({
        method: 'POST',
        url: '/api/risk/users/http-on/5/enforce',
        cookies: { rp_session: cookie },
        payload: { platform: 'anthropic', window: 'daily', limitUsd: 20 },
      });
      expect(enf.statusCode).toBe(200);
      expect(enf.json().enforce).toBe(true);
      expect(ts.adapters.sub2api.calls.some((c) => c.startsWith('users.setPlatformQuotas'))).toBe(true);
    } finally {
      await ts.close();
    }
  });
});
