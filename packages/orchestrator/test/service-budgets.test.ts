import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { budgetPolicies, budgetEvents, observationRuns, observedRequests, operators, sites, notifications, organizations, organizationMembers } from '../src/db/schema.js';
import { Budgets, budgetWindow, startBudgetWorker } from '../src/services/budgets.js';
import { beijingDay } from '../src/services/observations.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import type { PassiveRecord } from '@relay-panel/adapter-core';

const input = { name: 'Daily site spend', period: 'day', basis: 'charge', amountUsd: 100, warningPercent: 80, channelId: null, model: null, enabled: true, notify: true };
describe('budgets from existing evidence', () => {
  let ts: TestServer, owner: { operatorId: number; cookie: string }, other: typeof owner, editor: typeof owner, viewer: typeof owner, siteId: number, runId: number, policyId: number, sequence = 0;
  const base = '/api/services/budgets', today = beijingDay();
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, who = owner, workspace?: number) => ts.app.inject({ method, url, cookies: { rp_session: who.cookie }, ...(payload ? { payload } : {}), ...(workspace ? { headers: { 'x-workspace-id': String(workspace) } } : {}) });
  const report = async () => (await call('GET', `${base}/${policyId}/report`)).json().report;
  async function evidence(values: Partial<PassiveRecord>, generation = 1, targetRun = runId) {
    const id = String(++sequence), data: PassiveRecord = { id, requestId: 'request-' + id, createdAt: today + 'T01:00:00+08:00', model: 'model-a', channelId: 'channel-a', outcome: 'consumption', durationMs: 100, firstTokenMs: null, inputTokens: null, outputTokens: null, charge: null, supplierCost: null, expectedCharge: null, currency: 'USD', billingType: 'balance', ...values };
    return (await ts.db.orm.insert(observedRequests).values({ runId: targetRun, sourceId: id, generation, evidence: data }).returning())[0]!;
  }
  beforeAll(async () => {
    ts = await makeTestServer();
    owner = await ts.seedLogin({ email: 'budget-owner@example.test', password: 'long-test-password', role: 'operator' });
    other = await ts.seedLogin({ email: 'budget-other@example.test', password: 'long-test-password', role: 'operator' });
    editor = await ts.seedLogin({ email: 'budget-editor@example.test', password: 'long-test-password', role: 'operator' });
    viewer = await ts.seedLogin({ email: 'budget-viewer@example.test', password: 'long-test-password', role: 'viewer' });
    siteId = (await ts.db.orm.insert(sites).values({ operatorId: owner.operatorId, slug: 'budget-own', label: 'Budget site', engine: 'sub2api', version: '1', hostPort: 0, baseUrl: 'http://127.0.0.1:9999', status: 'active', managed: 'external' }).returning())[0]!.id;
    await ts.db.orm.insert(organizations).values({ ownerId: owner.operatorId, name: 'Owner workspace' });
    await ts.db.orm.insert(organizationMembers).values({ ownerId: owner.operatorId, operatorId: editor.operatorId, role: 'editor' });
  });
  afterAll(async () => ts.close());
  it('limits management to the actual owner and keeps read access tenant-scoped', async () => {
    expect((await call('POST', base, { ...input, siteId }, other)).statusCode).toBe(404);
    expect((await call('POST', base, { ...input, siteId }, editor, owner.operatorId)).statusCode).toBe(403);
    expect((await call('POST', base, { ...input, siteId }, viewer)).statusCode).toBe(403);
    for (const amountUsd of [0, -1, 1.0000001]) expect((await call('POST', base, { ...input, siteId, amountUsd })).statusCode).toBe(400);
    expect((await call('POST', base, { ...input, siteId, currency: 'CNY' })).statusCode).toBe(400);
    const r = await call('POST', base, { ...input, siteId }); expect(r.statusCode).toBe(201); policyId = r.json().item.id;
    expect(r.json().item.amountUsd).toBe('100.000000');
    expect((await call('GET', base + `?siteId=${siteId}`, undefined, editor, owner.operatorId)).json().canManage).toBe(false);
    for (const suffix of ['/report', '/events', '/report.csv']) expect((await call('GET', base + `/${policyId}` + suffix, undefined, other)).statusCode).toBe(404);
  });
  it('never turns missing or unpriced evidence into an available budget', async () => {
    let r = await report(); expect(r.status).toBe('no_evidence'); expect(r.observedUsd).toBeNull(); expect(r.missingDays).toBe(1); expect(r.stale).toBe(true); expect(r.enforcement).toBe('observation_only');
    runId = (await ts.db.orm.insert(observationRuns).values({ siteId, day: today, status: 'complete', total: 0, sourceScope: 'consumption-only' }).returning())[0]!.id;
    await evidence({ charge: null }); r = await report(); expect(r.observedUsd).toBeNull(); expect(r.pricedRecords).toBe(0); expect(r.records).toBe(1); expect(r.allRecordsPriced).toBe(false);
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).json().eventCreated).toBe(false);
  });
  it('aggregates only current-generation consumption and exposes partial collection coverage', async () => {
    await evidence({ charge: 40, supplierCost: 20 }); await evidence({ charge: 40, supplierCost: 30 });
    await evidence({ charge: 99999, outcome: 'error' }); await evidence({ charge: 99999 }, 0);
    await ts.db.orm.update(observationRuns).set({ status: 'partial' }).where(eq(observationRuns.id, runId));
    const r = await report(); expect(r.observedUsd).toBe('80.000000'); expect(r.status).toBe('warning'); expect(r.records).toBe(3); expect(r.pricedRecords).toBe(2); expect(r.completeDays).toBe(0); expect(r.stale).toBe(true);
  });
  it('deduplicates simultaneous threshold events and commits the notification atomically', async () => {
    const r = await Promise.all([1, 2].map(() => call('POST', `${base}/${policyId}/evaluate`, {})));
    expect(r.map(x => x.statusCode)).toEqual([200, 200]); expect(r.filter(x => x.json().eventCreated)).toHaveLength(1);
    expect((await ts.db.orm.select().from(budgetEvents))).toHaveLength(1);
    const messages = await ts.db.orm.select().from(notifications); expect(messages).toHaveLength(1); expect(messages[0]!.operatorId).toBe(owner.operatorId); expect(messages[0]!.body).toContain('不执行');
  });
  it('escalates at the limit, retains the original evidence and records acknowledgement once', async () => {
    await evidence({ charge: 20 });
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).json().eventCreated).toBe(true);
    const events = (await call('GET', `${base}/${policyId}/events`)).json().items; expect(events.map((e: { level: number }) => e.level)).toEqual([100, 80]);
    expect(events[1].evidence.observedUsd).toBe('80.000000'); expect(events[0].evidence.observedUsd).toBe('100.000000');
    const url = `${base}/${policyId}/events/${events[0].id}/acknowledge`;
    expect((await call('POST', url, { note: 'Reviewed incomplete source coverage' }, editor, owner.operatorId)).statusCode).toBe(403);
    expect((await call('POST', url, { note: 'Reviewed incomplete source coverage' })).statusCode).toBe(200);
    expect((await call('POST', url, { note: 'Do not overwrite acknowledgement' })).statusCode).toBe(409);
    expect((await report()).status).toBe('exceeded');
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).json().eventCreated).toBe(false);
    expect((await ts.db.orm.select().from(notifications))).toHaveLength(2);
  });
  it('supports exact channel/model filters and never substitutes charge for unknown supplier cost', async () => {
    const filtered = await call('POST', base, { ...input, siteId, name: 'Model supplier cost', basis: 'supplierCost', channelId: 'channel-a', model: 'model-a', notify: false });
    const id = filtered.json().item.id, r = (await call('GET', `${base}/${id}/report`)).json().report; expect(r.observedUsd).toBe('50.000000'); expect(r.pricedRecords).toBe(2);
    const unknown = await call('POST', base, { ...input, siteId, name: 'Missing model', model: 'missing-model', notify: false });
    expect((await call('GET', `${base}/${unknown.json().item.id}/report`)).json().report.observedUsd).toBeNull();
    const csv = await call('GET', `${base}/${id}/report.csv`); expect(csv.statusCode).toBe(200); expect(csv.body).toContain('50.000000'); expect(csv.body).toContain('partial');
  });
  it('treats exact decimal thresholds correctly and isolates new scan generations', async () => {
    const policy = (await call('POST', base, { ...input, siteId, name: 'Decimal threshold', model: 'decimal-model', amountUsd: 0.3, notify: false })).json().item;
    await evidence({ model: 'decimal-model', charge: 0.1 }); await evidence({ model: 'decimal-model', charge: 0.2 });
    const r = (await call('POST', `${base}/${policy.id}/evaluate`, {})).json(); expect(r.report.observedUsd).toBe('0.300000'); expect(r.report.status).toBe('exceeded');
    await ts.db.orm.update(observationRuns).set({ generation: 2, status: 'partial' }).where(eq(observationRuns.id, runId));
    expect((await report()).observedUsd).toBeNull();
    await evidence({ charge: 30 }, 2); expect((await report()).observedUsd).toBe('30.000000');
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).json().eventCreated).toBe(false);
  });
  it('does not claim recovery after a lower partial scan or send a lower-severity alert', async () => {
    await evidence({ charge: 55 }, 2); const r = await call('POST', `${base}/${policyId}/evaluate`, {});
    expect(r.json().report.status).toBe('warning'); expect(r.json().eventCreated).toBe(false);
    expect((await ts.db.orm.select().from(notifications))).toHaveLength(2);
    await ts.db.orm.update(observationRuns).set({ status: 'error', updatedAt: toPgTimestamp(new Date(Date.now() - 3600000)) }).where(eq(observationRuns.id, runId));
    expect((await report()).stale).toBe(true);
  });
  it('versions policy edits, honors pause and prevents disabled owners from generating events', async () => {
    expect((await call('POST', `${base}/${policyId}`, { ...input, version: 1, enabled: false })).statusCode).toBe(200);
    expect((await call('POST', `${base}/${policyId}`, { ...input, version: 1 })).statusCode).toBe(409);
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).statusCode).toBe(409);
    expect((await call('POST', `${base}/${policyId}`, { ...input, version: 2, enabled: true, notify: false })).statusCode).toBe(200);
    const service = new Budgets(ts.db, ts.config);
    await ts.db.orm.update(operators).set({ status: 'disabled' }).where(eq(operators.id, owner.operatorId));
    await expect(service.evaluate({ role: 'operator', operatorId: owner.operatorId, email: 'budget-owner@example.test' }, policyId)).rejects.toThrow('站点不存在');
    await ts.db.orm.update(operators).set({ status: 'active' }).where(eq(operators.id, owner.operatorId));
    expect((await call('POST', `${base}/${policyId}/evaluate`, {})).json().eventCreated).toBe(true);
    expect((await ts.db.orm.select().from(notifications))).toHaveLength(2);
  });
  it('runs bounded database-only background checks and exposes month coverage gaps', async () => {
    const worker = startBudgetWorker(ts.db, ts.config, 0); await Promise.all([worker.tick(), worker.tick()]); await worker.stop();
    expect(ts.adapters.sub2api.calls).toEqual([]); expect(ts.adapters.newapi.calls).toEqual([]);
    const monthly = (await call('POST', base, { ...input, siteId, name: 'Calendar month', period: 'month', notify: false })).json().item;
    const r = (await call('GET', `${base}/${monthly.id}/report`)).json().report;
    expect(r.window.from).toBe(today.slice(0, 8) + '01'); expect(r.missingDays).toBe(r.window.days.length - 1); expect(r.completeDays).toBe(0);
  });
  it('denies cross-origin writes and bounds policy count', async () => {
    const r = await ts.app.inject({ method: 'POST', url: base, cookies: { rp_session: owner.cookie }, headers: { origin: 'https://untrusted.test' }, payload: { ...input, siteId } }); expect(r.statusCode).toBe(403);
    const existing = await ts.db.orm.select().from(budgetPolicies).where(eq(budgetPolicies.siteId, siteId));
    await ts.db.orm.insert(budgetPolicies).values(Array.from({ length: 50 - existing.length }, (_, i) => ({ ...input, siteId, name: 'Bounded policy ' + i, amountUsd: '100.000000', enabled: false })));
    expect((await call('POST', base, { ...input, siteId })).statusCode).toBe(409); expect((await call('GET', base + `?siteId=${siteId}`)).json().items).toHaveLength(50);
  });
});
describe('budget calendar', () => {
  it('uses Beijing midnight, Monday weeks and calendar month boundaries', () => {
    const now = Date.parse('2026-10-25T16:01:00Z');
    expect(budgetWindow('day', now).from).toBe('2026-10-26'); expect(budgetWindow('week', now).from).toBe('2026-10-26');
    expect(budgetWindow('month', now).endExclusive).toBe('2026-11-01');
    expect(budgetWindow('week', Date.parse('2026-10-25T15:59:00Z')).from).toBe('2026-10-19');
    expect(budgetWindow('month', Date.parse('2028-02-29T00:00:00Z')).days).toHaveLength(29);
    expect(budgetWindow('month', Date.parse('2026-12-31T00:00:00Z')).endExclusive).toBe('2027-01-01');
  });
});
