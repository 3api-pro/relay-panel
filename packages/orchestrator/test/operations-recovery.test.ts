import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { performPanelBackup } from '../src/operations/backup.js';
import { estimateCharge } from '../src/finance/reconciliation.js';
import { notifications, operators, sites, quotaOperations, servicePartners, serviceAccess, settlementStatements, settlementShares, settlementReceipts, settlementEvents, jobs } from '../src/db/schema.js';
import { queueNotification, deliverNotifications } from '../src/notifications/service.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import type { UsageRecord } from '@relay-panel/adapter-core';

let ts: TestServer; let temp: string | undefined;
afterEach(async () => { await ts?.close(); if (temp) await rm(temp, { recursive: true, force: true }); temp = undefined; });
describe('recovery and financial evidence', () => {
  it('allows explicit maintenance archive exclusions but never core tables, wildcards or command flags', () => {
    expect(loadConfig({ RP_BACKUP_EXCLUDE_TABLES: 'public.ops_backup_old, public.ops_backup_old' }).backupExcludeTables).toEqual(['public.ops_backup_old']);
    for (const name of ['public.operators', 'public.*', '--schema-only', 'ops_backup_old', 'public.ops_backup_*']) {
      expect(() => loadConfig({ RP_BACKUP_EXCLUDE_TABLES: name })).toThrow();
    }
  });
  it('restores an online PGlite snapshot including new security and customer-operation tables', async () => {
    temp = await mkdtemp(join(tmpdir(), 'relay-recovery-'));
    ts = await makeTestServer({ config: { backupDirectory: temp } });
    const account = await ts.seedLogin({ email: 'recovery@tests.example', password: 'correct-password' });
    const [site] = await ts.db.orm.insert(sites).values({ operatorId: account.operatorId, slug: 'recovery-quota', label: 'Quota recovery', engine: 'sub2api', version: 'v1', hostPort: 0, managed: 'external', baseUrl: 'https://example.test' }).returning();
    await ts.db.orm.insert(quotaOperations).values({ siteId: site!.id, actorId: account.operatorId, userId: '7', siteFingerprint: 'fixture', change: { platform: 'anthropic', window: 'daily', limitUsd: 10 }, beforeLimits: [], requestedLimits: [{ platform: 'anthropic', dailyLimitUsd: 10, weeklyLimitUsd: null, monthlyLimitUsd: null }], status: 'uncertain', expiresAt: '2030-01-01', startedAt: '2026-01-01' });
    const [partner] = await ts.db.orm.insert(servicePartners).values({ siteId: site!.id, kind: 'supplier', name: 'Recovery supplier' }).returning();
    const [access] = await ts.db.orm.insert(serviceAccess).values({ siteId: site!.id, ownerId: account.operatorId, email: 'finance@tests.example', role: 'finance', inviteTokenHash: 'recovery-fixture', inviteExpiresAt: '2030-01-01', expiresAt: '2030-01-01' }).returning();
    const [statement] = await ts.db.orm.insert(settlementStatements).values({ siteId: site!.id, ownerId: account.operatorId, partnerId: partner!.id, partnerName: partner!.name, reference: 'RECOVERY-1', title: 'Recovery statement', direction: 'payable', currency: 'USD', fromDay: '2026-10-01', toDay: '2026-10-02', lines: [{ label: 'Usage', amount: '0.300001' }], total: '0.300001', status: 'issued', version: 4, internalNote: 'Private recovery note', createdBy: account.operatorId }).returning();
    const [share] = await ts.db.orm.insert(settlementShares).values({ statementId: statement!.id, accessId: access!.id, status: 'disputed', note: 'Retained response', sharedBy: account.operatorId }).returning();
    await ts.db.orm.insert(settlementReceipts).values({ statementId: statement!.id, ownerId: account.operatorId, amount: '0.100001', reference: 'RECEIPT-RECOVERY', method: 'Controlled fixture', receivedDay: '2026-10-02', recordedBy: account.operatorId, voidedAt: '2026-10-03', voidReason: 'Retained correction' });
    await ts.db.orm.insert(settlementEvents).values({ statementId: statement!.id, shareId: share!.id, actorId: account.operatorId, action: 'share.disputed', note: 'Retained response history' });
    await ts.db.orm.insert(jobs).values({kind:'upgrade',siteId:site!.id,slug:site!.slug,createdBy:'recovery@tests.example',status:'uncertain',leaseToken:'private-recovery-lease',leaseUntil:'2026-01-01',reviewVersion:2,error:'Interrupted by shutdown'});
    const result = await performPanelBackup(ts.db, ts.config);
    const archive = await readFile(join(String(result.folder), String(result.file)));
    expect(createHash('sha256').update(archive).digest('hex')).toBe(result.sha256);
    const restored = await PGlite.create({ loadDataDir: new Blob([archive]) });
    try {
      const rows = await restored.query<{ email: string }>('SELECT email FROM operators WHERE id=$1', [account.operatorId]);
      expect(rows.rows[0]!.email).toBe('recovery@tests.example');
      const tables = await restored.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(tables.rows.at(-1)!.name).toBe('021_job_execution_leases.sql');
      expect((await restored.query('SELECT total::text,version,internal_note FROM settlement_statements')).rows).toEqual([{total:'0.300001',version:4,internal_note:'Private recovery note'}]);
      expect((await restored.query('SELECT status,note FROM settlement_shares')).rows).toEqual([{status:'disputed',note:'Retained response'}]);
      expect((await restored.query('SELECT amount::text,void_reason FROM settlement_receipts')).rows).toEqual([{amount:'0.100001',void_reason:'Retained correction'}]);
      expect((await restored.query('SELECT action,note FROM settlement_events')).rows).toEqual([{action:'share.disputed',note:'Retained response history'}]);
      expect((await restored.query('SELECT status,lease_token,review_version FROM jobs')).rows).toEqual([{status:'uncertain',lease_token:'private-recovery-lease',review_version:2}]);
      expect((await restored.query('SELECT status,user_id,requested_limits FROM quota_operations')).rows[0]).toMatchObject({ status: 'uncertain', user_id: '7', requested_limits: [{ platform: 'anthropic', dailyLimitUsd: 10 }] });
      expect((await restored.query('SELECT * FROM refund_requests')).rows).toEqual([]);
      expect((await restored.query('SELECT * FROM service_work')).rows).toEqual([]);
      expect((await restored.query('SELECT * FROM observation_source_rows')).rows).toEqual([]);
      expect((await restored.query('SELECT role FROM service_access')).rows).toEqual([{role:'finance'}]);
      expect((await restored.query('SELECT * FROM service_assignments')).rows).toEqual([]);
      expect((await restored.query('SELECT * FROM service_messages')).rows).toEqual([]);
      for (const table of ['service_documents', 'service_document_versions', 'service_knowledge_spaces', 'budget_policies', 'budget_events', 'finance_scopes', 'finance_submissions', 'support_assignments', 'support_internal_notes']) expect((await restored.query('SELECT * FROM '+table)).rows).toEqual([]);
    } finally { await restored.close(); }
    const ops = await ts.app.inject({ url: '/api/admin/operations', cookies: { rp_session: account.cookie } });
    expect(ops.json().backupOverdue).toBe(false);
  });
  it('respects delivery preferences, retries failed SMTP, and never exposes security mail bodies', async () => {
    ts = await makeTestServer({ config: { smtp: { host: 'smtp.example.test', port: 465, from: 'noreply@example.test', secure: true } } });
    const account = await ts.seedLogin({ email: 'mail@tests.example', password: 'correct-password' });
    await ts.app.inject({ method: 'PUT', url: '/api/notifications/preferences', cookies: { rp_session: account.cookie }, payload: { alerts: false, billing: false, support: false } });
    for (const category of ['alerts', 'security'] as const) await queueNotification(ts.db, ts.config, { operatorId: account.operatorId,
      category, key: category, subject: 'Test subject', body: 'Public inbox record', ...(category === 'security' ? { privateMail: 'private-link-material' } : {}) });
    // Make the messages due explicitly; inserts and delivery can share the same millisecond.
    await ts.db.orm.update(notifications).set({ nextAttemptAt: toPgTimestamp(new Date(Date.now() - 1000)) });
    await deliverNotifications(ts.db, ts.config, async () => { throw new Error('unavailable'); });
    const rows = await ts.db.orm.select().from(notifications);
    expect(rows.find(x => x.category === 'alerts')!.status).toBe('skipped');
    expect(rows.find(x => x.category === 'security')!.status).toBe('pending');
    await ts.db.orm.update(notifications).set({ nextAttemptAt: toPgTimestamp(new Date(Date.now() - 1000)) }).where(eq(notifications.category, 'security'));
    const bodies: string[] = [];
    await deliverNotifications(ts.db, ts.config, async (_transport, mail) => { bodies.push(mail.text); });
    expect(bodies).toEqual(['private-link-material']);
    expect((await ts.db.orm.select().from(notifications)).find(x => x.category === 'security')!.mailCiphertext).toBeNull();
  });
  it('uses historical rates only in their user/model/time scope and marks conflicting evidence unknown', () => {
    const e: UsageRecord = { id: '1', requestId: 'req-1', createdAt: '2026-10-20T12:00:00Z', model: 'model-a', userId: '7', accountId: '2', subscriptionId: null,
      billingType: 'balance', activity: 100, actualCost: 0, totalCost: 10, rateMultiplier: 1, accountRateMultiplier: 1,
      accountStatsCost: 3, accountCost: 3, costUnit: 'USD', settlementProof: 'unavailable' };
    const rate = { voidedAt: null, voidReason: null, id: 1, siteId: 1, userId: '7', model: 'model-a', fromAt: '2026-10-20 00:00:00', toAt: '2026-10-21 00:00:00', multiplier: 0.5, note: 'Historical contract', createdAt: '2026-10-20 00:00:00' };
    expect(estimateCharge(e, [rate])).toEqual({ expected: 5, gap: 5, basis: 'historical_rate:1' });
    expect(estimateCharge({ ...e, userId: '8' }, [rate]).expected).toBe(10);
    expect(estimateCharge(e, [rate, { ...rate, id: 2 }]).expected).toBeNull();
    expect(estimateCharge({ ...e, billingType: 'subscription' }, [rate]).gap).toBeNull();
    expect(estimateCharge({ ...e, actualCost: null }, [rate]).gap).toBeNull();
  });
});
