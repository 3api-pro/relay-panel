import { describe, expect, it, vi } from 'vitest';
import { sites } from '../src/db/schema.js';
import type { SiteChannelBalanceRow } from '../src/sites/service.js';
import {
  buildBalanceOverview,
  classifyRemaining,
  computeDaysLeft,
  evaluateChannelLowBalance,
  isHttpUrl,
  parseRechargeLinks,
  type BalanceLike,
} from '../src/upstream/service.js';
import { makeTestServer } from './helpers.js';

/**
 * F5 上游余额 + 低余额预警 + 快捷充值（只读）单测：
 *  ① quota 有值路：classifyRemaining=limit-used、computeDaysLeft=remaining/avgDaily、buildBalanceOverview coverage='exact' + 低余额红标
 *  ② 零覆盖路：window/none kind、daysLeft=null、coverage 计数正确、断言【绝不产出余额数字】（remaining/daysLeft 不出现）
 *  ③ 低余额阈值：evaluateChannelLowBalance 仅 quota 命中，window/none 永不命中，阈值<=0 不命中
 *  ④ 充值外链读写：GET 往返数组、PUT 拒非 http(s) url、非 root 403、balances 非 root 403
 *  ⑤ e2e：root 拉 balances 分类 + 降级站 marker（listSiteChannelBalances + route 装配）
 * makeTestServer + scrypt 登录较慢，放宽超时（同 risk.test.ts）。
 */
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// 行构造辅助
// ---------------------------------------------------------------------------

function row(partial: Partial<SiteChannelBalanceRow> & { kind: SiteChannelBalanceRow['kind'] }): SiteChannelBalanceRow {
  return {
    siteSlug: 'site-a',
    siteLabel: 'Site A',
    siteOk: true,
    id: partial.id ?? '1',
    name: partial.name ?? 'ch',
    accountType: partial.accountType ?? 'apikey',
    enabled: partial.enabled ?? true,
    kind: partial.kind,
    ...(partial.quotaLimit !== undefined ? { quotaLimit: partial.quotaLimit } : {}),
    ...(partial.quotaUsed !== undefined ? { quotaUsed: partial.quotaUsed } : {}),
    ...(partial.windowCostLimit !== undefined ? { windowCostLimit: partial.windowCostLimit } : {}),
    ...(partial.avgDailyCost !== undefined ? { avgDailyCost: partial.avgDailyCost } : {}),
    ...(partial.siteSlug !== undefined ? { siteSlug: partial.siteSlug } : {}),
    ...(partial.siteLabel !== undefined ? { siteLabel: partial.siteLabel } : {}),
    ...(partial.siteOk !== undefined ? { siteOk: partial.siteOk } : {}),
  };
}

// ---------------------------------------------------------------------------
// ① classifyRemaining / computeDaysLeft（纯函数）
// ---------------------------------------------------------------------------

describe('classifyRemaining / computeDaysLeft', () => {
  it('quota：remaining=limit-used；window/none 恒 null（绝不给余额数）', () => {
    expect(classifyRemaining({ kind: 'quota', quotaLimit: 100, quotaUsed: 30 })).toBe(70);
    expect(classifyRemaining({ kind: 'quota', quotaLimit: 100 })).toBe(100); // used 缺省 0
    expect(classifyRemaining({ kind: 'window', windowCostLimit: 50 } as BalanceLike)).toBeNull();
    expect(classifyRemaining({ kind: 'none' })).toBeNull();
  });

  it('computeDaysLeft：quota 且 avgDaily>0 才算；否则 null（号池不编造撑几天）', () => {
    expect(computeDaysLeft(50, 5)).toBe(10); // 50/5
    expect(computeDaysLeft(50, 0)).toBeNull(); // avgDaily 0
    expect(computeDaysLeft(50, undefined)).toBeNull(); // 无 avgDaily
    expect(computeDaysLeft(null, 5)).toBeNull(); // window/none remaining=null → 恒 null
  });
});

// ---------------------------------------------------------------------------
// ③ evaluateChannelLowBalance（纯函数）
// ---------------------------------------------------------------------------

describe('evaluateChannelLowBalance', () => {
  const rows: BalanceLike[] = [
    { kind: 'quota', quotaLimit: 100, quotaUsed: 95 }, // remaining 5
    { kind: 'quota', quotaLimit: 100, quotaUsed: 10 }, // remaining 90
    { kind: 'window', windowCostLimit: 1 } as BalanceLike, // 永不命中
    { kind: 'none' }, // 永不命中
  ];

  it('仅 quota 且 remaining<阈值命中；window/none 永不命中', () => {
    const hit = evaluateChannelLowBalance(rows, 10);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ kind: 'quota', quotaUsed: 95 });
  });

  it('阈值 <=0 一律不命中（>0 才启用）', () => {
    expect(evaluateChannelLowBalance(rows, 0)).toHaveLength(0);
    expect(evaluateChannelLowBalance(rows, -5)).toHaveLength(0);
  });

  it('window/none 即便 windowCostLimit 很小也不误报', () => {
    const onlyEstimate: BalanceLike[] = [
      { kind: 'window', windowCostLimit: 0.01 } as BalanceLike,
      { kind: 'none' },
    ];
    expect(evaluateChannelLowBalance(onlyEstimate, 100)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ①② buildBalanceOverview（装配 + coverage + 不编造余额）
// ---------------------------------------------------------------------------

describe('buildBalanceOverview', () => {
  it('quota 有值路：coverage exact + remaining + daysLeft + 低余额红标', () => {
    const rows = [row({ id: '1', kind: 'quota', quotaLimit: 100, quotaUsed: 95, avgDailyCost: 5 })];
    const ov = buildBalanceOverview(rows, 10);
    expect(ov.coverage).toEqual({ withQuota: 1, windowOnly: 0, zeroCoverage: 0, degradedSites: 0 });
    const v = ov.rows[0]!;
    expect(v.coverage).toBe('exact');
    expect(v.remaining).toBe(5);
    expect(v.daysLeft).toBeCloseTo(1, 5); // 5 / 5
    expect(v.low).toBe(true); // remaining 5 < 10
  });

  it('零覆盖/窗口路：kind window|none、daysLeft=null、coverage 计数正确、绝不产出余额数字', () => {
    const rows = [
      row({ id: '2', kind: 'window', accountType: 'oauth', windowCostLimit: 50, avgDailyCost: 8 }),
      row({ id: '3', kind: 'none', accountType: 'apikey', avgDailyCost: 2 }),
    ];
    const ov = buildBalanceOverview(rows, 10);
    expect(ov.coverage).toEqual({ withQuota: 0, windowOnly: 1, zeroCoverage: 1, degradedSites: 0 });

    const win = ov.rows.find((r) => r.kind === 'window')!;
    expect(win.coverage).toBe('estimate');
    expect(win.daysLeft).toBeNull();
    // 🔴 绝不产出余额数字
    expect(win.remaining).toBeUndefined();
    expect(win.quotaLimit).toBeUndefined();
    expect(win.low).toBe(false);
    expect(win.windowCostLimit).toBe(50); // 仅窗口闸(非余额)
    expect(win.avgDailyCost).toBe(8);

    const none = ov.rows.find((r) => r.kind === 'none')!;
    expect(none.coverage).toBe('none');
    expect(none.daysLeft).toBeNull();
    expect(none.remaining).toBeUndefined();
    expect(none.windowCostLimit).toBeUndefined();
    expect(none.low).toBe(false);
  });

  it('quota 无 avgDailyCost：remaining 有但 daysLeft=null（不编造撑几天）', () => {
    const rows = [row({ id: '1', kind: 'quota', quotaLimit: 100, quotaUsed: 40 })];
    const ov = buildBalanceOverview(rows, 0);
    expect(ov.rows[0]!.remaining).toBe(60);
    expect(ov.rows[0]!.daysLeft).toBeNull();
    expect(ov.rows[0]!.low).toBe(false); // 阈值 0 → 不标低
  });

  it('降级 marker 行（siteOk=false）计入 degradedSites，不计入其它覆盖度', () => {
    const rows: SiteChannelBalanceRow[] = [
      row({ id: '1', kind: 'quota', quotaLimit: 100, quotaUsed: 10 }),
      { siteSlug: 'down', siteLabel: 'Down', siteOk: false, id: '', name: '', accountType: '', enabled: false, kind: 'none' },
    ];
    const ov = buildBalanceOverview(rows, 0);
    expect(ov.coverage).toEqual({ withQuota: 1, windowOnly: 0, zeroCoverage: 0, degradedSites: 1 });
    const marker = ov.rows.find((r) => !r.siteOk)!;
    expect(marker.coverage).toBe('none');
    expect(marker.daysLeft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ④ 充值外链解析 / URL 校验（纯函数）
// ---------------------------------------------------------------------------

describe('parseRechargeLinks / isHttpUrl', () => {
  it('isHttpUrl 只认 http/https', () => {
    expect(isHttpUrl('https://a.com/recharge')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('ftp://a.com')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('parseRechargeLinks 兼容 {links:[...]} 与裸数组，丢弃 label 空/非 http 项', () => {
    const raw = {
      links: [
        { label: 'A', url: 'https://a.com', note: 'n1' },
        { label: '', url: 'https://b.com' }, // label 空 → 丢
        { label: 'C', url: 'javascript:1' }, // 非 http → 丢
        { label: 'D', url: 'http://d.com' },
      ],
    };
    const out = parseRechargeLinks(raw);
    expect(out).toEqual([
      { label: 'A', url: 'https://a.com', note: 'n1' },
      { label: 'D', url: 'http://d.com' },
    ]);
    // 裸数组也接受
    expect(parseRechargeLinks([{ label: 'X', url: 'https://x.com' }])).toHaveLength(1);
    // 非法输入回落空
    expect(parseRechargeLinks(null)).toEqual([]);
    expect(parseRechargeLinks('nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ④⑤ HTTP：权限门控 + 充值外链往返 + balances 分类 e2e
// ---------------------------------------------------------------------------

describe('/api/upstream/* HTTP', () => {
  it('非 root（operator）访问 balances / recharge-links → 403', async () => {
    const ts = await makeTestServer();
    try {
      const { cookie } = await ts.seedLogin({ email: 'op@x.com', password: 'pw-123456', role: 'operator' });
      const bal = await ts.app.inject({ method: 'GET', url: '/api/upstream/balances', cookies: { rp_session: cookie } });
      expect(bal.statusCode).toBe(403);
      const links = await ts.app.inject({ method: 'GET', url: '/api/upstream/recharge-links', cookies: { rp_session: cookie } });
      expect(links.statusCode).toBe(403);
    } finally {
      await ts.close();
    }
  });

  it('充值外链 PUT 往返 + GET 读回；拒非 http(s) url（400）', async () => {
    const ts = await makeTestServer();
    try {
      const { cookie } = await ts.seedLogin({ email: 'root@x.com', password: 'pw-123456', role: 'root' });

      // 初始空
      const g0 = await ts.app.inject({ method: 'GET', url: '/api/upstream/recharge-links', cookies: { rp_session: cookie } });
      expect(g0.statusCode).toBe(200);
      expect(g0.json().links).toEqual([]);

      // 拒非 http(s)
      const bad = await ts.app.inject({
        method: 'PUT',
        url: '/api/upstream/recharge-links',
        cookies: { rp_session: cookie },
        payload: { links: [{ label: 'Evil', url: 'javascript:alert(1)' }] },
      });
      expect(bad.statusCode).toBe(400);

      // 正常写入
      const put = await ts.app.inject({
        method: 'PUT',
        url: '/api/upstream/recharge-links',
        cookies: { rp_session: cookie },
        payload: { links: [{ label: 'Upstream A', url: 'https://a.example.com/recharge', note: '手工记账' }] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().links).toEqual([
        { label: 'Upstream A', url: 'https://a.example.com/recharge', note: '手工记账' },
      ]);

      // GET 读回一致
      const g1 = await ts.app.inject({ method: 'GET', url: '/api/upstream/recharge-links', cookies: { rp_session: cookie } });
      expect(g1.json().links).toEqual([
        { label: 'Upstream A', url: 'https://a.example.com/recharge', note: '手工记账' },
      ]);
    } finally {
      await ts.close();
    }
  });

  it('root 拉 balances：quota/window/none 分类 + 低余额 + 降级站 marker', async () => {
    const ts = await makeTestServer({ config: { channelBalanceThreshold: 10 } });
    try {
      const { operatorId, cookie } = await ts.seedLogin({ email: 'root2@x.com', password: 'pw-123456', role: 'root' });
      await ts.db.orm.insert(sites).values({
        operatorId,
        slug: 'up-a',
        label: 'UP-A',
        engine: 'sub2api',
        version: 'v1',
        hostPort: 19700,
        baseUrl: 'http://127.0.0.1:19701',
        status: 'active',
      });
      await ts.db.orm.insert(sites).values({
        operatorId,
        slug: 'up-down',
        label: 'UP-DOWN',
        engine: 'sub2api',
        version: 'v1',
        hostPort: 19702,
        baseUrl: 'http://127.0.0.1:19703',
        status: 'active',
      });

      ts.adapters.sub2api.setChannelBalances('up-a', [
        { id: '1', name: 'apikey-ch', accountType: 'apikey', enabled: true, kind: 'quota', quotaLimit: 100, quotaUsed: 95 },
        { id: '2', name: 'oauth-ch', accountType: 'oauth', enabled: true, kind: 'window', windowCostLimit: 50 },
        { id: '3', name: 'bare-ch', accountType: 'apikey', enabled: true, kind: 'none' },
      ]);
      ts.adapters.sub2api.setAccountAvgDailyCost('up-a', '1', 5); // daysLeft = (100-95)/5 = 1.0
      ts.adapters.sub2api.setUnreachable('up-down'); // connect 抛错 → 降级 marker

      const res = await ts.app.inject({ method: 'GET', url: '/api/upstream/balances?days=7', cookies: { rp_session: cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.thresholdUsd).toBe(10);
      expect(body.costUnit).toBe('USD');
      expect(body.coverage).toEqual({ withQuota: 1, windowOnly: 1, zeroCoverage: 1, degradedSites: 1 });

      const quota = body.rows.find((r: { id: string }) => r.id === '1');
      expect(quota).toMatchObject({ kind: 'quota', coverage: 'exact', remaining: 5, low: true });
      expect(quota.daysLeft).toBeCloseTo(1, 5);

      const win = body.rows.find((r: { id: string }) => r.id === '2');
      expect(win).toMatchObject({ kind: 'window', coverage: 'estimate', windowCostLimit: 50 });
      expect(win.daysLeft).toBeNull();
      expect(win.remaining).toBeUndefined();

      const none = body.rows.find((r: { id: string }) => r.id === '3');
      expect(none).toMatchObject({ kind: 'none', coverage: 'none' });
      expect(none.daysLeft).toBeNull();
      expect(none.remaining).toBeUndefined();

      // 降级站 marker
      const marker = body.rows.find((r: { siteOk: boolean }) => r.siteOk === false);
      expect(marker).toBeTruthy();
      expect(marker.siteSlug).toBe('up-down');
    } finally {
      await ts.close();
    }
  });
});
