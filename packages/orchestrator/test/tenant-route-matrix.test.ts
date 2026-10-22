import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EngineKind } from '@relay-panel/adapter-core';
import { makeTestServer, type TestServer } from './helpers.js';
import { auditEvents, jobs, operators, organizationMembers, sites } from '../src/db/schema.js';
import { beijingDay } from '../src/services/observations.js';
import { clearSiteCaches } from '../src/sites/service.js';

type Actor = { operatorId: number; cookie: string };
type Role = 'owner' | 'editor' | 'reader' | 'stranger' | 'editorPersonal' | 'forgedWorkspace' | 'root' | 'viewer' | 'anonymous';
type Request = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown };
type Fixture = { id: number; slug: string; jobId: number; workId: number; budgetId: number };
const roles: Role[] = ['owner', 'editor', 'reader', 'stranger', 'editorPersonal', 'forgedWorkspace', 'root', 'viewer', 'anonymous'];
const engines: EngineKind[] = ['sub2api', 'newapi'];
const readStatus: Record<Role, number> = { owner: 200, editor: 200, reader: 200, stranger: 404, editorPersonal: 404, forgedWorkspace: 403, root: 200, viewer: 200, anonymous: 401 };
const writeStatus: Record<Role, number> = { ...readStatus, reader: 403, viewer: 403 };
const budget = { name: 'Tenant budget marker', period: 'day', basis: 'charge', amountUsd: 20, warningPercent: 80, channelId: null, model: null, enabled: true, notify: false };

describe('tenant route matrix with authorized positive controls', () => {
  let ts: TestServer;
  const actors: Partial<Record<Role, Actor>> = {};
  const fixtures = {} as Record<EngineKind, Fixture>;
  function actor(role: Role) { return actors[role === 'editorPersonal' ? 'editor' : role === 'forgedWorkspace' ? 'stranger' : role]; }
  function request(role: Role, input: Request) {
    const who = actor(role);
    return ts.app.inject({ method: input.method ?? 'GET', url: input.url,
      ...(who ? { cookies: { rp_session: who.cookie } } : {}),
      ...(['editor', 'reader', 'forgedWorkspace'].includes(role) ? { headers: { 'x-workspace-id': String(actors.owner!.operatorId) } } : {}),
      ...(input.payload === undefined ? {} : { payload: input.payload }) });
  }
  const calls = () => engines.flatMap(engine => ts.adapters[engine].calls);
  const clearCalls = () => { for (const engine of engines) ts.adapters[engine].calls.length = 0; };
  function reads(s: Fixture): string[] {
    const day = beijingDay();
    return [
      `/api/sites/${s.slug}`, ...['channels', 'groups', 'users', 'branding', 'usage?days=1', 'audit', 'domains'].map(path => `/api/sites/${s.slug}/${path}`),
      `/api/jobs/${s.jobId}`, `/api/services/quality?siteId=${s.id}&day=${day}`, `/api/services/quality.csv?siteId=${s.id}&day=${day}`,
      ...['collection-settings', 'work', 'partners', 'publication', 'budgets'].map(path => `/api/services/${path}?siteId=${s.id}`),
      `/api/services/work/${s.workId}`, `/api/services/work/${s.workId}/export`,
      `/api/services/budgets/${s.budgetId}/report`, `/api/services/budgets/${s.budgetId}/report.csv`, `/api/services/budgets/${s.budgetId}/events`,
    ];
  }
  function writes(s: Fixture): Request[] {
    return [
      { method: 'PATCH', url: `/api/sites/${s.slug}`, payload: { label: 'Owner site marker' } },
      { method: 'PUT', url: `/api/sites/${s.slug}/branding`, payload: { announcement: 'Authorized branding change' } },
      { method: 'PATCH', url: `/api/sites/${s.slug}/channels/1`, payload: { enabled: true } },
      { method: 'PATCH', url: `/api/sites/${s.slug}/users/1`, payload: { status: 'active' } },
      { method: 'POST', url: `/api/sites/${s.slug}/domains`, payload: { domain: 'matrix.example.test' } },
      { method: 'DELETE', url: `/api/sites/${s.slug}/domains/matrix.example.test` },
      { method: 'POST', url: '/api/services/collection-settings', payload: { siteId: s.id, enabled: false } },
    ];
  }
  beforeAll(async () => {
    clearSiteCaches();
    ts = await makeTestServer();
    for (const role of ['owner', 'editor', 'reader', 'stranger', 'root', 'viewer'] as const) {
      actors[role] = await ts.seedLogin({ email: `${role}@tenant-matrix.test`, password: 'long-test-password', role: role === 'root' || role === 'viewer' ? role : 'operator' });
    }
    expect((await request('owner', { method: 'PUT', url: '/api/team', payload: { name: 'Owner workspace marker' } })).statusCode).toBe(200);
    for (const role of ['editor', 'reader'] as const) {
      const invite = await request('owner', { method: 'POST', url: '/api/team/invites', payload: { email: `${role}@tenant-matrix.test`, role } });
      expect(invite.statusCode).toBe(201);
      // Acceptance uses personal context before membership exists.
      const accepted = await ts.app.inject({ method: 'POST', url: '/api/team/accept', cookies: { rp_session: actors[role]!.cookie }, payload: { token: invite.json().token } });
      expect(accepted.statusCode).toBe(200);
    }
    for (const engine of engines) {
      const [site] = await ts.db.orm.insert(sites).values({ operatorId: actors.owner!.operatorId, slug: `matrix-${engine}`, label: 'Owner site marker', engine, version: '1', hostPort: 0, baseUrl: 'https://engine.example.test', managed: 'external', status: 'active' }).returning();
      const [job] = await ts.db.orm.insert(jobs).values({ kind: 'upgrade', siteId: site!.id, slug: site!.slug, status: 'succeeded', createdBy: 'owner@tenant-matrix.test' }).returning();
      await ts.db.orm.insert(auditEvents).values({ siteId: site!.id, actor: 'owner@tenant-matrix.test', action: 'matrix.owner-marker', ok: true });
      const work = await request('owner', { method: 'POST', url: '/api/services/work', payload: { siteId: site!.id, kind: 'incident', title: 'Owner case marker', description: 'Owner private case details' } });
      expect(work.statusCode).toBe(201);
      const policy = await request('owner', { method: 'POST', url: '/api/services/budgets', payload: { ...budget, siteId: site!.id } });
      expect(policy.statusCode).toBe(201);
      fixtures[engine] = { id: site!.id, slug: site!.slug, jobId: job!.id, workId: work.json().item.id, budgetId: policy.json().item.id };
      const state = ts.adapters[engine].stateFor(site!.slug);
      state.channels.push({ id: '1', name: 'Owner channel marker', protocol: 'openai', baseUrl: 'https://upstream.example.test', apiKey: 'UNIT-TEST-ONLY-KEY', models: ['test-model'], enabled: true });
      state.users.push({ id: '1', email: 'engine-user@example.test', role: 'user', status: 'active' });
    }
  });
  afterAll(async () => { clearSiteCaches(); await ts.close(); });

  for (const engine of engines) {
    describe(engine, () => {
      it.each(roles)('%s reads existing details, evidence and exports with the expected scope', async role => {
        for (const url of reads(fixtures[engine])) {
          clearCalls();
          const response = await request(role, { url });
          expect(response.statusCode, `${role} GET ${url}: ${response.body}`).toBe(readStatus[role]);
          expect(response.body).not.toContain('UNIT-TEST-ONLY-KEY');
          if (readStatus[role] !== 200) {
            expect(calls(), url).toEqual([]);
            expect(response.body).not.toMatch(/Owner (site|channel|case) marker|Owner private case details|Tenant budget marker/);
          }
        }
      });

      it.each(roles)('%s can only mutate permitted site resources', async role => {
        for (const input of writes(fixtures[engine])) {
          clearCalls();
          const before = await ts.db.orm.select().from(sites).where(eq(sites.id, fixtures[engine].id));
          const response = await request(role, input);
          expect(response.statusCode, `${role} ${input.method} ${input.url}: ${response.body}`).toBe(writeStatus[role]);
          if (writeStatus[role] !== 200) {
            expect(calls(), input.url).toEqual([]);
            expect(await ts.db.orm.select().from(sites).where(eq(sites.id, fixtures[engine].id))).toEqual(before);
          }
        }
      });

      it('keeps owner-only budget control separate from team editing', async () => {
        const input: Request = { method: 'POST', url: `/api/services/budgets/${fixtures[engine].budgetId}/evaluate`, payload: {} };
        for (const role of ['editor', 'reader', 'viewer'] as const) expect((await request(role, input)).statusCode, role).toBe(403);
        expect((await request('owner', input)).statusCode).toBe(200);
        expect((await request('root', input)).statusCode).toBe(200);
      });
    });
  }

  it('keeps aggregate catalogs, task histories and audit exports inside the selected workspace', async () => {
    for (const url of ['/api/services/catalog', '/api/jobs', '/api/audit/export.csv']) {
      for (const role of ['owner', 'editor', 'reader', 'root', 'viewer'] as const) {
        const r = await request(role, { url });
        if (role === 'viewer' && url.includes('audit')) { expect(r.statusCode).toBe(403); continue; }
        expect(r.statusCode, `${role} ${url}`).toBe(200); expect(r.body).toContain(url.includes('audit') ? 'Owner site marker' : 'matrix-sub2api');
      }
      for (const role of ['stranger', 'editorPersonal'] as const) {
        clearCalls(); const r = await request(role, { url }); expect(r.statusCode).toBe(200); expect(r.body).not.toMatch(/matrix-sub2api|matrix-newapi|Owner site marker/); expect(calls()).toEqual([]);
      }
    }
  });

  it('rechecks revoked membership and disabled workspace owners on subsequent detail/export/write requests', async () => {
    const s = fixtures.sub2api;
    const urls = [...reads(s), '/api/services/catalog', '/api/jobs', '/api/audit/export.csv'];
    await ts.db.orm.delete(organizationMembers).where(eq(organizationMembers.operatorId, actors.editor!.operatorId));
    for (const url of urls) expect((await request('editor', { url })).statusCode, url).toBe(403);
    expect((await request('editor', writes(s)[0]!)).statusCode).toBe(403);
    await ts.db.orm.update(operators).set({ status: 'disabled' }).where(eq(operators.id, actors.owner!.operatorId));
    try {
      clearCalls();
      for (const url of urls) expect((await request('reader', { url })).statusCode, url).toBe(403);
      expect((await request('owner', { url: `/api/sites/${s.slug}` })).statusCode).toBe(401);
      expect(calls()).toEqual([]);
    } finally { await ts.db.orm.update(operators).set({ status: 'active' }).where(eq(operators.id, actors.owner!.operatorId)); }
  });
});
