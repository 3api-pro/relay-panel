import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PassiveRecord } from '@relay-panel/adapter-core';
import { makeTestServer, type TestServer } from './helpers.js';
import { operators, sites, serviceAccess, observationRuns, observedRequests, financeSubmissions, organizations, organizationMembers, auditEvents } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
const input = { label: 'Shared finance report', fromDay: '2026-10-01', toDay: '2026-10-02', channelId: 'channel-a', model: 'model-a', costs: false, details: false, export: false, review: false, enabled: true, version: 0 };
describe('explicit finance collaboration scopes', () => {
 let ts: TestServer, owner: { operatorId: number; cookie: string }, member: typeof owner, other: typeof owner, editor: typeof owner;
 let siteId: number, accessId: number, runId: number, submissionId: number, seq = 0;
 const base = '/api/services/finance-access', portal = '/api/collaboration/finance';
 const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, who = owner, workspace?: number) => ts.app.inject({ method, url, cookies: { rp_session: who.cookie }, ...(payload ? { payload } : {}), ...(workspace ? { headers: { 'x-workspace-id': String(workspace) } } : {}) });
 const configure = (changes: Record<string, unknown> = {}) => call('POST', `${base}/${accessId}`, { ...input, ...changes });
 const read = () => call('GET', `${portal}/${accessId}/report`, undefined, member);
 async function evidence(values: Partial<PassiveRecord>, generation = 1, targetRun = runId) {
  const id = String(++seq), data: PassiveRecord = { id, requestId: 'PRIVATE-REQUEST-ID', createdAt: '2026-10-01T01:00:00+08:00', model: 'model-a', channelId: 'channel-a', outcome: 'consumption', durationMs: 100, firstTokenMs: null, inputTokens: null, outputTokens: null, charge: null, supplierCost: null, expectedCharge: null, currency: 'USD', billingType: 'balance', ...values };
  await ts.db.orm.insert(observedRequests).values({ runId: targetRun, sourceId: id, generation, evidence: data });
 }
 beforeAll(async () => {
  ts = await makeTestServer(); owner = await ts.seedLogin({ email: 'finance-owner@example.test', password: 'long-test-password', role: 'operator' }); member = await ts.seedLogin({ email: 'finance-member@example.test', password: 'long-test-password', role: 'operator' }); other = await ts.seedLogin({ email: 'finance-other@example.test', password: 'long-test-password', role: 'operator' }); editor = await ts.seedLogin({ email: 'finance-editor@example.test', password: 'long-test-password', role: 'operator' });
  await ts.db.orm.update(operators).set({ emailVerifiedAt: toPgTimestamp(new Date()) }).where(eq(operators.id, member.operatorId));
  siteId = (await ts.db.orm.insert(sites).values({ operatorId: owner.operatorId, slug: 'finance-own', label: 'PRIVATE SITE', engine: 'sub2api', version: '1', hostPort: 0, baseUrl: 'http://127.0.0.1:9999', status: 'active', managed: 'external' }).returning())[0]!.id;
  await ts.db.orm.insert(organizations).values({ ownerId: owner.operatorId, name: 'Owner workspace' }); await ts.db.orm.insert(organizationMembers).values({ ownerId: owner.operatorId, operatorId: editor.operatorId, role: 'editor' });
  const r = await call('POST', '/api/services/collaboration/access', { siteId, email: 'finance-member@example.test', role: 'finance', days: 30 }); accessId = r.json().item.id;
  expect((await call('POST', '/api/collaboration/accept', { token: r.json().token }, member)).statusCode).toBe(200);
  runId = (await ts.db.orm.insert(observationRuns).values({ siteId, day: '2026-10-01', status: 'partial', generation: 2, sourceScope: 'consumption-only' }).returning())[0]!.id;
 });
 afterAll(async () => ts.close());
 it('does not expand existing invitations and rejects editors, other tenants and non-finance roles', async () => {
  expect((await read()).statusCode).toBe(404); expect((await call('GET', portal, undefined, member)).json().items).toEqual([]);
  expect((await call('POST', `${base}/${accessId}`, input, other)).statusCode).toBe(404);
  expect((await call('POST', `${base}/${accessId}`, input, editor, owner.operatorId)).statusCode).toBe(403);
  const g = (await call('POST', '/api/services/collaboration/access', { siteId, email: 'finance-other@example.test', role: 'support' })).json().item;
  expect((await call('POST', `${base}/${g.id}`, input)).statusCode).toBe(400);
  expect((await configure({ fromDay: '2026-02-30' })).statusCode).toBe(400); expect((await configure({ fromDay: '2025-01-01' })).statusCode).toBe(400); expect((await configure({ fromDay: '2026-10-03' })).statusCode).toBe(400);
  expect((await configure()).statusCode).toBe(200); expect((await configure()).statusCode).toBe(409);
 });
 it('exposes no invented zero or cost information when evidence is missing', async () => {
  const r = await read(); expect(r.statusCode).toBe(200); expect(r.json().report.chargeUsd).toBeNull(); expect(r.json().report.days[1].scanStatus).toBe('missing'); expect(r.body).not.toMatch(/supplierCost|costRecords|PRIVATE|ownerId|siteId|baseUrl/);
  expect((await call('GET', `${portal}/${accessId}/records`, undefined, member)).statusCode).toBe(403); expect((await call('GET', `${portal}/${accessId}/report.csv`, undefined, member)).statusCode).toBe(403); expect((await call('POST', `${portal}/${accessId}/reviews`, { version: 1, note: 'Check observed amounts' }, member)).statusCode).toBe(403);
 });
 it('enforces exact channel/model, date and generation filters with decimal sums', async () => {
  await evidence({ charge: 9999 }, 1); await evidence({ charge: .1, supplierCost: .05 }, 2); await evidence({ charge: .2 }, 2); await evidence({}, 2);
  await evidence({ charge: 9000, channelId: 'other-channel' }, 2); await evidence({ charge: 8000, model: 'other-model' }, 2); await evidence({ charge: 7000, outcome: 'error' }, 2);
  const old = (await ts.db.orm.insert(observationRuns).values({ siteId, day: '2026-09-30', status: 'complete' }).returning())[0]!; await evidence({ charge: 6000 }, 1, old.id);
  const r = (await read()).json().report; expect(r.chargeUsd).toBe('0.300000'); expect(r.records).toBe(3); expect(r.pricedRecords).toBe(2); expect(r.days[0].scanStatus).toBe('partial'); expect(r.days[1].chargeUsd).toBeNull();
  expect((await call('GET', `${portal}/${accessId}/report?channelId=other-channel`, undefined, member)).statusCode).toBe(400);
  expect((await call('GET', portal, undefined, member, 999999)).json().items).toHaveLength(1);
  expect((await call('GET', `${portal}/${accessId}/report`, undefined, other)).statusCode).toBe(404);
  expect((await call('GET', '/api/services/catalog', undefined, member)).json().sites).toEqual([]);
 });
 it('separately grants detail and CSV without leaking raw evidence or costs', async () => {
  expect((await configure({ version: 1, details: true, export: true, review: true })).statusCode).toBe(200);
  const detail = await call('GET', `${portal}/${accessId}/records`, undefined, member); expect(detail.statusCode).toBe(200); expect(detail.json().items).toHaveLength(3); expect(detail.body).not.toMatch(/supplierCost|requestId|PRIVATE|sourceId|billingType/);
  const csv = await call('GET', `${portal}/${accessId}/report.csv`, undefined, member); expect(csv.statusCode).toBe(200); expect(csv.body).toContain('0.300000'); expect(csv.body).not.toMatch(/Supplier cost|PRIVATE/); expect(csv.headers['cache-control']).toContain('no-store');
 });
 it('serializes submission, keeps immutable evidence and requires owner review', async () => {
  const url = `${portal}/${accessId}/reviews`, rs = await Promise.all([1, 2].map(() => call('POST', url, { version: 2, note: 'Please review the incomplete collection coverage' }, member))); expect(rs.map(r => r.statusCode).sort()).toEqual([201, 409]); submissionId = rs.find(r => r.statusCode === 201)!.json().item.id;
  expect((await call('POST', `${base}/${accessId}/reviews/${submissionId}`, { version: 1, status: 'accepted', decision: 'Cannot approve own work' }, member)).statusCode).toBe(404);
  await evidence({ charge: 10 }, 2);
  const rows = (await call('GET', url, undefined, member)).json().items; expect(rows[0].report.chargeUsd).toBe('0.300000'); expect(rows[0].report.supplierCostUsd).toBeUndefined();
  const decisionUrl = `${base}/${accessId}/reviews/${submissionId}`; const decisions = await Promise.all(['accepted', 'returned'].map(status => call('POST', decisionUrl, { version: 1, status, decision: 'Owner checked the available evidence' }))); expect(decisions.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect((await ts.db.orm.select().from(financeSubmissions))).toHaveLength(1);
 });
 it('paginates scoped records without duplicates and keeps foreign fields outside the response', async () => {
  const start = seq;
  for (let i = 0; i < 103; i++) await evidence({ charge: 1 }, 2);
  const first = (await call('GET', `${portal}/${accessId}/records`, undefined, member)).json();
  expect(first.items).toHaveLength(100); expect(first.hasMore).toBe(true);
  const second = (await call('GET', `${portal}/${accessId}/records?beforeId=${first.items.at(-1).id}`, undefined, member)).json();
  expect(second.items).toHaveLength(7); expect(second.hasMore).toBe(false);
  expect(new Set([...first.items, ...second.items].map(r => r.id)).size).toBe(107);
  for (let i = start + 1; i <= seq; i++) await ts.db.orm.delete(observedRequests).where(eq(observedRequests.sourceId, String(i)));
 });
 it('rejects forged scope payloads and cross-origin changes before mutation', async () => {
  expect((await configure({ version: 2, siteId: 9876 })).statusCode).toBe(400);
  const r = await ts.app.inject({ method: 'POST', url: `${base}/${accessId}`, cookies: { rp_session: owner.cookie }, headers: { origin: 'https://untrusted.example' }, payload: { ...input, version: 2 } }); expect(r.statusCode).toBe(403);
  expect((await read()).json().report.scope.version).toBe(2);
 });
 it('keeps supplier costs unknown instead of substituting charges and protects old snapshots after narrowing', async () => {
  expect((await configure({ version: 2, costs: true, details: true, export: true, review: true })).statusCode).toBe(200);
  const r = (await read()).json().report; expect(r.supplierCostUsd).toBe('0.050000'); expect(r.costRecords).toBe(1); expect(r.pricedRecords).toBe(3);
  const submitted = await call('POST', `${portal}/${accessId}/reviews`, { version: 3, note: 'Includes explicitly shared supplier cost evidence' }, member); expect(submitted.statusCode).toBe(201);
  expect((await configure({ version: 3, review: true })).statusCode).toBe(200);
  expect((await call('GET', `${portal}/${accessId}/reviews`, undefined, member)).json().items).toEqual([]);
  const prior = await call('GET', `${base}/${accessId}/reviews`); expect(prior.json().items).toHaveLength(2); expect(prior.body).toContain('0.050000');
  expect((await read()).body).not.toContain('supplierCostUsd'); expect((await call('POST', `${portal}/${accessId}/reviews`, { version: 3, note: 'Cannot reuse outdated permissions' }, member)).statusCode).toBe(409);
 });
 it('invalidates read, export and review for pause, unverified email, expiry, disabled owner and ownership change', async () => {
  expect((await configure({ version: 4, enabled: false })).statusCode).toBe(200); expect((await read()).statusCode).toBe(404); expect((await call('GET', portal, undefined, member)).json().items).toEqual([]);
  expect((await configure({ version: 5, review: true })).statusCode).toBe(200);
  await ts.db.orm.update(operators).set({ emailVerifiedAt: null }).where(eq(operators.id, member.operatorId)); expect((await read()).statusCode).toBe(403); await ts.db.orm.update(operators).set({ emailVerifiedAt: toPgTimestamp(new Date()) }).where(eq(operators.id, member.operatorId));
  await ts.db.orm.update(serviceAccess).set({ expiresAt: toPgTimestamp(new Date(Date.now() - 1000)) }).where(eq(serviceAccess.id, accessId)); expect((await read()).statusCode).toBe(404); await ts.db.orm.update(serviceAccess).set({ expiresAt: toPgTimestamp(new Date(Date.now() + 86400000)) }).where(eq(serviceAccess.id, accessId));
  await ts.db.orm.update(operators).set({ status: 'disabled' }).where(eq(operators.id, owner.operatorId)); expect((await read()).statusCode).toBe(404); await ts.db.orm.update(operators).set({ status: 'active' }).where(eq(operators.id, owner.operatorId));
  await ts.db.orm.update(sites).set({ operatorId: other.operatorId }).where(eq(sites.id, siteId)); expect((await read()).statusCode).toBe(404); await ts.db.orm.update(sites).set({ operatorId: owner.operatorId }).where(eq(sites.id, siteId));
  expect((await call('DELETE', `/api/services/collaboration/access/${accessId}`)).statusCode).toBe(200);
  for (const suffix of ['report', 'records', 'report.csv', 'reviews']) expect((await call('GET', `${portal}/${accessId}/${suffix}`, undefined, member)).statusCode).toBe(404);
  expect((await call('GET', portal, undefined, member)).json().items).toEqual([]); expect((await call('GET', `${base}/${accessId}/reviews`)).json().items).toHaveLength(2);
  const events = await ts.db.orm.select().from(auditEvents); expect(events.some(e => e.action === 'finance-access.configure')).toBe(true); expect(events.some(e => e.action === 'finance-access.export')).toBe(true); expect(events.some(e => e.action === 'finance-access.decision')).toBe(true);
 });
});
