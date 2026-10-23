import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, credentials, jobs, sites } from '../src/db/schema.js';
import { latestSnapshotCache } from '../src/sites/service.js';
import { makeTestServer, type TestServer } from './helpers.js';
let ts: TestServer, root: { cookie: string; operatorId: number }, owner: typeof root, other: typeof root, viewer: typeof root;
let seq = 0;
beforeAll(async () => {
  ts = await makeTestServer({ config: { deploymentMode: 'saas', localProvisionEnabled: false } });
  root = await ts.seedLogin({ email: 'root-remove@example.com', password: 'test-password', role: 'root' });
  owner = await ts.seedLogin({ email: 'owner-remove@example.com', password: 'test-password', role: 'operator' });
  other = await ts.seedLogin({ email: 'other-remove@example.com', password: 'test-password', role: 'operator' });
  viewer = await ts.seedLogin({ email: 'viewer-remove@example.com', password: 'test-password', role: 'viewer' });
}, 60_000);
afterAll(async () => { await ts.close(); });
async function seed(patch: Partial<typeof sites.$inferInsert> = {}) {
  const slug = `remove-${++seq}`;
  const [site] = await ts.db.orm.insert(sites).values({ operatorId: owner.operatorId, slug, label: 'Unused site', engine: 'sub2api', version: '1', hostPort: 19000 + seq, baseUrl: 'http://127.0.0.1:1', managed: 'compose', status: 'failed:compose-up', ...patch }).returning();
  return site!;
}
const row = async (id: number) => (await ts.db.orm.select().from(sites).where(eq(sites.id, id)))[0]!;
const remove = (site: typeof sites.$inferSelect, cookie = root.cookie, payload: object = { confirm: site.slug, preserveResources: true }) => ts.app.inject({ method: 'POST', url: `/api/sites/${site.slug}/remove`, cookies: { rp_session: cookie }, payload });

describe('panel-only site removal', () => {
  it('removes a failed install without Docker and keeps credentials/history, with an audit event', async () => {
    const site = await seed({ credentialRef: 'enc:retained-removal-test' });
    await ts.db.orm.insert(credentials).values({ ref: site.credentialRef, kind: 'engine-admin', ciphertext: 'retained-test-data' });
    await ts.db.orm.insert(jobs).values({ siteId: site.id, slug: site.slug, kind: 'destroy', status: 'failed', createdBy: 'root-remove@example.com', error: 'spawn docker ENOENT' });
    latestSnapshotCache.set(site.slug, { ok: false });
    const res = await remove(site);
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ slug: site.slug, removed: true });
    expect((await row(site.id)).status).toBe('destroyed');
    expect(await ts.db.orm.select().from(credentials).where(eq(credentials.ref, site.credentialRef))).toHaveLength(1);
    expect(await ts.db.orm.select().from(jobs).where(eq(jobs.slug, site.slug))).toHaveLength(1);
    const audit = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.siteId, site.id));
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ action: 'site.remove', ok: true, payload: { resourcesPreserved: true, previousStatus: 'failed:compose-up' } });
    expect(latestSnapshotCache.has(site.slug)).toBe(false);
    expect(ts.lifecycles.sub2api.calls).toEqual([]); expect(ts.adapters.sub2api.calls).toEqual([]);
  });
  it('allows an owner to disconnect a read-only external site without accessing its API', async () => {
    const site = await seed({ managed: 'external', readonly: true, status: 'active' });
    expect((await remove(site, owner.cookie)).statusCode).toBe(200);
    expect((await row(site.id)).status).toBe('destroyed'); expect(ts.adapters.sub2api.calls).toEqual([]);
  });
  it('requires exact confirmation and explicit resource preservation', async () => {
    const site = await seed();
    for (const payload of [{ confirm: 'wrong', preserveResources: true }, { confirm: site.slug }, { confirm: site.slug, preserveResources: false }]) {
      expect((await remove(site, root.cookie, payload)).statusCode).toBe(400);
    }
    expect((await row(site.id)).status).toBe(site.status);
  });
  it('enforces viewer and tenant isolation', async () => {
    const site = await seed();
    expect((await remove(site, viewer.cookie)).statusCode).toBe(403);
    expect((await remove(site, other.cookie)).statusCode).toBe(404);
    expect((await row(site.id)).status).toBe(site.status);
  });
  it.each(['queued', 'running', 'uncertain'])('blocks a %s job instead of hiding it', async status => {
    const site = await seed();
    await ts.db.orm.insert(jobs).values({ siteId: site.id, slug: site.slug, kind: 'provision', status, createdBy: 'root-remove@example.com' });
    const res = await remove(site); expect(res.statusCode).toBe(409); expect(res.json().message).toContain('任务');
    expect((await row(site.id)).status).toBe(site.status);
    expect(await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.siteId, site.id))).toHaveLength(0);
  });
  it('is idempotent and rejects lifecycle submissions that raced with removal', async () => {
    const site = await seed();
    expect((await remove(site)).statusCode).toBe(200); expect((await remove(site)).statusCode).toBe(200);
    expect(await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.siteId, site.id))).toHaveLength(1);
    await expect(ts.jobs.enqueue('destroy', site.slug, {}, 'root-remove@example.com', { siteId: site.id })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ts.db.orm.select().from(jobs).where(eq(jobs.slug, site.slug))).toHaveLength(0);
  });
});
