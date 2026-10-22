import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { operators, supportTickets, supportMessages, supportAssignments, supportInternalNotes, notifications, auditEvents } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import * as notificationService from '../src/notifications/service.js';
const input = { email: 'staff@support.test', canReply: false, canResolve: false, canNotes: false, days: 30 };
describe('delegated support and private notes', () => {
 let ts: TestServer, root: { operatorId: number; cookie: string }, customer: typeof root, staff: typeof root, other: typeof root, viewer: typeof root, ticketId: number, grantId: number;
 const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, who = root, workspace?: number) => ts.app.inject({ method, url, cookies: { rp_session: who.cookie }, ...(payload ? { payload } : {}), ...(workspace ? { headers: { 'x-workspace-id': String(workspace) } } : {}) });
 const base = () => `/api/support/tickets/${ticketId}`;
 const detail = async (who = root) => (await call('GET', base(), undefined, who)).json();
 const edit = (version: number, extra = {}) => call('POST', `${base()}/assignments/${grantId}`, { canReply: false, canResolve: false, canNotes: false, days: 30, version, ...extra });
 beforeAll(async () => {
  ts = await makeTestServer(); root = await ts.seedLogin({ email: 'root@support.test', password: 'long-test-password', role: 'root' }); customer = await ts.seedLogin({ email: 'customer@support.test', password: 'long-test-password', role: 'operator' }); staff = await ts.seedLogin({ email: input.email, password: 'long-test-password', role: 'operator' }); other = await ts.seedLogin({ email: 'other@support.test', password: 'long-test-password', role: 'operator' }); viewer = await ts.seedLogin({ email: 'viewer@support.test', password: 'long-test-password', role: 'viewer' });
  await ts.db.orm.update(operators).set({ emailVerifiedAt: null }).where(eq(operators.id, staff.operatorId));
  const r = await call('POST', '/api/support/tickets', { subject: 'Customer billing question', body: 'Customer conversation is explicitly delegated' }, customer); expect(r.statusCode).toBe(201); ticketId = r.json().ticket.id;
 });
 afterAll(async () => ts.close());
 it('requires a platform administrator and an existing verified ordinary account', async () => {
  for (const who of [customer, staff, other, viewer]) expect((await call('POST', base() + '/assignments', input, who)).statusCode).toBe(403);
  for (const email of [input.email, 'missing@support.test', 'root@support.test', 'customer@support.test']) expect((await call('POST', base() + '/assignments', { ...input, email })).statusCode).toBe(400);
  expect((await call('GET', base(), undefined, staff)).statusCode).toBe(404);
  await ts.db.orm.update(operators).set({ emailVerifiedAt: toPgTimestamp(new Date()) }).where(eq(operators.id, staff.operatorId));
  expect((await call('POST', base() + '/assignments', { ...input, canResolve: true })).statusCode).toBe(400);
  expect((await call('POST', base() + '/assignments', { ...input, days: 91 })).statusCode).toBe(400);
  const r = await call('POST', base() + '/assignments', input); expect(r.statusCode).toBe(201); grantId = r.json().item.id;
  expect((await call('POST', base() + '/assignments', input)).statusCode).toBe(409);
 });
 it('grants one conversation without customer identity, financial or workspace access', async () => {
  const r = await call('GET', base(), undefined, staff, 999999); expect(r.statusCode).toBe(200); expect(r.json().messages).toHaveLength(1); expect(r.body).not.toMatch(/operatorId|actorId|assignedBy|customer@|password|cookie/);
  expect(r.json().permissions).toMatchObject({ staff: true, canReply: false, canResolve: false, canNotes: false, canAssign: false });
  expect((await call('GET', '/api/support/assigned', undefined, staff)).json().tickets).toHaveLength(1);
  expect((await call('GET', '/api/support/tickets', undefined, staff)).json().tickets).toEqual([]);
  expect((await call('GET', '/api/services/catalog', undefined, staff)).json().sites).toEqual([]);
  expect((await call('GET', base(), undefined, other)).statusCode).toBe(404);
  expect((await call('POST', base() + '/messages', { version: 1, body: 'Read permission cannot reply' }, staff)).statusCode).toBe(403);
  expect((await call('GET', base() + '/assignments', undefined, staff)).statusCode).toBe(403);
 });
 it('keeps internal notes separate from customer messages and notification delivery', async () => {
  const before = await ts.db.orm.select().from(notifications);
  expect((await call('POST', base() + '/notes', { body: 'INTERNAL-SENSITIVE-NOTE' })).statusCode).toBe(201);
  for (const who of [customer, staff]) { expect((await call('GET', base() + '/notes', undefined, who)).statusCode).toBe(403); expect((await call('POST', base() + '/notes', { body: 'Forbidden note' }, who)).statusCode).toBe(403); }
  expect((await call('GET', base(), undefined, customer)).body).not.toContain('INTERNAL-SENSITIVE-NOTE'); expect((await ts.db.orm.select().from(notifications))).toHaveLength(before.length);
  expect((await detail()).ticket.version).toBe(1);
 });
 it('serializes permission edits and separately enables replies, closure and notes', async () => {
  const rs = await Promise.all([1, 2].map(() => edit(1, { canReply: true, canNotes: true }))); expect(rs.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect((await call('GET', base() + '/notes', undefined, staff)).body).toContain('INTERNAL-SENSITIVE-NOTE');
  expect((await call('POST', base() + '/notes', { body: 'Assigned staff investigation note' }, staff)).statusCode).toBe(201);
  expect((await call('POST', base() + '/messages', { version: 1, body: 'Cannot close without permission', status: 'resolved' }, staff)).statusCode).toBe(403);
  expect((await call('POST', base() + '/messages', { version: 1, body: 'Reviewed the customer question', status: 'waiting_customer' }, staff)).statusCode).toBe(200);
  const r = await detail(customer); expect(r.messages[1].staff).toBe(true); expect(r.ticket.status).toBe('waiting_customer'); expect(JSON.stringify(r)).not.toContain('investigation note');
  expect((await call('POST', base() + '/messages', { version: 2, body: 'Cannot impersonate support', status: 'waiting_customer' }, customer)).statusCode).toBe(403);
 });
 it('prevents lost replies and commits customer notifications atomically', async () => {
  const rs = await Promise.all([1, 2].map(n => call('POST', base() + '/messages', { version: 2, body: 'Customer-facing reply ' + n }, staff))); expect(rs.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const pending = await ts.db.orm.select().from(notifications); expect(pending.some(n => n.operatorId === customer.operatorId && n.dedupeKey === `ticket:${ticketId}:3:${customer.operatorId}`)).toBe(true); expect(pending.every(n => !n.body.includes('Customer-facing reply'))).toBe(true);
  const spy = vi.spyOn(notificationService, 'queueNotification').mockRejectedValueOnce(new Error('controlled queue failure'));
  try { expect((await call('POST', base() + '/messages', { version: 3, body: 'Must roll back on queue failure' }, staff)).statusCode).toBe(500); } finally { spy.mockRestore(); }
  const r = await detail(customer); expect(r.ticket.version).toBe(3); expect(r.messages).toHaveLength(3); expect(r.messages.some((m: { body: string }) => m.body.includes('roll back'))).toBe(false);
 });
 it('requires resolution permission to close or reopen resolved work', async () => {
  expect((await edit(2, { canReply: true, canResolve: true, canNotes: true })).statusCode).toBe(200);
  expect((await call('POST', base() + '/messages', { version: 3, body: 'Resolved after checking evidence', status: 'resolved' }, staff)).statusCode).toBe(200);
  expect((await edit(3, { canReply: true })).statusCode).toBe(200);
  expect((await call('POST', base() + '/messages', { version: 4, body: 'Cannot reopen closed work', status: 'open' }, staff)).statusCode).toBe(403);
  expect((await call('POST', base() + '/messages', { version: 4, body: 'Customer needs further assistance', status: 'open' }, customer)).statusCode).toBe(200);
  expect((await call('GET', base() + '/notes', undefined, staff)).statusCode).toBe(403);
 });
 it('paginates messages from newest backwards without losing history beyond 500', async () => {
  const values = Array.from({ length: 510 }, (_, n) => ({ ticketId, actorId: customer.operatorId, staff: false, body: 'Historical message ' + n })); await ts.db.orm.insert(supportMessages).values(values);
  let beforeId: number | undefined, count = 0, seen = new Set<number>();
  do {
   const r = (await call('GET', base() + (beforeId ? `?beforeId=${beforeId}` : ''), undefined, staff)).json(); expect(r.messages.length).toBeLessThanOrEqual(100);
   for (const m of r.messages) { expect(seen.has(m.id)).toBe(false); seen.add(m.id); count++; }
   expect(r.messages.map((m: { id: number }) => m.id)).toEqual(r.messages.map((m: { id: number }) => m.id).sort((a: number, b: number) => a - b));
   if (!r.hasMore) break; beforeId = r.messages[0].id;
  } while (count < 1000);
  expect(count).toBe(515);
 });
 it('paginates filtered ticket lists and rejects invalid cursors without broadening scope', async () => {
  await ts.db.orm.insert(supportTickets).values(Array.from({ length: 52 }, (_, n) => ({ operatorId: customer.operatorId, subject: 'Pagination fixture ' + n, updatedAt: '2026-10-01 01:02:03' })));
  const r = (await call('GET', '/api/support/tickets?q=Pagination', undefined, customer)).json(); expect(r.tickets).toHaveLength(50); expect(r.nextCursor).toBeTruthy();
  const next = (await call('GET', '/api/support/tickets?q=Pagination&cursor=' + r.nextCursor, undefined, customer)).json(); expect(next.tickets).toHaveLength(2); expect(next.nextCursor).toBeNull(); expect(new Set([...r.tickets, ...next.tickets].map(t => t.id)).size).toBe(52);
  expect((await call('GET', '/api/support/assigned?q=Pagination', undefined, staff)).json().tickets).toEqual([]);
  const invalid = Buffer.from(JSON.stringify({ at: '2026-99-99 99:99:99', id: 1 })).toString('base64url'); expect((await call('GET', '/api/support/tickets?cursor=' + invalid)).statusCode).toBe(400);
  expect((await call('GET', '/api/support/tickets?status=resolved', undefined, customer)).json().tickets).toEqual([]);
 });
 it('rejects expiry, revoked email verification, changed email, disabled issuer and customer', async () => {
  const denied = async () => { expect((await call('GET', base(), undefined, staff)).statusCode).toBe(404); expect((await call('GET', '/api/support/assigned', undefined, staff)).json().tickets).toEqual([]); };
  await ts.db.orm.update(supportAssignments).set({ expiresAt: toPgTimestamp(new Date(Date.now() - 1000)) }).where(eq(supportAssignments.id, grantId)); await denied(); expect((await edit(4, { canReply: true })).statusCode).toBe(200);
  await ts.db.orm.update(operators).set({ emailVerifiedAt: null }).where(eq(operators.id, staff.operatorId)); await denied(); await ts.db.orm.update(operators).set({ emailVerifiedAt: toPgTimestamp(new Date()) }).where(eq(operators.id, staff.operatorId));
  await ts.db.orm.update(operators).set({ email: 'changed@support.test' }).where(eq(operators.id, staff.operatorId)); await denied(); await ts.db.orm.update(operators).set({ email: input.email }).where(eq(operators.id, staff.operatorId));
  for (const op of [root, customer]) { await ts.db.orm.update(operators).set({ status: 'disabled' }).where(eq(operators.id, op.operatorId)); await denied(); await ts.db.orm.update(operators).set({ status: 'active' }).where(eq(operators.id, op.operatorId)); }
 });
 it('revokes reads, replies and notes immediately while retaining internal evidence', async () => {
  const r = await call('DELETE', `${base()}/assignments/${grantId}`); expect(r.statusCode).toBe(200);
  expect((await call('GET', base(), undefined, staff)).statusCode).toBe(404); expect((await call('POST', base() + '/messages', { version: 5, body: 'Revoked account reply' }, staff)).statusCode).toBe(404); expect((await call('POST', base() + '/notes', { body: 'Revoked note' }, staff)).statusCode).toBe(404);
  expect((await ts.db.orm.select().from(supportInternalNotes))).toHaveLength(2); expect((await call('GET', base() + '/notes')).json().items).toHaveLength(2);
  expect((await edit(5)).statusCode).toBe(409); expect((await call('POST', base() + '/assignments', input)).statusCode).toBe(201);
  const audits = await ts.db.orm.select().from(auditEvents); expect(audits.some(a => a.action === 'support.assignment_revoke')).toBe(true); expect(JSON.stringify(audits)).not.toContain('INTERNAL-SENSITIVE-NOTE');
 });
});
