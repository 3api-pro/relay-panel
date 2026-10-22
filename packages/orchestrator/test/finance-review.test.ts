import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@relay-panel/adapter-core';
import { eq } from 'drizzle-orm';
import { sites, financeReviewCases as cases, financeReviewEvents as events } from '../src/db/schema.js';
import { reviewReasons } from '../src/finance/review.js';
import { makeTestServer, type TestServer } from './helpers.js';

const evidence: UsageRecord = { id: '7', requestId: 'r-7', createdAt: '2026-10-20T12:00:00.000Z', model: 'm',
  userId: '2', accountId: '3', subscriptionId: null, billingType: 'balance', activity: 10,
  actualCost: 0, totalCost: 3, rateMultiplier: 1, accountRateMultiplier: 0.5, accountStatsCost: 2,
  accountCost: 1, costUnit: 'USD', settlementProof: 'unavailable' };

describe('review signals', () => {
  it('distinguishes zero from unknown and excludes explicit free/subscription usage', () => {
    expect(reviewReasons(evidence)).toEqual(['zero_charge']);
    expect(reviewReasons({ ...evidence, actualCost: null })).toEqual(['incomplete_evidence']);
    expect(reviewReasons({ ...evidence, billingType: 'unknown' })).toEqual(['incomplete_evidence']);
    expect(reviewReasons({ ...evidence, activity: null, accountCost: null })).toEqual(['incomplete_evidence']);
    expect(reviewReasons({ ...evidence, billingType: 'subscription' })).toEqual([]);
    expect(reviewReasons({ ...evidence, rateMultiplier: 0 })).toEqual([]);
    expect(reviewReasons({ ...evidence, actualCost: 0.1 })).toEqual([]); // Negative margin alone isn't a settlement incident.
  });
});

describe('root-only request review workflow', () => {
  let ts: TestServer; let root: string; let owner: string; let viewer: string;
  let records: UsageRecord[];
  let fail = false;
  const base = '/api/admin/finance-review';
  const query = { slug: 'review-site', from: '2026-10-20', to: '2026-10-20', page: 1 };
  const read = vi.fn();
  async function api(path = '', payload?: unknown, cookie = root) {
    return ts.app.inject({ method: payload === undefined ? 'GET' : 'POST', url: base + path,
      cookies: { rp_session: cookie }, ...(payload !== undefined ? { payload } : {}) });
  }
  async function first() { return (await api()).json().items[0]; }
  async function scan() { const res = await api('/scan', query); expect(res.statusCode).toBe(200); return res.json(); }
  beforeAll(async () => {
    ts = await makeTestServer();
    const r = await ts.seedLogin({ email: 'review-root@example.com', password: 'unit-password', role: 'root' }); root = r.cookie;
    owner = (await ts.seedLogin({ email: 'review-owner@example.com', password: 'unit-password', role: 'operator' })).cookie;
    viewer = (await ts.seedLogin({ email: 'review-viewer@example.com', password: 'unit-password', role: 'viewer' })).cookie;
    await ts.db.orm.insert(sites).values({ slug: 'review-site', label: 'Review', operatorId: r.operatorId,
      engine: 'sub2api', version: 'v1', hostPort: 18850, baseUrl: 'http://127.0.0.1:18850', status: 'active' });
    const connect = ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    vi.spyOn(ts.adapters.sub2api, 'connect').mockImplementation(async (...args) => {
      const client = await connect(...args);
      client.stats.usageRecords = async q => {
        read(q);
        if (fail) throw new Error('raw secret DO-NOT-EXPOSE');
        return { items: records, total: records.length, page: q.page, pages: 1, pageSize: 100 };
      };
      return client;
    });
  }, 60_000);
  afterAll(async () => ts.close());
  beforeEach(async () => {
    await ts.db.orm.delete(events); await ts.db.orm.delete(cases);
    records = [{ ...evidence }]; fail = false; read.mockClear();
  });
  it('rejects every route for non-root before reading the engine', async () => {
    for (const cookie of [owner, viewer]) {
      for (const [path, body] of [['', undefined], ['/sites', undefined], ['/1', undefined], ['/scan', query], ['/1/recheck', { version: 1 }], ['/1/review', { version: 1, state: 'reviewing', note: 'x' }]] as const) {
        expect((await api(path, body, cookie)).statusCode).toBe(403);
      }
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('loads allowlisted site choices even if the engine is down', async () => {
    ts.adapters.sub2api.calls.length = 0;
    fail = true;
    const result = await api('/sites');
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.json().sites[0]).sort()).toEqual(['engine', 'id', 'label', 'slug', 'status']);
    expect(ts.adapters.sub2api.calls).toHaveLength(0);
  });
  it('validates dates, page limits and input before I/O', async () => {
    for (const patch of [{ from: '2026-02-30' }, { from: '2026-01-01' }, { to: '2099-01-01' }, { page: 0 }]) {
      expect((await api('/scan', { ...query, ...patch })).statusCode).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('deduplicates repeated and concurrent scans without duplicate history', async () => {
    const results = await Promise.all([scan(), scan()]);
    expect(results.reduce((s, r) => s + r.created, 0)).toBe(1);
    const item = await first();
    expect((await api(`/${item.id}`)).json().events).toHaveLength(1);
    expect(await scan()).toMatchObject({ created: 0, updated: 0, scope: 'page', scanned: 1, total: 1 });
  });
  it('requires notes and rejects stale concurrent decisions', async () => {
    await scan(); const row = await first();
    expect((await api(`/${row.id}/review`, { version: row.version, state: 'explained', note: ' ' })).statusCode).toBe(400);
    const results = await Promise.all(['evidence A', 'evidence B'].map(note => api(`/${row.id}/review`, { version: row.version, state: 'reviewing', note })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await api(`/${row.id}`)).json().events).toHaveLength(2);
  });
  it('never resolves flagged, missing, wrong-identity or failed evidence', async () => {
    await scan(); let row = await first();
    expect((await api(`/${row.id}/review`, { version: row.version, state: 'resolved', note: 'attempt' })).statusCode).toBe(409);
    for (const mode of ['missing', 'wrong', 'failure']) {
      records = mode === 'wrong' ? [{ ...evidence, userId: '999', actualCost: 2 }] : [];
      fail = mode === 'failure';
      const result = await api(`/${row.id}/recheck`, { version: row.version });
      expect(result.statusCode).toBe(200); expect(result.body).not.toContain('DO-NOT-EXPOSE');
      row = result.json(); expect(row).toMatchObject({ verification: 'unavailable', state: 'pending', evidence: { actualCost: 0 } });
      expect((await api(`/${row.id}/review`, { version: row.version, state: 'resolved', note: 'attempt' })).statusCode).toBe(409);
    }
  });
  it('supports fresh verification then resolution and reopens changed closed evidence', async () => {
    await scan(); let row = await first();
    records = [{ ...evidence, actualCost: 2 }];
    row = (await api(`/${row.id}/recheck`, { version: row.version })).json();
    expect(row.verification).toBe('clear');
    let result = await api(`/${row.id}/review`, { version: row.version, state: 'resolved', note: 'Matched corrected engine record; no historic debit made here.' });
    expect(result.statusCode).toBe(200); row = result.json();
    records = [{ ...evidence }]; await scan();
    row = await first(); expect(row.state).toBe('pending');
    expect((await api(`/${row.id}`)).json().events).toHaveLength(4);
  });
  it('does not accept stale clear checks', async () => {
    await scan(); const row = await first();
    await ts.db.orm.update(cases).set({ verification: 'clear', checkedAt: '2020-01-01 00:00:00' }).where(eq(cases.id, row.id));
    expect((await api(`/${row.id}/review`, { version: row.version, state: 'resolved', note: 'stale' })).statusCode).toBe(409);
  });
  it('rolls back case and event changes if the audit cannot be written', async () => {
    await ts.db.exec(`CREATE FUNCTION reject_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'finance.review.detected' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER review_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_review_audit();`);
    try {
      expect((await api('/scan', query)).statusCode).toBe(500);
      expect((await api()).json().items).toHaveLength(0);
      expect(await ts.db.orm.select().from(events)).toHaveLength(0);
    } finally {
      await ts.db.exec('DROP TRIGGER review_audit_failure ON audit_events; DROP FUNCTION reject_review_audit();');
    }
  });
  it('sanitizes scan failure without inventing empty successful coverage', async () => {
    fail = true;
    const result = await api('/scan', query);
    expect(result.statusCode).toBe(502); expect(result.body).not.toContain('DO-NOT-EXPOSE');
    expect((await api()).json().items).toHaveLength(0);
  });
});
