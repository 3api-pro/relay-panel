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
import { notifications, operators } from '../src/db/schema.js';
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
    const result = await performPanelBackup(ts.db, ts.config);
    const archive = await readFile(join(String(result.folder), String(result.file)));
    expect(createHash('sha256').update(archive).digest('hex')).toBe(result.sha256);
    const restored = await PGlite.create({ loadDataDir: new Blob([archive]) });
    try {
      const rows = await restored.query<{ email: string }>('SELECT email FROM operators WHERE id=$1', [account.operatorId]);
      expect(rows.rows[0]!.email).toBe('recovery@tests.example');
      const tables = await restored.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(tables.rows.at(-1)!.name).toBe('013_service_center.sql');
      expect((await restored.query('SELECT * FROM refund_requests')).rows).toEqual([]);
      expect((await restored.query('SELECT * FROM service_work')).rows).toEqual([]);
      expect((await restored.query('SELECT * FROM observation_source_rows')).rows).toEqual([]);
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
