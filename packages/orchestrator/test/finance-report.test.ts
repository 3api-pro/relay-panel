import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import type { Db } from '../src/db/client.js';
import type { SmtpSettings } from '../src/config.js';
import { appSettings, sites } from '../src/db/schema.js';
import type { FinanceSiteUsage } from '../src/sites/service.js';
import { clearSiteCaches } from '../src/sites/service.js';
import { JobEngine } from '../src/jobs/engine.js';
import type { FinanceReportsDeps } from '../src/finance/scheduler.js';
import {
  resolveSummaryRows,
  summaryTotals,
  type FinanceSummaryRow,
} from '../src/finance/summary.js';
import {
  FINANCE_REPORT_SETTINGS_KEY,
  FINANCE_REPORT_STATE_KEY,
  dailyReportWindow,
  dueReports,
  evaluateThresholds,
  parseReportConfig,
  renderDailyReport,
  renderWeeklyReport,
  weeklyReportWindow,
} from '../src/finance/report.js';
import { startFinanceReports } from '../src/finance/scheduler.js';
import { ALERT_EMAIL_SETTINGS_KEY } from '../src/alerts/notify.js';
import { makeTestConfig, makeTestDb, makeTestServer, seedOperator, type TestServer } from './helpers.js';
import { FakeAdapter, FakeLifecycle, FakeNotifier } from './fakes.js';

/**
 * F2 日报/周报 + 毛利/成本预警单测：
 *  ① 报告构造（日报/周报 + 周报环比）
 *  ② 阈值判定（margin_low 毛利率偏低 / cost_spike 成本环比暴涨）
 *  ③ ok===false 降级站被剔除（不进阈值/合计）
 *  ④ dueReports + finance_report_state 幂等（重复 tick 只发一次、重启不重发）
 */

vi.setConfig({ testTimeout: 30_000 });

const FAKE_SMTP: SmtpSettings = {
  host: '127.0.0.1',
  port: 2525,
  from: 'reports@relay.example.com',
  secure: false,
};

/** 构造一条汇总行（默认 ok/engine 成本） */
function row(partial: Partial<FinanceSummaryRow> & { slug: string }): FinanceSummaryRow {
  return {
    label: partial.slug.toUpperCase(),
    ok: true,
    requests: 0,
    tokens: 0,
    revenue: 0,
    costRatio: null,
    costSource: 'engine',
    cost: 0,
    profit: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// ① 报告构造
// ---------------------------------------------------------------------------

describe('报告构造（renderDailyReport / renderWeeklyReport）', () => {
  const rows: FinanceSummaryRow[] = [
    row({ slug: 'a', label: '站A', requests: 100, tokens: 2000, revenue: 50, cost: 20, profit: 30 }),
    row({ slug: 'b', label: '站B', requests: 40, tokens: 800, revenue: 10, costRatio: 0.5, costSource: 'ratio', cost: 5, profit: 5 }),
  ];
  const totals = summaryTotals(rows, null);

  it('日报：主题含覆盖日，正文含各站营收/毛利率/合计 + USD 单位', () => {
    const r = renderDailyReport('2026-07-20', '2026-07-20', rows, totals);
    expect(r.subject).toContain('日报');
    expect(r.subject).toContain('2026-07-20');
    expect(r.text).toContain('站A');
    expect(r.text).toContain('站B');
    expect(r.text).toContain('USD');
    expect(r.text).toContain('营收合计');
    expect(r.text).toContain('毛利率');
    // 合计营收 60、成本 25、毛利 35
    expect(r.text).toContain('营收合计: 60.00 USD');
    expect(r.text).toContain('成本合计: 25.00 USD');
    expect(r.text).toContain('毛利合计: 35.00 USD');
  });

  it('周报：主题含区间，正文含环比上一周块（营收/成本/毛利各带百分比）', () => {
    const prevTotals = summaryTotals(
      [row({ slug: 'a', revenue: 40, cost: 25, profit: 15 })],
      null,
    );
    const r = renderWeeklyReport('2026-07-13', '2026-07-19', rows, totals, prevTotals);
    expect(r.subject).toContain('周报');
    expect(r.subject).toContain('2026-07-13');
    expect(r.subject).toContain('2026-07-19');
    expect(r.text).toContain('环比上一周');
    // 营收 60 vs 40 → +50.0%
    expect(r.text).toContain('+50.0%');
    expect(r.text).toContain('USD');
  });

  it('周报无 prevTotals 时不含环比块', () => {
    const r = renderWeeklyReport('2026-07-13', '2026-07-19', rows, totals);
    expect(r.text).not.toContain('环比上一周');
  });
});

// ---------------------------------------------------------------------------
// resolveSummaryRows / summaryTotals 口径
// ---------------------------------------------------------------------------

describe('口径抽取（resolveSummaryRows / summaryTotals）', () => {
  it('成本率覆盖 > 引擎账户成本 > null 三分支；合计只累加有成本口径的站', () => {
    const usage: FinanceSiteUsage[] = [
      { slug: 'eng', label: 'E', ok: true, requests: 10, tokens: 100, revenue: 100, accountCost: 40, costUnit: 'USD' },
      { slug: 'rat', label: 'R', ok: true, requests: 5, tokens: 50, revenue: 200, accountCost: null, costUnit: 'USD' },
      { slug: 'none', label: 'N', ok: true, requests: 1, tokens: 10, revenue: 10, accountCost: null, costUnit: 'USD' },
    ];
    const rows = resolveSummaryRows(usage, { rat: 0.5 });
    expect(rows[0]).toMatchObject({ cost: 40, costSource: 'engine', profit: 60 });
    expect(rows[1]).toMatchObject({ cost: 100, costSource: 'ratio', profit: 100 });
    expect(rows[2]).toMatchObject({ cost: null, costSource: null, profit: null });

    const totals = summaryTotals(rows, null);
    expect(totals.revenue).toBe(310); // 全部站
    expect(totals.cost).toBe(140); // 仅 eng+rat
    expect(totals.profit).toBe(160);
    expect(totals.recharge).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ② 阈值判定
// ---------------------------------------------------------------------------

describe('阈值判定（evaluateThresholds）', () => {
  it('margin_low 命中毛利率<阈值；cost_spike 命中环比>倍数', () => {
    const cur = [
      row({ slug: 'lowmargin', revenue: 100, cost: 90, profit: 10 }), // 毛利率 10%
      row({ slug: 'spike', revenue: 100, cost: 60, profit: 40 }), // 毛利率 40%
    ];
    const prev = [
      row({ slug: 'lowmargin', revenue: 100, cost: 85, profit: 15 }), // 90/85≈1.06× 不算暴涨
      row({ slug: 'spike', revenue: 80, cost: 20, profit: 60 }), // 60/20=3× 暴涨
    ];
    const hits = evaluateThresholds(cur, prev, { marginLowPct: 0.2, costSpikeFactor: 1.5 });
    expect(hits.marginLow.map((m) => m.slug)).toEqual(['lowmargin']);
    expect(hits.costSpike.map((c) => c.slug)).toEqual(['spike']);
    expect(hits.costSpike[0]!.factor).toBeCloseTo(3, 5);
  });

  it('无上期或上期成本<=0 不误报 cost_spike', () => {
    const cur = [row({ slug: 'x', revenue: 100, cost: 50, profit: 50 })];
    const prevZero = [row({ slug: 'x', revenue: 0, cost: 0, profit: 0 })];
    expect(evaluateThresholds(cur, prevZero, { marginLowPct: 0.2, costSpikeFactor: 1.5 }).costSpike).toHaveLength(0);
    expect(evaluateThresholds(cur, [], { marginLowPct: 0.2, costSpikeFactor: 1.5 }).costSpike).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 降级站剔除
// ---------------------------------------------------------------------------

describe('降级站剔除（ok===false 不进阈值/合计）', () => {
  it('降级站不触发阈值，也不计入合计', () => {
    const cur = [
      row({ slug: 'ok1', revenue: 100, cost: 90, profit: 10 }),
      { slug: 'down', label: '站Down', ok: false, requests: 0, tokens: 0, revenue: 0, costRatio: null, costSource: null, cost: null, profit: null } as FinanceSummaryRow,
    ];
    const prev = [row({ slug: 'ok1', revenue: 100, cost: 30, profit: 70 })];

    const hits = evaluateThresholds(cur, prev, { marginLowPct: 0.2, costSpikeFactor: 1.5 });
    expect(hits.marginLow.every((m) => m.slug !== 'down')).toBe(true);
    expect(hits.costSpike.every((c) => c.slug !== 'down')).toBe(true);
    expect(hits.marginLow.map((m) => m.slug)).toEqual(['ok1']); // ok1 毛利率10%<20%

    const totals = summaryTotals(cur.filter((r) => r.ok !== false), null);
    expect(totals.revenue).toBe(100); // 不含降级站
    expect(totals.cost).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// ④a dueReports 幂等 + 自愈（纯函数）
// ---------------------------------------------------------------------------

describe('应发档判定（dueReports）', () => {
  // 北京 2026-07-20 12:00 = UTC 04:00（12>=sendHour9 → 覆盖昨日 2026-07-19）
  const nowMs = Date.UTC(2026, 6, 20, 4);

  it('日报：达 sendHour 覆盖昨日；state 记录目标日后不再应发', () => {
    const cfg = { daily: true, weekly: false, sendHour: 9 };
    const target = dailyReportWindow(nowMs, 9).target;
    expect(target).toBe('2026-07-19');
    expect(dueReports(nowMs, {}, cfg)).toEqual(['daily']);
    expect(dueReports(nowMs, { daily: target }, cfg)).toEqual([]);
  });

  it('日报：未达 sendHour 覆盖前日（补发上一应发窗口）', () => {
    // 北京 2026-07-20 06:00 = UTC 2026-07-19 22:00（6<9 → 覆盖前日 2026-07-18）
    const early = Date.UTC(2026, 6, 19, 22);
    expect(dailyReportWindow(early, 9).target).toBe('2026-07-18');
    expect(dueReports(early, {}, { daily: true, weekly: false, sendHour: 9 })).toEqual(['daily']);
  });

  it('周报：目标周键稳定（YYYY-Www），state 记录后不再应发', () => {
    const cfg = { daily: false, weekly: true, sendHour: 9 };
    const win = weeklyReportWindow(nowMs, 9);
    expect(win.targetKey).toMatch(/^\d{4}-W\d{2}$/);
    // from 为周一、to 为其后 6 天（周日）
    expect(win.from < win.to).toBe(true);
    expect(dueReports(nowMs, {}, cfg)).toEqual(['weekly']);
    expect(dueReports(nowMs, { weekly: win.targetKey }, cfg)).toEqual([]);
  });

  it('master 开关关闭时不应发', () => {
    expect(dueReports(nowMs, {}, { daily: false, weekly: false, sendHour: 9 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ④b scheduler tick 幂等（发送标记 + 重启不重发）
// ---------------------------------------------------------------------------

describe('scheduler 幂等（startFinanceReports.tick）', () => {
  let db: Db;

  beforeAll(async () => {
    db = await makeTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  beforeEach(() => {
    clearSiteCaches();
    vi.restoreAllMocks();
  });

  async function seedSite(slug: string): Promise<FakeAdapter> {
    const opId = await seedOperator(db, { role: 'root' });
    await db.orm.insert(sites).values({
      operatorId: opId,
      slug,
      label: slug,
      engine: 'sub2api',
      version: 'v1.0.0',
      hostPort: 18800 + Math.floor(Math.random() * 100),
      baseUrl: 'http://127.0.0.1:18801',
      status: 'active',
    });
    const adapter = new FakeAdapter('sub2api');
    adapter.stateFor(slug).usage = {
      requests: 100,
      promptTokens: 1000,
      completionTokens: 1000,
      cost: 50,
      costUnit: 'USD',
    };
    return adapter;
  }

  function makeDeps(adapter: FakeAdapter, send: ReturnType<typeof vi.fn>): FinanceReportsDeps {
    return {
      config: makeTestConfig({}),
      db,
      adapters: { sub2api: adapter, newapi: new FakeAdapter('newapi') } as unknown as Record<EngineKind, EngineAdapter>,
      lifecycles: {
        sub2api: new FakeLifecycle('sub2api'),
        newapi: new FakeLifecycle('newapi'),
      } as unknown as Record<EngineKind, EngineLifecycle>,
      jobs: new JobEngine(db),
      notifier: new FakeNotifier(),
      smtp: FAKE_SMTP,
      send,
      // sendHour=0 → 日报当日恒应发（hour>=0），去除挂钟不确定性
      sendHour: 0,
    };
  }

  it('同一区间重复 tick 只发一次；写发送标记；重启后 state 已记不重发', async () => {
    const adapter = await seedSite('report-site-1');
    // 只开日报，关周报，隔离
    await db.orm
      .insert(appSettings)
      .values({ key: FINANCE_REPORT_SETTINGS_KEY, value: { recipients: ['ops@example.com'], daily: true, weekly: false } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { recipients: ['ops@example.com'], daily: true, weekly: false } } });

    const send = vi.fn(async () => undefined);
    const sched = startFinanceReports(makeDeps(adapter, send), 0);

    await sched.tick();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![1] as { to: string; subject: string; text: string };
    expect(msg.to).toBe('ops@example.com');
    expect(msg.subject).toContain('日报');
    expect(msg.text).toContain('USD');

    // 发送标记已写（daily=覆盖日）
    const stateRow = (
      await db.orm.select().from(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY))
    )[0]!;
    const expectedTarget = dailyReportWindow(Date.now(), 0).target;
    expect((stateRow.value as { daily?: string }).daily).toBe(expectedTarget);

    // 第二轮：已记不重发
    await sched.tick();
    expect(send).toHaveBeenCalledTimes(1);

    // 重启（新实例）：读到持久化 state → 不重发
    const send2 = vi.fn(async () => undefined);
    const sched2 = startFinanceReports(makeDeps(adapter, send2), 0);
    await sched2.tick();
    expect(send2).not.toHaveBeenCalled();
  });

  it('未配 SMTP（smtp=null）静默跳过发信，但仍写发送标记', async () => {
    const adapter = await seedSite('report-site-2');
    await db.orm
      .insert(appSettings)
      .values({ key: FINANCE_REPORT_SETTINGS_KEY, value: { recipients: ['x@example.com'], daily: true, weekly: false } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { recipients: ['x@example.com'], daily: true, weekly: false } } });
    // 清掉上一用例可能留下的 state
    await db.orm.delete(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY));

    const send = vi.fn(async () => undefined);
    const deps = makeDeps(adapter, send);
    deps.smtp = null;
    const sched = startFinanceReports(deps, 0);

    await sched.tick();
    expect(send).not.toHaveBeenCalled();
    const stateRow = (
      await db.orm.select().from(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY))
    )[0]!;
    expect((stateRow.value as { daily?: string }).daily).toBe(dailyReportWindow(Date.now(), 0).target);
  });
});

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

describe('parseReportConfig 容错回落默认', () => {
  it('非法/缺省字段回落默认', () => {
    expect(parseReportConfig(undefined)).toMatchObject({ recipients: [], daily: true, weekly: true });
    expect(parseReportConfig({ recipients: ['a@b.c', '', 123], marginLowPct: 2, costSpikeFactor: 0.5, daily: false })).toMatchObject({
      recipients: ['a@b.c'], // 剔除空串/非串
      marginLowPct: 0.2, // 2 越界回落默认
      costSpikeFactor: 1.5, // 0.5<1 回落默认
      daily: false,
      weekly: true,
    });
  });
});

// ---------------------------------------------------------------------------
// ⑤ 立即发送测试报告端点 POST /api/finance/report/test（root 一键验证）
// ---------------------------------------------------------------------------

describe('测试报告端点 POST /api/finance/report/test', () => {
  let ts: TestServer;
  let send: ReturnType<typeof vi.fn>;
  let rootCookie: string;
  let opCookie: string;

  beforeAll(async () => {
    send = vi.fn(async () => undefined);
    // 注入 SMTP 发信替身 + 配好 smtp（config.smtp 非空），使发信路径可断言
    ts = await makeTestServer({ config: { smtp: FAKE_SMTP }, smtpSend: send });
    rootCookie = (await ts.seedLogin({ email: 'rep-root@example.com', password: 'pw-12345678', role: 'root' })).cookie;
    opCookie = (await ts.seedLogin({ email: 'rep-op@example.com', password: 'pw-12345678', role: 'operator' })).cookie;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  beforeEach(async () => {
    send.mockClear();
    // 隔离：清掉报告配置 / 发送标记 / 告警邮箱
    await ts.db.orm.delete(appSettings).where(eq(appSettings.key, FINANCE_REPORT_SETTINGS_KEY));
    await ts.db.orm.delete(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY));
    await ts.db.orm.delete(appSettings).where(eq(appSettings.key, ALERT_EMAIL_SETTINGS_KEY));
  });

  async function setReportConfig(value: Record<string, unknown>): Promise<void> {
    await ts.db.orm
      .insert(appSettings)
      .values({ key: FINANCE_REPORT_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  }

  async function stateRows(): Promise<unknown[]> {
    return ts.db.orm.select().from(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY));
  }

  it('未登录 → 401；operator（非 root）→ 403，均不发信', async () => {
    const anon = await ts.app.inject({ method: 'POST', url: '/api/finance/report/test' });
    expect(anon.statusCode).toBe(401);
    const asOp = await ts.app.inject({
      method: 'POST',
      url: '/api/finance/report/test',
      cookies: { rp_session: opCookie },
    });
    expect(asOp.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('无收件人 + 无告警邮箱 → 400，不发信、不写发送标记', async () => {
    await setReportConfig({ recipients: [], daily: true, weekly: true });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/finance/report/test',
      cookies: { rp_session: rootCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(await stateRows()).toHaveLength(0);
  });

  it('有收件人 → 逐个 RCPT 调发信替身，返回 sent/recipients/preview，且绝不写 finance_report_state', async () => {
    await setReportConfig({ recipients: ['ops@example.com', 'fin@example.com'], daily: true, weekly: true });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/finance/report/test',
      cookies: { rp_session: rootCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sent: boolean; recipients: number; preview: string };
    expect(body.sent).toBe(true);
    expect(body.recipients).toBe(2);
    expect(body.preview).toContain('经营日报'); // 日报正文首行
    // 逐个收件人各一封
    expect(send).toHaveBeenCalledTimes(2);
    const tos = send.mock.calls.map((c) => (c[1] as { to: string }).to);
    expect(tos).toEqual(['ops@example.com', 'fin@example.com']);
    expect((send.mock.calls[0]![1] as { subject: string }).subject).toContain('日报');
    // 🔴 不占用当日发送标记（允许反复测试）
    expect(await stateRows()).toHaveLength(0);
    // 反复测试仍不写标记
    await ts.app.inject({ method: 'POST', url: '/api/finance/report/test', cookies: { rp_session: rootCookie } });
    expect(await stateRows()).toHaveLength(0);
  });

  it('无收件人但配置了告警邮箱 → 回落发到告警邮箱', async () => {
    await setReportConfig({ recipients: [], daily: true, weekly: true });
    await ts.db.orm
      .insert(appSettings)
      .values({ key: ALERT_EMAIL_SETTINGS_KEY, value: { email: 'oncall@example.com' } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { email: 'oncall@example.com' } } });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/finance/report/test',
      cookies: { rp_session: rootCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { recipients: number }).recipients).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![1] as { to: string }).to).toBe('oncall@example.com');
  });
});

describe('测试报告端点：未配 SMTP → 400', () => {
  it('config.smtp 未配 + 有收件人 → 400，不构造发信', async () => {
    const ts = await makeTestServer({}); // 不注入 smtp/smtpSend
    try {
      const cookie = (await ts.seedLogin({ email: 'nosmtp-root@example.com', password: 'pw-12345678', role: 'root' })).cookie;
      await ts.db.orm
        .insert(appSettings)
        .values({ key: FINANCE_REPORT_SETTINGS_KEY, value: { recipients: ['x@example.com'], daily: true, weekly: true } });
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/finance/report/test',
        cookies: { rp_session: cookie },
      });
      expect(res.statusCode).toBe(400);
      // 未写任何发送标记
      const st = await ts.db.orm.select().from(appSettings).where(eq(appSettings.key, FINANCE_REPORT_STATE_KEY));
      expect(st).toHaveLength(0);
    } finally {
      await ts.close();
    }
  }, 60_000);
});
