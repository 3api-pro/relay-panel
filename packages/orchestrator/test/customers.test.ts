import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  CredentialStore,
  EngineAdapter,
  EngineKind,
  InstanceInfo,
  SiteCustomerRecord,
} from '@relay-panel/adapter-core';
import type { Db } from '../src/db/client.js';
import { customerSnapshots, sites } from '../src/db/schema.js';
import {
  DEFAULT_CRM_CONFIG,
  churnAssess,
  collectLiveCustomers,
  detectDrop,
  parseCrmConfig,
  tierOf,
  type CrmConfig,
  type CrmDeps,
  type SnapshotPoint,
} from '../src/customers/service.js';
import { runCustomerSnapshotOnce } from '../src/customers/snapshot.js';
import { makeTestConfig, makeTestDb, makeTestServer, seedOperator } from './helpers.js';
import { FakeAdapter, FakeNotifier } from './fakes.js';

/**
 * F4 客户 CRM 单测：
 *  ① tierOf：大/中/小 R 门槛边界
 *  ② detectDrop：相邻快照差值算每日消耗 + 骤降阈值 + 冷启动 minSnapshotDays 不出信号(enoughHistory=false)
 *  ③ churnAssess：无活跃 N 天 与 骤降 两条各自触发；活跃且无骤降不触发
 *  ④ collectLiveCustomers：跨站不合并（同 email 两站→两行 key=site:userId，负债不合并）；
 *     admin 剔除；ok=false 降级站（不可达 / 无 listAll）从聚合剔除
 *  ⑤ snapshot upsert 同日二次幂等（唯一键不新增行、只更 period_cost）；churn 告警默认关闭→零告警
 *  ⑥ /api/customers* 非 root → 403
 */

// makeTestServer + 全量迁移较慢，放宽超时（同 risk.test.ts）
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// ① tierOf
// ---------------------------------------------------------------------------

describe('tierOf 分层门槛', () => {
  const cfg: CrmConfig = { ...DEFAULT_CRM_CONFIG, tierBigUsd: 100, tierMidUsd: 20 };
  it('≥big=big；≥mid=mid；否则 small（边界含等号）', () => {
    expect(tierOf(150, cfg)).toBe('big');
    expect(tierOf(100, cfg)).toBe('big');
    expect(tierOf(99.99, cfg)).toBe('mid');
    expect(tierOf(20, cfg)).toBe('mid');
    expect(tierOf(19.99, cfg)).toBe('small');
    expect(tierOf(0, cfg)).toBe('small');
  });
});

// ---------------------------------------------------------------------------
// ② detectDrop
// ---------------------------------------------------------------------------

function snaps(costs: number[]): SnapshotPoint[] {
  // captured_date 仅排序用，此处升序造串（真实相邻差由 periodCost 决定）
  return costs.map((c, i) => ({ capturedDate: `2026-07-${String(i + 1).padStart(2, '0')}`, periodCost: c }));
}

describe('detectDrop 骤降（相邻 period_cost 差值算日消耗）', () => {
  const cfg: CrmConfig = { ...DEFAULT_CRM_CONFIG, dropWindowDays: 2, minSnapshotDays: 3, dropThresholdPct: 0.6 };

  it('前窗口日均10、近窗口日均1 → 降幅0.9≥阈值判骤降，历史充足', () => {
    // 累计净消耗：0→10→20（前每日10），21→22（近每日1）
    const drop = detectDrop(snaps([0, 10, 20, 21, 22]), cfg);
    expect(drop.enoughHistory).toBe(true);
    expect(drop.dailySpendPrior).toBeCloseTo(10, 5);
    expect(drop.dailySpendRecent).toBeCloseTo(1, 5);
    expect(drop.dropPct).toBeCloseTo(0.9, 5);
    expect(drop.dropFlag).toBe(true);
  });

  it('消费平稳（每日10）→ 不判骤降', () => {
    const drop = detectDrop(snaps([0, 10, 20, 30, 40]), cfg);
    expect(drop.enoughHistory).toBe(true);
    expect(drop.dropPct).toBeCloseTo(0, 5);
    expect(drop.dropFlag).toBe(false);
  });

  it('冷启动：快照数 < minSnapshotDays → enoughHistory=false 不出骤降信号', () => {
    const drop = detectDrop(snaps([0, 10]), cfg); // 2 个快照 < minSnapshotDays(3)
    expect(drop.enoughHistory).toBe(false);
    expect(drop.dropFlag).toBe(false);
  });

  it('单个快照（无相邻差）→ 空结果、enoughHistory=false', () => {
    const drop = detectDrop(snaps([5]), cfg);
    expect(drop.enoughHistory).toBe(false);
    expect(drop.dropFlag).toBe(false);
    expect(drop.dailySpendRecent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ③ churnAssess
// ---------------------------------------------------------------------------

describe('churnAssess 流失判定', () => {
  const cfg: CrmConfig = { ...DEFAULT_CRM_CONFIG, churnInactiveDays: 14, dropWindowDays: 2, minSnapshotDays: 3, dropThresholdPct: 0.6 };
  const now = Date.parse('2026-07-21T00:00:00Z');
  const noDrop = detectDrop(snaps([0, 10, 20, 30, 40]), cfg); // 平稳
  const bigDrop = detectDrop(snaps([0, 10, 20, 21, 22]), cfg); // 骤降

  it('无活跃 ≥ N 天单独触发（取 lastActiveAt/lastUsedAt 较晚者）', () => {
    const row = { lastActiveAt: '2026-07-01T00:00:00Z', lastUsedAt: '2026-07-05T00:00:00Z' }; // 16 天前(取 07-05)
    const r = churnAssess(row, noDrop, cfg, now);
    expect(r.churnRisk).toBe(true);
    expect(r.reasons).toContain('inactive');
    expect(r.reasons).not.toContain('spend_drop');
  });

  it('近期活跃 + 无骤降 → 不判流失', () => {
    const row = { lastActiveAt: '2026-07-20T00:00:00Z', lastUsedAt: '2026-07-20T00:00:00Z' };
    const r = churnAssess(row, noDrop, cfg, now);
    expect(r.churnRisk).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it('骤降单独触发（活跃但消费骤降）', () => {
    const row = { lastActiveAt: '2026-07-20T00:00:00Z' };
    const r = churnAssess(row, bigDrop, cfg, now);
    expect(r.churnRisk).toBe(true);
    expect(r.reasons).toContain('spend_drop');
    expect(r.reasons).not.toContain('inactive');
  });

  it('活跃时间双源皆缺 → 不误报无活跃', () => {
    const r = churnAssess({}, noDrop, cfg, now);
    expect(r.reasons).not.toContain('inactive');
  });
});

// ---------------------------------------------------------------------------
// parseCrmConfig 容错
// ---------------------------------------------------------------------------

describe('parseCrmConfig 越界/缺省回落默认', () => {
  it('undefined → 默认', () => {
    expect(parseCrmConfig(undefined)).toEqual(DEFAULT_CRM_CONFIG);
  });
  it('越界字段各自回落；大R<中R 时抬到中R', () => {
    const c = parseCrmConfig({ tierBigUsd: 5, tierMidUsd: 20, dropThresholdPct: 2, churnAlertsEnabled: true });
    expect(c.tierMidUsd).toBe(20);
    expect(c.tierBigUsd).toBe(20); // 5 < 20 → 抬到 20
    expect(c.dropThresholdPct).toBe(DEFAULT_CRM_CONFIG.dropThresholdPct); // 2 越界回落
    expect(c.churnAlertsEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④⑤ collectLiveCustomers / snapshot（真 pglite 库）
// ---------------------------------------------------------------------------

function cust(userId: number, email: string, extra: Partial<SiteCustomerRecord> = {}): SiteCustomerRecord {
  return { userId, email, role: 'user', status: 'active', balance: 30, totalRecharged: 50, frozenBalance: 0, ...extra };
}

/** 极简 newapi adapter：connect 成功但 client.users 无 listAll（模拟不支持全量客户拉取的引擎） */
function makeNoListAllAdapter(): EngineAdapter {
  const base = new FakeAdapter('newapi');
  const origConnect = base.connect.bind(base);
  base.connect = async (inst: InstanceInfo, cred: CredentialStore) => {
    const client = await origConnect(inst, cred);
    const users = { ...client.users };
    delete (users as { listAll?: unknown }).listAll;
    return { ...client, users };
  };
  return base;
}

describe('collectLiveCustomers / snapshot', () => {
  let db: Db;

  beforeAll(async () => {
    db = await makeTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  let siteSeq = 0;
  async function seedSite(slug: string, engine: EngineKind = 'sub2api'): Promise<void> {
    const opId = await seedOperator(db, { role: 'root' });
    siteSeq += 1;
    await db.orm.insert(sites).values({
      operatorId: opId,
      slug,
      label: slug.toUpperCase(),
      engine,
      version: 'v1.0.0',
      hostPort: 19700 + siteSeq,
      baseUrl: 'http://127.0.0.1:19701',
      status: 'active',
    });
  }

  function makeDeps(sub: FakeAdapter, newapi: EngineAdapter): CrmDeps {
    return {
      config: makeTestConfig(),
      db,
      adapters: { sub2api: sub, newapi } as unknown as Record<EngineKind, EngineAdapter>,
    };
  }

  it('跨站不合并：同 email 两站→两行 key=site:userId，负债重复计；admin 剔除', async () => {
    await seedSite('crm-a');
    await seedSite('crm-b');
    const sub = new FakeAdapter('sub2api');
    // 同一 email、同 userId 在两站各一条；A 站另含一个 admin（应剔除）
    sub.setCustomers('crm-a', [cust(1, 'dup@x.com', { balance: 30 }), cust(9, 'root@x.com', { role: 'admin' })]);
    sub.setCustomers('crm-b', [cust(1, 'dup@x.com', { balance: 30 })]);

    const res = await collectLiveCustomers(makeDeps(sub, new FakeAdapter('newapi')));
    const keys = res.customers.map((c) => c.key).sort();
    expect(keys).toEqual(['crm-a:1', 'crm-b:1']); // 两行，不合并；admin 未入列
    // 负债重复计：两行各 30 → 合计 60
    expect(res.customers.reduce((s, c) => s + (c.balance ?? 0), 0)).toBe(60);
  });

  it('ok=false 降级站从聚合剔除：不可达站 + 无 listAll(newapi) 均入 degradedSites', async () => {
    await seedSite('crm-live');
    await seedSite('crm-down');
    await seedSite('crm-newapi', 'newapi');
    const sub = new FakeAdapter('sub2api');
    sub.setCustomers('crm-live', [cust(1, 'a@x.com')]);
    sub.setUnreachable('crm-down'); // connect 抛错 → unreachable

    const res = await collectLiveCustomers(makeDeps(sub, makeNoListAllAdapter()));
    // 只有 crm-live 的客户入聚合
    expect(res.customers.map((c) => c.siteSlug)).toEqual(['crm-live']);
    const degraded = res.degradedSites.reduce<Record<string, string>>((m, d) => ((m[d.siteSlug] = d.reason), m), {});
    expect(degraded['crm-down']).toBe('unreachable');
    expect(degraded['crm-newapi']).toBe('unsupported');
  });

  it('snapshot upsert 同日二次幂等：唯一键不新增行、只更 period_cost', async () => {
    await seedSite('crm-snap');
    const sub = new FakeAdapter('sub2api');
    const notifier = new FakeNotifier();
    const deps = { ...makeDeps(sub, new FakeAdapter('newapi')), notifier };

    // 首轮：balance 30, total 50 → period_cost = 50-30-0 = 20
    sub.setCustomers('crm-snap', [cust(1, 'snap@x.com', { balance: 30, totalRecharged: 50 })]);
    await runCustomerSnapshotOnce(deps);

    // 次轮：同日再采集，balance 变 10 → period_cost = 50-10-0 = 40
    sub.setCustomers('crm-snap', [cust(1, 'snap@x.com', { balance: 10, totalRecharged: 50 })]);
    await runCustomerSnapshotOnce(deps);

    const rows = await db.orm
      .select()
      .from(customerSnapshots)
      .where(and(eq(customerSnapshots.siteSlug, 'crm-snap'), eq(customerSnapshots.userId, 1)));
    // 同站同人同北京日历日只一行（唯一键去重）
    expect(rows).toHaveLength(1);
    // period_cost 更新为最新一轮
    expect(rows[0]!.periodCost).toBeCloseTo(40, 5);
    // churn 告警默认关闭 → 零告警
    expect(notifier.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ⑥ /api/customers* 权限门控
// ---------------------------------------------------------------------------

describe('/api/customers* 权限门控', () => {
  it('非 root（operator）访问 → 403', async () => {
    const ts = await makeTestServer();
    try {
      const { cookie } = await ts.seedLogin({ email: 'op@x.com', password: 'pw-123456', role: 'operator' });
      const list = await ts.app.inject({ method: 'GET', url: '/api/customers', cookies: { rp_session: cookie } });
      expect(list.statusCode).toBe(403);
      const cfg = await ts.app.inject({ method: 'GET', url: '/api/customers/config', cookies: { rp_session: cookie } });
      expect(cfg.statusCode).toBe(403);
    } finally {
      await ts.close();
    }
  });

  it('root：GET /api/customers 返回结构（空站→空行 + 冷启动天数 0）', async () => {
    const ts = await makeTestServer();
    try {
      const { cookie } = await ts.seedLogin({ email: 'root@x.com', password: 'pw-123456', role: 'root' });
      const res = await ts.app.inject({ method: 'GET', url: '/api/customers', cookies: { rp_session: cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.costUnit).toBe('USD');
      expect(body.snapshotDaysAvailable).toBe(0);
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.config.tierBigUsd).toBe(DEFAULT_CRM_CONFIG.tierBigUsd);
    } finally {
      await ts.close();
    }
  });
});
