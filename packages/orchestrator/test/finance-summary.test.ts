import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sites } from '../src/db/schema.js';
import { clearSiteCaches } from '../src/sites/service.js';
import { resolveSummaryRows, summaryTotals, summaryTrend } from '../src/finance/summary.js';
import type { FinanceSiteUsage, FinanceSiteDaily } from '../src/sites/service.js';
import { makeTestServer, type TestServer } from './helpers.js';

function usage(slug: string, overrides: Partial<FinanceSiteUsage> = {}): FinanceSiteUsage {
  return { slug, label: slug, ok: true, revenue: 100, accountCost: 40, costUnit: 'USD', requests: 10, tokens: 100, ...overrides };
}
const recharge = { periodAmount: {}, byDate: {}, ok: false, coverage: { expectedSites: 2, availableSites: 0 } };

describe('finance completeness and matched cost coverage', () => {
  it('failed sites cannot acquire estimated cost or contribute stale amounts', () => {
    const rows = resolveSummaryRows([usage('down', { ok: false }), usage('up')], { down: 0.5 });
    expect(rows[0]).toMatchObject({ cost: null, profit: null, costSource: null });
    expect(summaryTotals(rows, null)).toMatchObject({ revenue: 100, cost: 40, profit: 60, coverage: { expectedSites: 2, availableSites: 1, costedSites: 1, estimatedSites: 0 } });
  });
  it('daily profit excludes uncosted revenue and failed estimates; all-unknown stays null', () => {
    const daily: FinanceSiteDaily[] = [
      { slug: 'a', label: 'A', daily: [{ ...usage('a'), date: '2026-10-20' }] },
      { slug: 'b', label: 'B', daily: [{ ...usage('b', { revenue: 900, accountCost: null }), date: '2026-10-20' }] },
      { slug: 'down', label: 'Down', daily: [{ ...usage('down', { ok: false }), date: '2026-10-20' }] },
    ];
    const result = summaryTrend(['2026-10-20', '2026-10-21'], daily, { down: 0.3 }, recharge);
    expect(result[0]).toMatchObject({ revenue: 1000, cost: 40, profit: 60, costedRevenue: 100, coverage: { expectedSites: 3, availableSites: 2, costedSites: 1 } });
    expect(result[1]).toMatchObject({ revenue: null, cost: null, profit: null, requests: null });
  });
  it('zero is valid when the engine reported it; zero revenue with costs remains a loss', () => {
    const rows = resolveSummaryRows([usage('zero', { revenue: 0, accountCost: 2 })], {});
    expect(summaryTotals(rows, null)).toMatchObject({ revenue: 0, cost: 2, profit: -2, coverage: { availableSites: 1, costedSites: 1 } });
  });
  it('rejects mixed ledger units instead of silently assuming an exchange rate', () => {
    expect(() => summaryTotals(resolveSummaryRows([usage('usd'), usage('cny', { costUnit: 'CNY' })], {}), null)).toThrow('记账单位不同');
  });
});

describe('finance HTTP aggregation with adapter failures', () => {
  let ts: TestServer;
  let rootCookie: string;
  let ownerCookie: string;
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  beforeAll(async () => {
    ts = await makeTestServer();
    const root = await ts.seedLogin({ email: 'finance-root@example.com', password: 'test-only-password', role: 'root' });
    const owner = await ts.seedLogin({ email: 'finance-owner@example.com', password: 'test-only-password', role: 'operator' });
    rootCookie = root.cookie; ownerCookie = owner.cookie;
    for (const slug of ['owned', 'foreign']) {
      await ts.db.orm.insert(sites).values({ slug, label: slug, operatorId: slug === 'owned' ? owner.operatorId : root.operatorId, engine: 'sub2api', version: 'v1', hostPort: slug === 'owned' ? 18801 : 18802, baseUrl: 'http://127.0.0.1:18801', status: 'active' });
    }
  }, 60_000);
  afterAll(async () => { await ts.close(); });
  beforeEach(() => { vi.restoreAllMocks(); clearSiteCaches(); });
  function inject(cookie = rootCookie, date = today) {
    return ts.app.inject({ method: 'GET', url: `/api/finance/summary?from=${date}&to=${date}`, cookies: { rp_session: cookie } });
  }
  function intercept(mode: 'partial' | 'unknown' | 'list_price' | 'mixed') {
    const connect = ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    vi.spyOn(ts.adapters.sub2api, 'connect').mockImplementation(async (inst, credentials) => {
      const client = await connect(inst, credentials);
      client.stats.usage = async (from, to) => {
        if (mode === 'unknown') throw new Error('fixture offline');
        return { from, to, requests: 1, promptTokens: 2, completionTokens: 3, cost: 100,
          costUnit: mode === 'mixed' && inst.siteSlug === 'foreign' ? 'CNY' : 'USD',
          ...(inst.siteSlug === 'owned' ? { accountCost: 40 } : {}),
          ...(mode === 'list_price' ? { billingSource: 'list_price' as const } : {}),
        };
      };
      client.stats.rechargeSummary = async () => {
        if (inst.siteSlug === 'foreign') throw new Error('fixture payment endpoint unavailable');
        return { todayAmount: { CNY: 12, USD: 3 }, todayCount: 2, daily: [{ date: today, amount: { CNY: 12, USD: 3 }, count: 2 }] };
      };
      return client;
    });
  }
  it('reports partial recharge coverage and daily profit using the same coverage as totals', async () => {
    intercept('partial');
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { revenue: 200, cost: 40, profit: 60, recharge: { CNY: 12, USD: 3 } }, rechargeCoverage: { expectedSites: 2, availableSites: 1 }, trend: [{ revenue: 200, cost: 40, profit: 60 }] });
  });
  it('coverage and amounts are scoped to the owner', async () => {
    intercept('partial');
    expect((await inject(ownerCookie)).json()).toMatchObject({ totals: { revenue: 100, coverage: { expectedSites: 1, availableSites: 1 } }, rechargeCoverage: { expectedSites: 1, availableSites: 1 } });
  });
  it('unavailable usage preserves unknown daily values rather than zero', async () => {
    intercept('unknown');
    expect((await inject()).json()).toMatchObject({ totals: { coverage: { availableSites: 0, costedSites: 0 } }, trend: [{ revenue: null, cost: null, profit: null, requests: null }] });
  });
  it('list-price fallback is excluded from billed consumption', async () => {
    intercept('list_price');
    expect((await inject()).json()).toMatchObject({ allCosted: false, totals: { coverage: { availableSites: 0 } }, trend: [{ revenue: null }] });
  });
  it('mixed units return an explicit aggregation error', async () => {
    intercept('mixed');
    expect((await inject()).statusCode).toBe(422);
  });
  it('old recharge windows remain unknown, not successful zero receipts', async () => {
    intercept('partial');
    expect((await inject(rootCookie, '2024-01-01')).json()).toMatchObject({ totals: { recharge: null }, rechargeCoverage: { expectedSites: 2, availableSites: 0 } });
  });
});
