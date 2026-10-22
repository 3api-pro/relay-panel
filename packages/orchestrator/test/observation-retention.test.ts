import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { observationRuns, observationSourceRows, observedRequests, serviceEvents, serviceWork, sites } from '../src/db/schema.js';
import { beijingDay, Observations, startObservationWorker } from '../src/services/observations.js';

describe('passive observation retention', () => {
  let ts: TestServer, owner: { operatorId: number; cookie: string };
  let sequence = 0;
  const cutoff = () => beijingDay(Date.now() - 30 * 86400000);
  const expired = () => beijingDay(Date.now() - 31 * 86400000);
  beforeAll(async () => {
    ts = await makeTestServer();
    owner = await ts.seedLogin({ email: 'retention-owner@example.test', password: 'long-test-password', role: 'operator' });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => ts.close());
  async function seed(status = 'stopped') {
    const [site] = await ts.db.orm.insert(sites).values({ operatorId: owner.operatorId, slug: `retention-${++sequence}`, label: 'Retention fixture', engine: 'sub2api', version: '1', hostPort: 0, baseUrl: 'http://127.0.0.1:19000', status, managed: 'external' }).returning();
    const [run] = await ts.db.orm.insert(observationRuns).values({ siteId: site!.id, day: expired() }).returning();
    const evidence = { id: 'source-1', requestId: 'retained-case-evidence', createdAt: expired() + 'T04:00:00Z', model: 'model', channelId: '7', outcome: 'consumption' as const, durationMs: null, firstTokenMs: null, inputTokens: null, outputTokens: null, charge: 1, supplierCost: null, expectedCharge: null, currency: 'USD' as const, billingType: 'balance' as const };
    const [request] = await ts.db.orm.insert(observedRequests).values({ runId: run!.id, sourceId: evidence.id, generation: 1, evidence }).returning();
    await ts.db.orm.insert(observationSourceRows).values({ runId: run!.id, sourceId: evidence.id, generation: 1 });
    return { site: site!, run: run!, request: request!, evidence };
  }
  function start(interval = 60000) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    return startObservationWorker(ts, interval);
  }

  it('cleans inactive sites, cascades source rows, preserves the boundary and case evidence/history', async () => {
    const old = await seed();
    const [boundary] = await ts.db.orm.insert(observationRuns).values({ siteId: old.site.id, day: cutoff() }).returning();
    const created = await ts.app.inject({ method: 'POST', url: '/api/services/work', cookies: { rp_session: owner.cookie }, payload: { siteId: old.site.id, kind: 'incident', title: 'Retain investigation', description: 'Evidence remains attached after request retention', sourceId: old.request.id } });
    expect(created.statusCode).toBe(201);
    const workId = created.json().item.id;
    const eventsBefore = await ts.db.orm.select().from(serviceEvents).where(eq(serviceEvents.workId, workId));
    const scan = vi.spyOn(Observations.prototype, 'scan');
    const worker = start();
    vi.advanceTimersByTime(60000);
    await worker.stop();
    expect(await ts.db.orm.select().from(observationRuns).where(eq(observationRuns.id, old.run.id))).toEqual([]);
    expect(await ts.db.orm.select().from(observedRequests).where(eq(observedRequests.runId, old.run.id))).toEqual([]);
    expect(await ts.db.orm.select().from(observationSourceRows).where(eq(observationSourceRows.runId, old.run.id))).toEqual([]);
    expect(await ts.db.orm.select().from(observationRuns).where(eq(observationRuns.id, boundary!.id))).toHaveLength(1);
    const [work] = await ts.db.orm.select().from(serviceWork).where(eq(serviceWork.id, workId));
    expect(work).toMatchObject({ sourceId: null, evidence: old.evidence, status: 'open', version: 1 });
    expect(await ts.db.orm.select().from(serviceEvents).where(eq(serviceEvents.workId, workId))).toEqual(eventsBefore);
    expect(scan).not.toHaveBeenCalled();
    expect(ts.adapters.sub2api.calls).toEqual([]);
  });

  it('finishes retention before waiting on an active site collection', async () => {
    const old = await seed('active');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const scan = vi.spyOn(Observations.prototype, 'scan').mockImplementation(async () => { entered(); await gate; throw new Error('Controlled collection failure'); });
    const worker = start();
    try {
      vi.advanceTimersByTime(60000);
      await started;
      expect(await ts.db.orm.select().from(observationRuns).where(eq(observationRuns.id, old.run.id))).toEqual([]);
      expect(scan).toHaveBeenCalledOnce();
    } finally {
      release();
      await worker.stop();
      await ts.db.orm.update(sites).set({ status: 'stopped' }).where(eq(sites.id, old.site.id));
    }
  });

  it('does not start background deletion when the worker is explicitly disabled', async () => {
    const old = await seed();
    const worker = start(0);
    vi.advanceTimersByTime(600000);
    await worker.stop();
    expect(await ts.db.orm.select().from(observationRuns).where(eq(observationRuns.id, old.run.id))).toHaveLength(1);
  });
});
