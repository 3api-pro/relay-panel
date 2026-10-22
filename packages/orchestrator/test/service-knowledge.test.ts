import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { makeTestServer, type TestServer } from './helpers.js';
import { operators, sites, organizationMembers, organizations, serviceDocuments, serviceDocumentVersions, auditEvents } from '../src/db/schema.js';
import { compatibilityFreshness, documentContentSchema, type DocumentContent } from '../src/services/knowledge-content.js';

const content: DocumentContent = { kind: 'guide', title: 'Safe customer setup', summary: 'Reviewed public summary', body: 'Configure your client using your own key. Never send it to support.', category: 'Getting started', compatibility: null };
const model: DocumentContent = { ...content, kind: 'model', compatibility: { model: 'example-model', protocol: 'responses', engineVersion: '', testedOn: null, evidence: '', capabilities: { streaming: 'unknown', tools: 'unknown', vision: 'unknown', json: 'unknown', reasoning: 'unknown', caching: 'unknown' } } };
describe('customer knowledge publishing', () => {
  let ts: TestServer, owner: { operatorId: number; cookie: string }, other: typeof owner, editor: typeof owner, reader: typeof owner, viewer: typeof owner;
  let siteId: number, foreignSite: number, documentId: number, documentToken: string, spaceToken: string;
  const base = '/api/services/knowledge';
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, who = owner, workspace?: number) => ts.app.inject({ method, url, cookies: { rp_session: who.cookie }, ...(payload ? { payload } : {}), ...(workspace ? { headers: { 'x-workspace-id': String(workspace) } } : {}) });
  const update = (body: unknown, who = owner, workspace?: number) => call('POST', `${base}/documents/${documentId}`, body, who, workspace);
  const publicUrl = () => `/public/help/${spaceToken}/${documentToken}`;
  beforeAll(async () => {
    ts = await makeTestServer();
    owner = await ts.seedLogin({ email: 'knowledge-owner@example.test', password: 'long-test-password', role: 'operator' });
    other = await ts.seedLogin({ email: 'knowledge-other@example.test', password: 'long-test-password', role: 'operator' });
    editor = await ts.seedLogin({ email: 'knowledge-editor@example.test', password: 'long-test-password', role: 'operator' });
    reader = await ts.seedLogin({ email: 'knowledge-reader@example.test', password: 'long-test-password', role: 'operator' });
    viewer = await ts.seedLogin({ email: 'knowledge-viewer@example.test', password: 'long-test-password', role: 'viewer' });
    const data = { engine: 'sub2api', version: '1', hostPort: 0, baseUrl: 'http://private-internal.test', status: 'active', managed: 'external', credentialRef: 'PRIVATE CREDENTIAL', notes: 'PRIVATE SITE NOTE' };
    siteId = (await ts.db.orm.insert(sites).values({ ...data, operatorId: owner.operatorId, slug: 'knowledge-own', label: 'Private internal label' }).returning())[0]!.id;
    foreignSite = (await ts.db.orm.insert(sites).values({ ...data, operatorId: other.operatorId, slug: 'knowledge-other', label: 'Other site' }).returning())[0]!.id;
    await ts.db.orm.insert(organizations).values({ ownerId: owner.operatorId, name: 'Owner workspace' });
    await ts.db.orm.insert(organizationMembers).values([{ ownerId: owner.operatorId, operatorId: editor.operatorId, role: 'editor' }, { ownerId: owner.operatorId, operatorId: reader.operatorId, role: 'reader' }]);
  });
  afterAll(async () => ts.close());
  it('enforces tenant boundaries, read-only roles and strict input', async () => {
    expect((await call('GET', `${base}/space?siteId=${siteId}`, undefined, other)).statusCode).toBe(404);
    expect((await call('POST', base + '/documents', { siteId, content }, other)).statusCode).toBe(404);
    for (const [who, workspace] of [[reader, owner.operatorId], [viewer, undefined]] as const) expect((await call('POST', base + '/documents', { siteId, content }, who, workspace)).statusCode).toBe(403);
    expect((await call('POST', base + '/documents', { siteId, content: { ...content, secret: 'no' } })).statusCode).toBe(400);
    const r = await call('POST', base + '/documents', { siteId, content }); expect(r.statusCode).toBe(201);
    documentId = r.json().item.id; documentToken = r.json().item.token;
    expect((await call('GET', `${base}/documents/${documentId}`, undefined, other)).statusCode).toBe(404);
    expect((await call('GET', `${base}/documents/${documentId}/history`, undefined, other)).statusCode).toBe(404);
  });
  it('allows editors to draft but reserves publication and site-wide disclosure to owners', async () => {
    const b = { siteId, version: 0, title: 'Customer help center', description: 'Only reviewed customer guidance', published: true };
    expect((await call('POST', base + '/space', b, editor, owner.operatorId)).statusCode).toBe(403);
    expect((await call('GET', `${base}/space?siteId=${siteId}`, undefined, editor, owner.operatorId)).json().canPublish).toBe(false);
    const space = await call('POST', base + '/space', b); expect(space.statusCode).toBe(200); spaceToken = space.json().item.token;
    expect((await call('POST', base + '/space', b)).statusCode).toBe(409);
    expect((await update({ action: 'save', version: 1, content: { ...content, body: 'PRIVATE DRAFT; not yet approved for customers' } }, editor, owner.operatorId)).statusCode).toBe(200);
    expect((await update({ action: 'publish', version: 2 }, editor, owner.operatorId)).statusCode).toBe(403);
    expect((await ts.app.inject({ url: publicUrl() })).statusCode).toBe(404);
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}` })).body).not.toContain(content.title);
  });
  it('publishes an immutable reviewed snapshot and leaves later drafts private', async () => {
    expect((await update({ action: 'save', version: 2, content })).statusCode).toBe(200);
    expect((await update({ action: 'publish', version: 3 })).statusCode).toBe(200);
    const r = await ts.app.inject({ url: publicUrl() }); expect(r.statusCode).toBe(200); expect(r.body).toContain(content.body);
    expect(r.body).not.toMatch(/PRIVATE|private-internal|Private internal|knowledge-owner/);
    expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['referrer-policy']).toBe('no-referrer'); expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await update({ action: 'save', version: 4, content: { ...content, title: 'PRIVATE NEW DRAFT', body: 'PRIVATE pending changed body' } })).statusCode).toBe(200);
    const after = await ts.app.inject({ url: publicUrl() }); expect(after.body).toContain(content.body); expect(after.body).not.toContain('PRIVATE');
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}?q=PRIVATE` })).body).not.toContain(content.title);
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}?q=customer` })).body).toContain(content.title);
  });
  it('serializes concurrent updates and does not silently publish a newer draft', async () => {
    const r = await Promise.all([1, 2].map(i => update({ action: 'save', version: 5, content: { ...content, title: 'Concurrent draft ' + i } })));
    expect(r.map(x => x.statusCode).sort()).toEqual([200, 409]);
    expect((await update({ action: 'publish', version: 5 })).statusCode).toBe(409);
    expect((await ts.app.inject({ url: publicUrl() })).body).not.toContain('Concurrent draft');
    expect((await ts.db.orm.select().from(serviceDocumentVersions).where(eq(serviceDocumentVersions.documentId, documentId)))).toHaveLength(6);
  });
  it('restores history as a new draft without replacing the public snapshot or history', async () => {
    expect((await update({ action: 'restore', version: 6, sourceVersion: 2 })).statusCode).toBe(200);
    const item = (await call('GET', `${base}/documents/${documentId}`)).json().item;
    expect(item.draft.body).toContain('PRIVATE DRAFT'); expect(item.published).toEqual(content); expect(item.publishedRevision).toBe(4);
    expect((await ts.app.inject({ url: publicUrl() })).body).not.toContain('PRIVATE');
    const history = (await call('GET', `${base}/documents/${documentId}/history`)).json().items;
    expect(history[0].version).toBe(7); expect(history[0].action).toBe('restore'); expect(history.at(-1).version).toBe(1);
    expect((await update({ action: 'restore', version: 7, sourceVersion: 99999 })).statusCode).toBe(404);
  });
  it('immediately retracts a document and preserves its editorial history', async () => {
    expect((await update({ action: 'unpublish', version: 7 }, editor, owner.operatorId)).statusCode).toBe(403);
    expect((await update({ action: 'unpublish', version: 7 })).statusCode).toBe(200);
    expect((await ts.app.inject({ url: publicUrl() })).statusCode).toBe(404);
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}` })).body).not.toContain(content.title);
    expect((await call('GET', `${base}/documents/${documentId}/history`)).json().items).toHaveLength(8);
  });
  it('escapes public HTML, treats search wildcards literally, and publishes only explicit model evidence', async () => {
    const c: DocumentContent = { ...model, title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)> safe text only', compatibility: { ...model.compatibility!, engineVersion: 'v1', testedOn: '2026-01-01', evidence: 'Manually tested streaming on the recorded engine version.', capabilities: { ...model.compatibility!.capabilities, streaming: 'supported' } } };
    expect((await update({ action: 'save', version: 8, content: c })).statusCode).toBe(200);
    expect((await update({ action: 'publish', version: 9 })).statusCode).toBe(200);
    const r = await ts.app.inject({ url: publicUrl() }); expect(r.body).not.toContain('<script>'); expect(r.body).toContain('&lt;script&gt;'); expect(r.body).toContain('未验证'); expect(r.body).toContain('超过 30 天'); expect(r.body).toContain('站长记录');
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}?q=%25` })).body).not.toContain('&lt;script&gt;');
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}?q=${'a'.repeat(101)}` })).statusCode).toBe(400);
    expect((await call('GET', `${base}/documents?siteId=${siteId}&kind=model`)).json().items).toHaveLength(1);
    expect(ts.adapters.sub2api.calls).toEqual([]);
  });
  it('revokes all public paths when the help center, owner or site becomes unavailable', async () => {
    await ts.db.orm.update(operators).set({ status: 'disabled' }).where(eq(operators.id, owner.operatorId));
    expect((await ts.app.inject({ url: publicUrl() })).statusCode).toBe(404);
    await ts.db.orm.update(operators).set({ status: 'active' }).where(eq(operators.id, owner.operatorId));
    await ts.db.orm.update(sites).set({ status: 'destroyed' }).where(eq(sites.id, siteId));
    expect((await ts.app.inject({ url: publicUrl() })).statusCode).toBe(404);
    await ts.db.orm.update(sites).set({ status: 'active' }).where(eq(sites.id, siteId));
    const b = { siteId, version: 1, title: 'Customer help center', description: '', published: false };
    expect((await call('POST', base + '/space', b)).statusCode).toBe(200);
    expect((await ts.app.inject({ url: publicUrl() })).statusCode).toBe(404);
    expect((await ts.app.inject({ url: `/public/help/${spaceToken}` })).statusCode).toBe(404);
  });
  it('paginates content and history without mixing sites and enforces the site storage bound', async () => {
    await ts.db.orm.insert(serviceDocuments).values(Array.from({ length: 499 }, (_, i) => ({ siteId, token: randomUUID(), draft: { ...content, title: 'Paged guide '+i } })));
    const first = (await call('GET', `${base}/documents?siteId=${siteId}`)).json();
    expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true);
    const next = (await call('GET', `${base}/documents?siteId=${siteId}&beforeId=${first.items.at(-1).id}`)).json();
    expect(next.items).toHaveLength(50); expect(next.items.every((r: { id: number }) => !first.items.some((f: { id: number }) => f.id === r.id))).toBe(true);
    expect((await call('POST', base + '/documents', { siteId, content })).statusCode).toBe(409);
    await ts.db.orm.insert(serviceDocumentVersions).values(Array.from({ length: 25 }, (_, i) => ({ documentId, version: 11 + i, action: 'save', content, actorId: owner.operatorId })));
    const h = (await call('GET', `${base}/documents/${documentId}/history`)).json(); expect(h.items).toHaveLength(20); expect(h.hasMore).toBe(true);
    const older = (await call('GET', `${base}/documents/${documentId}/history?beforeVersion=${h.items.at(-1).version}`)).json();
    expect(older.items).toHaveLength(15); expect(older.hasMore).toBe(false);
  });
  it('rejects forged cross-site document links, cross-origin writes and unauthenticated authoring', async () => {
    const s = (await call('POST', base + '/space', { siteId: foreignSite, version: 0, title: 'Another help center', description: '', published: true }, other)).json().item;
    expect((await ts.app.inject({ url: `/public/help/${s.token}/${documentToken}` })).statusCode).toBe(404);
    expect((await ts.app.inject({ method: 'POST', url: base + '/documents', payload: { siteId, content } })).statusCode).toBe(401);
    expect((await ts.app.inject({ method: 'POST', url: base + '/documents', cookies: { rp_session: owner.cookie }, headers: { origin: 'https://attacker.example' }, payload: { siteId, content } })).statusCode).toBe(403);
    const audit = await ts.db.orm.select().from(auditEvents);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE DRAFT'); expect(audit.filter(a => a.action.startsWith('knowledge.')).length).toBeGreaterThan(10);
  });
});
describe('model capability evidence', () => {
  it('keeps unknown capabilities unknown and requires evidence for any positive or negative claim', () => {
    expect(documentContentSchema.safeParse(model).success).toBe(true); expect(compatibilityFreshness(model)).toBe('unverified');
    for (const value of ['supported', 'unsupported'] as const) expect(documentContentSchema.safeParse({ ...model, compatibility: { ...model.compatibility, capabilities: { ...model.compatibility!.capabilities, tools: value } } }).success).toBe(false);
    expect(documentContentSchema.safeParse({ ...content, compatibility: model.compatibility }).success).toBe(false);
    expect(documentContentSchema.safeParse({ ...model, compatibility: null }).success).toBe(false);
  });
  it('rejects impossible and future dates, while separating recent from stale human records', () => {
    const c: DocumentContent = { ...model, compatibility: { ...model.compatibility!, engineVersion: 'v1', testedOn: '2026-01-01', evidence: 'Human verification with recorded results.', capabilities: { ...model.compatibility!.capabilities, tools: 'supported' } } };
    expect(documentContentSchema.safeParse(c).success).toBe(true);
    for (const testedOn of ['2026-02-30', '2999-01-01']) expect(documentContentSchema.safeParse({ ...c, compatibility: { ...c.compatibility, testedOn } }).success).toBe(false);
    expect(compatibilityFreshness(c, Date.parse('2026-01-02T00:00:00Z'))).toBe('recorded');
    expect(compatibilityFreshness(c, Date.parse('2026-03-01T00:00:00Z'))).toBe('review_due'); expect(compatibilityFreshness(content)).toBe(null);
  });
});
