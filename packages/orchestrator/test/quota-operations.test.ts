import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PlatformQuota } from '@relay-panel/adapter-core';
import { makeTestServer, type TestServer } from './helpers.js';
import { sites, quotaOperations, auditEvents } from '../src/db/schema.js';
vi.setConfig({ testTimeout: 30_000 });
const quota = (platform = 'anthropic', limit: number | null = 100, usage = 7): PlatformQuota => ({ platform, daily: { limitUsd: limit, usageUsd: usage }, weekly: { limitUsd: null, usageUsd: 12 }, monthly: { limitUsd: 400, usageUsd: 33 } });
const change: { platform: string; window: 'daily'; limitUsd: number | null } = { platform: 'anthropic', window: 'daily', limitUsd: 20 };
describe('durable quota operations', () => {
  let ts: TestServer, cookie: string, actor: number, otherCookie: string, userCookie: string, seq = 0;
  beforeAll(async () => {
    ts = await makeTestServer({ config: { riskEnforce: true } });
    ({ cookie, operatorId: actor } = await ts.seedLogin({ email: 'quota-root@example.com', password: 'password123', role: 'root' }));
    ({ cookie: otherCookie } = await ts.seedLogin({ email: 'quota-other@example.com', password: 'password123', role: 'root' }));
    ({ cookie: userCookie } = await ts.seedLogin({ email: 'quota-user@example.com', password: 'password123', role: 'operator' }));
  }, 60_000);
  afterAll(async () => { await ts.close(); });
  async function site() {
    const slug = `quota-${++seq}`;
    const [s] = await ts.db.orm.insert(sites).values({ slug, operatorId: actor, label: slug, engine: 'sub2api', version: 'v1', status: 'active', managed: 'external', hostPort: 0, baseUrl: 'http://localhost:9999' }).returning();
    ts.adapters.sub2api.setPlatformQuotas(slug, '7', [quota(), quota('openai', 0)]);
    return s!;
  }
  const call = (url: string, payload?: unknown, auth = cookie, method: 'GET' | 'POST' = 'POST') => ts.app.inject({ method, url, cookies: { rp_session: auth }, ...(payload === undefined ? {} : { payload }) });
  const preview = async (slug: string, body = change) => {
    const r = await call(`/api/risk/users/${slug}/7/quota-preview`, body); expect(r.statusCode, r.body).toBe(200); return r.json();
  };
  const apply = (slug: string, id: number, auth = cookie) => call(`/api/risk/users/${slug}/7/enforce`, { operationId: id, acknowledgeScope: true }, auth);
  const writes = () => ts.adapters.sub2api.calls.filter(c => c.startsWith('users.setPlatformQuotas')).length;
  const age = async (id: number, minutes = 6) => ts.db.orm.update(quotaOperations).set({ startedAt: new Date(Date.now() - minutes * 60_000).toISOString() }).where(eq(quotaOperations.id, id));
  function intercept(mode: 'timeout-after' | 'timeout-before' | 'mismatch') {
    const original = ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    return vi.spyOn(ts.adapters.sub2api, 'connect').mockImplementation(async (...args) => {
      const c = await original(...args), set = c.users.setPlatformQuotas!;
      c.users.setPlatformQuotas = async (id, rows) => {
        if (mode !== 'timeout-before') await set(id, rows);
        if (mode === 'mismatch') { ts.adapters.sub2api.setPlatformQuotas(args[0].siteSlug, id, [quota('anthropic', 30)]); return []; }
        throw new Error('private engine response must not escape');
      };
      return c;
    });
  }
  it('binds preview, preserves unrelated windows and usage, independently reads back and never repeats a successful write', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    expect(p.semantics).toMatchObject({ subscriptionCovered: false, monthly: 'rolling-30-days', inferenceProbe: false });
    expect(p.operation).not.toHaveProperty('siteFingerprint');
    const r = await apply(s.slug, p.operation.id); expect(r.statusCode).toBe(200); expect(r.json().operation.status).toBe('verified');
    expect(r.json().quotas[0]).toMatchObject({ daily: { limitUsd: 20, usageUsd: 7 }, weekly: { limitUsd: null, usageUsd: 12 } });
    expect(r.json().quotas[1].daily.limitUsd).toBe(0);
    expect((await apply(s.slug, p.operation.id)).json().operation.status).toBe('verified'); expect(writes()).toBe(count + 1);
    expect(ts.adapters.sub2api.calls.filter(c => c === `users.getPlatformQuotas:${s.slug}`).length).toBe(3);
    const audits = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.siteId, s.id));
    expect(audits.map(a => a.action)).toEqual(['risk.quota.started', 'risk.quota.verified']);
    expect(JSON.stringify(audits)).not.toContain('usageUsd');
  });
  it('rejects raw writes, missing acknowledgement, another actor and another target', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    expect((await call(`/api/risk/users/${s.slug}/7/enforce`, change)).statusCode).toBe(400);
    expect((await call(`/api/risk/users/${s.slug}/7/enforce`, { operationId: p.operation.id, acknowledgeScope: false })).statusCode).toBe(400);
    expect((await apply(s.slug, p.operation.id, otherCookie)).statusCode).toBe(404);
    expect((await call(`/api/risk/users/${s.slug}/8/enforce`, { operationId: p.operation.id, acknowledgeScope: true })).statusCode).toBe(404);
    expect(writes()).toBe(count);
  });
  it('blocks expired previews, readonly changes, switched targets and disabled writes', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    await ts.db.orm.update(quotaOperations).set({ expiresAt: '2001-01-01' }).where(eq(quotaOperations.id, p.operation.id));
    expect((await apply(s.slug, p.operation.id)).statusCode).toBe(409);
    const fresh = await preview(s.slug);
    await ts.db.orm.update(sites).set({ readonly: true }).where(eq(sites.id, s.id));
    expect((await apply(s.slug, fresh.operation.id)).statusCode).toBe(403);
    await ts.db.orm.update(sites).set({ readonly: false, baseUrl: 'http://localhost:9998' }).where(eq(sites.id, s.id));
    expect((await apply(s.slug, fresh.operation.id)).statusCode).toBe(409);
    ts.config.riskEnforce = false;
    try { expect((await apply(s.slug, fresh.operation.id)).statusCode).toBe(403); } finally { ts.config.riskEnforce = true; }
    expect(writes()).toBe(count);
  });
  it('configuration drift conflicts without PUT, while increasing usage alone does not invalidate a preview', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    ts.adapters.sub2api.setPlatformQuotas(s.slug, '7', [quota('anthropic', 50)]);
    expect((await apply(s.slug, p.operation.id)).json().operation.status).toBe('conflict'); expect(writes()).toBe(count);
    const fresh = await preview(s.slug);
    ts.adapters.sub2api.setPlatformQuotas(s.slug, '7', [quota('anthropic', 50, 25)]);
    expect((await apply(s.slug, fresh.operation.id)).json().operation.status).toBe('verified');
  });
  it('a timeout after write leaves a fence; later read-only review recovers without a second PUT', async () => {
    const s = await site(), p = await preview(s.slug), spy = intercept('timeout-after');
    const r = await apply(s.slug, p.operation.id); spy.mockRestore();
    expect(r.json().operation.status).toBe('uncertain'); expect(r.body).not.toContain('private engine');
    const second = await preview(s.slug), count = writes();
    expect((await apply(s.slug, second.operation.id)).statusCode).toBe(409);
    expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/review`, {})).statusCode).toBe(409);
    await age(p.operation.id);
    expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/review`, {})).json().operation.status).toBe('verified');
    expect(writes()).toBe(count);
  });
  it('read-back mismatch stays uncertain; resolution requires fresh matching evidence and explicit acknowledgement', async () => {
    const s = await site(), p = await preview(s.slug), spy = intercept('mismatch');
    expect((await apply(s.slug, p.operation.id)).json().operation.status).toBe('uncertain'); spy.mockRestore();
    await age(p.operation.id);
    const review = await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/review`, {}), fingerprint = review.json().operation.observedFingerprint, count = writes();
    const body = { observedFingerprint: fingerprint, note: 'Confirmed current configuration and no pending request', acknowledgeNoPending: true };
    expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/resolve`, { ...body, acknowledgeNoPending: false })).statusCode).toBe(400);
    ts.adapters.sub2api.setPlatformQuotas(s.slug, '7', [quota('anthropic', 31)]);
    expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/resolve`, body)).statusCode).toBe(409);
    const current = await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/review`, {});
    expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/resolve`, { ...body, observedFingerprint: current.json().operation.observedFingerprint })).json().operation.status).toBe('resolved');
    expect(writes()).toBe(count);
    expect((await apply(s.slug, p.operation.id)).statusCode).toBe(409);
  });
  it('journal/audit failure before upstream work prevents any engine write', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    await ts.db.exec("CREATE FUNCTION quota_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='risk.quota.started' THEN RAISE EXCEPTION 'test durable intent failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER quota_test_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION quota_test_failure();");
    try { expect((await apply(s.slug, p.operation.id)).statusCode).toBe(500); } finally { await ts.db.exec('DROP TRIGGER quota_test_trigger ON audit_events; DROP FUNCTION quota_test_failure();'); }
    expect(writes()).toBe(count);
    const [o] = await ts.db.orm.select().from(quotaOperations).where(eq(quotaOperations.id, p.operation.id)); expect(o!.status).toBe('preview');
  });
  it('removing the final limit verifies an omitted all-unlimited platform', async () => {
    const s = await site(), unlimited = quota(); unlimited.weekly.limitUsd = null; unlimited.monthly.limitUsd = null;
    ts.adapters.sub2api.setPlatformQuotas(s.slug, '7', [unlimited]);
    const p = await preview(s.slug, { ...change, limitUsd: null });
    const original = ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    const spy = vi.spyOn(ts.adapters.sub2api, 'connect').mockImplementation(async (...args) => {
      const c = await original(...args);
      c.users.setPlatformQuotas = async (id, rows) => { expect(rows[0]).toMatchObject({ dailyLimitUsd: null, weeklyLimitUsd: null, monthlyLimitUsd: null }); ts.adapters.sub2api.setPlatformQuotas(args[0].siteSlug, id, []); return []; };
      return c;
    });
    try { expect((await apply(s.slug, p.operation.id)).json().operation.status).toBe('verified'); } finally { spy.mockRestore(); }
  });
  it('incomplete upstream snapshots refuse preview and never turn a missing field into unlimited', async () => {
    const s = await site(), broken = quota(); delete (broken.daily as Partial<typeof broken.daily>).limitUsd;
    ts.adapters.sub2api.setPlatformQuotas(s.slug, '7', [broken]);
    const count = writes(), r = await call(`/api/risk/users/${s.slug}/7/quota-preview`, change);
    expect(r.statusCode).toBe(502); expect(writes()).toBe(count);
    expect(await ts.db.orm.select().from(quotaOperations).where(eq(quotaOperations.siteId, s.id))).toHaveLength(0);
  });
  it('failure recording a completed write stays fenced and can be reviewed after restart with writes disabled', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    await ts.db.exec("CREATE FUNCTION quota_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='risk.quota.verified' THEN RAISE EXCEPTION 'test final audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER quota_test_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION quota_test_failure();");
    try { expect((await apply(s.slug, p.operation.id)).json().operation.status).toBe('uncertain'); } finally { await ts.db.exec('DROP TRIGGER quota_test_trigger ON audit_events; DROP FUNCTION quota_test_failure();'); }
    expect(writes()).toBe(count + 1); await age(p.operation.id);
    ts.config.riskEnforce = false;
    try { expect((await call(`/api/risk/quotas/${s.slug}/${p.operation.id}/review`, {})).json().operation.status).toBe('verified'); } finally { ts.config.riskEnforce = true; }
    expect(writes()).toBe(count + 1);
  });
  it('non-root cannot preview, read history, apply or review even their own site', async () => {
    const s = await site(), p = await preview(s.slug), count = writes();
    for (const [path, body, method] of [[`/users/${s.slug}/7/quota-preview`, change, 'POST'], [`/users/${s.slug}/7/enforce`, { operationId: p.operation.id, acknowledgeScope: true }, 'POST'], [`/quotas/${s.slug}/history`, undefined, 'GET'], [`/quotas/${s.slug}/${p.operation.id}/review`, {}, 'POST'], [`/quotas/${s.slug}/${p.operation.id}/resolve`, {}, 'POST']] as const) expect((await call('/api/risk' + path, body, userCookie, method)).statusCode).toBe(403);
    expect(writes()).toBe(count);
  });
});
