import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { sites, paymentOrders, refundRequests, jobs, auditEvents } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { PaymentsService } from '../src/billing/payments/service.js';

let ts: TestServer;
let root: { operatorId: number; cookie: string }, owner: typeof root, other: typeof root, reader: typeof root, viewer: typeof root;
let siteId: number;
async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, actor = owner, payload?: unknown, workspace?: number) {
  return ts.app.inject({ method, url, cookies: { rp_session: actor.cookie },
    ...(workspace ? { headers: { 'x-workspace-id': String(workspace) } } : {}), ...(payload === undefined ? {} : { payload }) });
}
let seq = 0;
async function order(status = 'completed', amount = 100) {
  const [row] = await ts.db.orm.insert(paymentOrders).values({ orderNo: `OPS-${++seq}`, operatorId: owner.operatorId,
    planKey: 'pro', months: 1, amount, providerKey: 'alipay', status, paidAt: toPgTimestamp(new Date()), fulfillmentVersion: 1 }).returning();
  return row!;
}
beforeAll(async () => {
  ts = await makeTestServer({ config: { deploymentMode: 'saas', emailVerificationRequired: false, localProvisionEnabled: true } });
  root = await ts.seedLogin({ email: 'root@ops.test', password: 'correct-password', role: 'root' });
  owner = await ts.seedLogin({ email: 'owner@ops.test', password: 'correct-password', role: 'operator' });
  other = await ts.seedLogin({ email: 'other@ops.test', password: 'correct-password', role: 'operator' });
  reader = await ts.seedLogin({ email: 'reader@ops.test', password: 'correct-password', role: 'operator' });
  viewer = await ts.seedLogin({ email: 'viewer@ops.test', password: 'correct-password', role: 'viewer' });
  const [site] = await ts.db.orm.insert(sites).values({ slug: 'owned-site', label: 'Owner private site', operatorId: owner.operatorId,
    engine: 'sub2api', version: '1', hostPort: 0, baseUrl: 'https://engine.example.test', managed: 'external', status: 'active' }).returning();
  siteId = site!.id;
  await ts.db.orm.insert(jobs).values({ kind: 'upgrade', siteId, slug: 'owned-site', createdBy: 'owner@ops.test', status: 'succeeded' });
  await ts.db.orm.insert(auditEvents).values({ siteId, actor: 'root@ops.test', action: 'site.rename', ok: true });
}, 60_000);
afterAll(async () => ts.close());

describe('commercial scope and account isolation', () => {
  it('cannot provision platform hardware even with the local switch enabled', async () => {
    for (const actor of [root, owner]) {
      const res = await api('POST', '/api/sites', actor, { slug: 'forbidden-create', label: 'Test', engine: 'sub2api', version: '1', adminEmail: 'owner@ops.test' });
      expect(res.statusCode).toBe(410);
    }
  });
  it('blocks cross-tenant resources, derived jobs and exports', async () => {
    for (const url of ['/api/sites/owned-site', '/api/sites/owned-site/channels', '/api/sites/owned-site/users', '/api/sites/owned-site/branding', '/api/sites/owned-site/usage', '/api/sites/owned-site/audit', '/api/sites/owned-site/domains', '/api/jobs/1']) {
      expect((await api('GET', url, other)).statusCode, url).toBe(404);
    }
    expect((await api('GET', '/api/audit/export.csv', other)).body).not.toContain('Owner private site');
    expect((await api('GET', '/api/jobs', other)).body).not.toContain('owned-site');
    for (const url of ['/api/admin/operations', '/api/admin/reconciliation', '/api/admin/finance-review', '/api/operators', '/api/billing/providers']) {
      for (const actor of [owner, other, viewer]) expect((await api('GET', url, actor)).statusCode, url).toBe(403);
    }
  });
  it('scopes personal notifications and preferences', async () => {
    expect((await api('PUT', '/api/notifications/preferences', owner, { alerts: false, billing: true, support: false })).statusCode).toBe(200);
    expect((await api('GET', '/api/notifications/preferences', other)).json().preferences.alerts).toBe(true);
  });
});

describe('refund aftercare', () => {
  it('serializes overlapping refund amounts and rejects cross-tenant access', async () => {
    const o = await order();
    const attempts = await Promise.all([api('POST', `/api/billing/orders/${o.orderNo}/refunds`, owner, { amount: 80, reason: 'Requested service refund' }), api('POST', `/api/billing/orders/${o.orderNo}/refunds`, owner, { amount: 80, reason: 'Concurrent refund request' })]);
    expect(attempts.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect((await api('POST', `/api/billing/orders/${o.orderNo}/refunds`, other, { amount: 1, reason: 'Another customer' })).statusCode).toBe(404);
    expect((await api('GET', '/api/billing/refunds', other)).body).not.toContain(o.orderNo);
    expect((await api('GET', '/api/billing/statement.csv', other)).body).not.toContain(o.orderNo);
  });
  it('requires approval, verified receipt and explicit entitlement handling; never grants refunded orders', async () => {
    const o = await order('paid');
    const r = (await api('POST', `/api/billing/orders/${o.orderNo}/refunds`, owner, { amount: 100, reason: 'Paid but not delivered' })).json().refund;
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, owner, { version: 1, action: 'approve', note: 'Self-approve attempt' })).statusCode).toBe(403);
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, root, { version: 1, action: 'complete', note: 'Cannot skip review', receipt: 'receipt-1', entitlement: 'keep' })).statusCode).toBe(409);
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, root, { version: 1, action: 'approve', note: 'Reviewed provider transaction' })).statusCode).toBe(200);
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, root, { version: 2, action: 'complete', note: 'Missing receipt' })).statusCode).toBe(400);
    const payload = { version: 2, action: 'complete', note: 'Provider receipt verified; no fulfilled entitlement', receipt: 'receipt-1', entitlement: 'keep' };
    const complete = await api('PATCH', `/api/billing/refunds/${r.id}`, root, payload);
    expect(complete.statusCode, complete.body).toBe(200);
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, root, payload)).statusCode).toBe(409);
    await new PaymentsService({ config: ts.config, db: ts.db }).confirmOrder(o.orderNo);
    const [after] = await ts.db.orm.select().from(paymentOrders).where(eq(paymentOrders.id, o.id));
    expect(after!.status).toBe('refunded');
    expect((await api('GET', '/api/billing/statement.csv', owner)).body).toContain('100.00');
  });
  it('withdrawal releases reserved refundable amount', async () => {
    const o = await order();
    const r = (await api('POST', `/api/billing/orders/${o.orderNo}/refunds`, owner, { amount: 100, reason: 'Changed my mind' })).json().refund;
    expect((await api('PATCH', `/api/billing/refunds/${r.id}`, owner, { version: 1, action: 'cancel', note: 'Continue subscription' })).statusCode).toBe(200);
    expect((await api('POST', `/api/billing/orders/${o.orderNo}/refunds`, owner, { amount: 100, reason: 'New reviewed reason' })).statusCode).toBe(201);
  });
});

describe('support tickets', () => {
  it('isolates tickets, appends replies, and prevents lost updates', async () => {
    const created = await api('POST', '/api/support/tickets', owner, { subject: 'Billing assistance', body: 'Please check my payment status.' });
    expect(created.statusCode).toBe(201);
    const ticket = created.json().ticket;
    expect((await api('GET', `/api/support/tickets/${ticket.id}`, other)).statusCode).toBe(404);
    expect((await api('POST', `/api/support/tickets/${ticket.id}/messages`, other, { version: 1, body: 'Forged reply' })).statusCode).toBe(404);
    expect((await api('POST', `/api/support/tickets/${ticket.id}/messages`, root, { version: 1, body: 'We are reviewing this.', status: 'waiting_customer' })).statusCode).toBe(200);
    expect((await api('POST', `/api/support/tickets/${ticket.id}/messages`, owner, { version: 1, body: 'Stale reply', status: 'resolved' })).statusCode).toBe(409);
    const details = (await api('GET', `/api/support/tickets/${ticket.id}`, owner)).json();
    expect(details.messages).toHaveLength(2); expect(details.messages[1].staff).toBe(true);
  });
});

describe('team memberships', () => {
  it('binds invitations to an email, prevents replay and respects read-only and revocation across routes', async () => {
    await api('PUT', '/api/team', owner, { name: 'Owner team' });
    const invite = await api('POST', '/api/team/invites', owner, { email: 'reader@ops.test', role: 'reader' });
    expect(invite.statusCode).toBe(201);
    expect((await api('POST', '/api/team/accept', other, { token: invite.json().token })).statusCode).toBe(400);
    expect((await api('POST', '/api/team/accept', reader, { token: invite.json().token })).statusCode).toBe(200);
    expect((await api('POST', '/api/team/accept', reader, { token: invite.json().token })).statusCode).toBe(400);
    const shared = () => api('GET', '/api/sites/owned-site', reader, undefined, owner.operatorId);
    expect((await shared()).statusCode).toBe(200);
    expect((await api('GET', '/api/jobs', reader, undefined, owner.operatorId)).body).toContain('owned-site');
    expect((await api('GET', '/api/audit/export.csv', reader, undefined, owner.operatorId)).body).toContain('Owner private site');
    expect((await api('PATCH', '/api/sites/owned-site', reader, { label: 'Cannot rename' }, owner.operatorId)).statusCode).toBe(403);
    expect((await api('GET', '/api/billing/orders', reader, undefined, owner.operatorId)).statusCode).toBe(403);
    expect((await api('GET', '/api/sites/owned-site', other, undefined, owner.operatorId)).statusCode).toBe(403);
    const member = (await api('GET', '/api/team', owner)).json().members[0];
    expect((await api('PATCH', `/api/team/members/${member.id}`, other, { role: 'editor' })).statusCode).toBe(404);
    await api('PATCH', `/api/team/members/${member.id}`, owner, { role: 'editor' });
    expect((await api('PATCH', '/api/sites/owned-site', reader, { label: 'Team managed' }, owner.operatorId)).statusCode).toBe(200);
    await api('PATCH', `/api/team/members/${member.id}`, owner, { role: 'remove' });
    expect((await shared()).statusCode).toBe(403);
    expect((await api('GET', '/api/sites/owned-site', reader)).statusCode).toBe(404);
  });
});
