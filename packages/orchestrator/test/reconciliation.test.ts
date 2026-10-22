import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@relay-panel/adapter-core';
import { sites } from '../src/db/schema.js';
import { makeTestServer, type TestServer } from './helpers.js';

describe('persisted supplier reconciliation', () => {
  let ts: TestServer, cookie: string, siteId: number, total = 2, duplicate = false;
  const base = '/api/admin/reconciliation';
  const record: UsageRecord = { id: '1', requestId: 'r1', createdAt: '2026-10-20T12:00:00Z', model: 'model', userId: '1', accountId: '1', subscriptionId: null,
    billingType: 'balance', activity: 1, actualCost: 0, totalCost: 10, rateMultiplier: 1, accountRateMultiplier: 1, accountStatsCost: 3, accountCost: 3, costUnit: 'USD', settlementProof: 'unavailable' };
  const api = (path = '', body?: unknown) => ts.app.inject({ method: body === undefined ? 'GET' : 'POST', url: base + path,
    cookies: { rp_session: cookie }, ...(body === undefined ? {} : { payload: body }) });
  beforeAll(async () => {
    ts = await makeTestServer();
    const owner = await ts.seedLogin({ email: 'reconcile@example.test', password: 'correct-password' }); cookie = owner.cookie;
    siteId = (await ts.db.orm.insert(sites).values({ operatorId: owner.operatorId, slug: 'invoice-site', label: 'Invoice site', engine: 'sub2api', version: '1', hostPort: 18000, baseUrl: 'http://127.0.0.1:18000', status: 'active' }).returning())[0]!.id;
    const connect = ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    vi.spyOn(ts.adapters.sub2api, 'connect').mockImplementation(async (...args) => {
      const c = await connect(...args);
      c.stats.usageRecords = async q => ({ items: [{ ...record, id: duplicate ? '1' : String(q.page) }], total, pages: 2, page: q.page, pageSize: 100 });
      return c;
    });
  });
  afterAll(async () => ts.close());
  async function create(ref: string) {
    const r = await api('', { siteId, from: '2026-10-20', to: '2026-10-20', supplier: 'Supplier', invoiceRef: ref, invoiceAmount: 7, currency: 'USD', note: 'Supplier statement provided' });
    expect(r.statusCode).toBe(201); return r.json().run;
  }
  it('persists scan progress and withholds conclusions until distinct source coverage is complete', async () => {
    const run = await create('invoice-1');
    expect((await api(`/${run.id}/scan`, {})).json().run.nextPage).toBe(2);
    expect((await api(`/${run.id}`)).json().summary.invoiceDifference).toBeNull();
    expect((await api(`/${run.id}/scan`, {})).json().run.status).toBe('complete');
    const result = (await api(`/${run.id}`)).json();
    expect(result.summary).toMatchObject({ scannedRows: 2, knownCostRows: 2, observedCost: 6, invoiceDifference: 1, estimableRows: 2, estimatedShortfall: 20 });
    expect((await api(`/${run.id}/scan`, {})).json().run.nextPage).toBe(3);
    expect((await api(`/${run.id}/export.csv`)).body).toContain('unavailable');
  });
  it('blocks changing source totals and can restart an incomplete duplicate scan with an audit reason', async () => {
    const run = await create('invoice-2');
    await api(`/${run.id}/scan`, {}); total = 3;
    expect((await api(`/${run.id}/scan`, {})).statusCode).toBe(409); total = 2; duplicate = true;
    expect((await api(`/${run.id}/scan`, {})).json().run.status).toBe('incomplete');
    const current = (await api(`/${run.id}`)).json();
    expect(current.summary.costComplete).toBe(false);
    expect((await api(`/${run.id}/restart`, { version: 1, note: 'Source logs corrected' })).statusCode).toBe(409);
    expect((await api(`/${run.id}/restart`, { version: current.run.version, note: 'Source logs corrected' })).statusCode).toBe(200);
    duplicate = false;
    await api(`/${run.id}/scan`, {}); await api(`/${run.id}/scan`, {});
    expect((await api(`/${run.id}`)).json().summary.scannedRows).toBe(2);
  });
  it('rejects overlapping rates and preserves voided evidence before a correction', async () => {
    const payload = { siteId, userId: '1', model: 'model', from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z', multiplier: 0.5, note: 'Historical contract evidence' };
    const created = await api('/rates', payload); expect(created.statusCode).toBe(200);
    expect((await api('/rates', payload)).statusCode).toBe(409);
    expect((await api(`/rates/${created.json().rate.id}/void`, { reason: 'Wrong historical contract' })).statusCode).toBe(200);
    expect((await api('/rates', { ...payload, multiplier: 0.7 })).statusCode).toBe(200);
    const rates = (await api(`/rates?siteId=${siteId}`)).json().rates;
    expect(rates).toHaveLength(2); expect(rates[1].voidedAt).not.toBeNull();
  });
});
