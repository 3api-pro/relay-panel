import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, unlink, rename, symlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq, sql } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { appSettings, backupChecks, backupRuns } from '../src/db/schema.js';
import { performPanelBackup, reconcileBackupRecords } from '../src/operations/backup.js';
import { verifyBackup } from '../src/operations/backupCatalog.js';
import * as files from '../src/operations/backupFiles.js';

let ts: TestServer, directory: string, root: { cookie: string }, owner: { cookie: string };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const api = (method: 'GET'|'POST', path: string, body?: unknown, actor = root) => ts.app.inject({ method, url: '/api/admin/operations'+path, cookies: { rp_session: actor.cookie }, ...(body === undefined ? {} : { payload: body }) });
const create = () => performPanelBackup(ts.db, ts.config, 'catalog-root@example.test');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rp-backup-catalog-'));
  ts = await makeTestServer({ config: { backupDirectory: directory } });
  root = await ts.seedLogin({ email: 'catalog-root@example.test', password: 'test-password' });
  owner = await ts.seedLogin({ email: 'catalog-owner@example.test', password: 'test-password', role: 'operator' });
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await ts.db.orm.delete(appSettings).where(eq(appSettings.key, 'operations_backup_lease'));
  await ts.db.orm.update(backupRuns).set({ status: 'interrupted' }).where(eq(backupRuns.status, 'running'));
  await ts.db.orm.update(backupChecks).set({ status: 'interrupted' }).where(eq(backupChecks.status, 'running'));
});
afterAll(async () => { await ts.close(); await rm(directory, { recursive: true, force: true }); });

describe('panel backup catalog and file verification', () => {
  it('records immutable archive and manifest checksums without exposing private leases or archive contents', async () => {
    const result = await create();
    const verified = await api('POST', `/backups/${result.backupId}/verify`);
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ check: { status: 'verified', observedBytes: result.bytes, observedSha256: result.sha256 }, recoveryVerified: false, offMachineCopyVerified: false });
    const page = await api('GET', '/backups?limit=1');
    expect(page.json().backups[0]).toMatchObject({ id: result.backupId, status: 'succeeded', lastCheck: { status: 'verified' } });
    expect(page.body).not.toMatch(/leaseToken|leaseUntil|passwordHash|ciphertext/);
    expect(page.body).not.toContain(directory);
    expect((await stat(join(String(result.folder), String(result.file)))).size).toBe(result.bytes);
  });
  it('retains a previous successful backup when the latest attempt fails', async () => {
    const previous = await create();
    vi.spyOn(ts.db, 'snapshot').mockRejectedValueOnce(new Error('PRIVATE raw database failure'));
    await expect(create()).rejects.toMatchObject({ statusCode: 503 });
    const summary = (await api('GET', '')).json();
    expect(summary).toMatchObject({ backup: { status: 'failed' }, backupOverdue: false, latestSuccessfulBackup: { id: previous.backupId, status: 'succeeded' } });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
    const history = (await api('GET', '/backups?limit=2')).json();
    expect(history.backups.map((r: { status: string }) => r.status)).toEqual(['failed','succeeded']);
  });
  it('computes backup freshness using database time regardless of the application timezone', async () => {
    const result = await create(), previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      await ts.db.orm.update(backupRuns).set({ completedAt: sql`clock_timestamp()-interval '23 hours'` }).where(eq(backupRuns.id, Number(result.backupId)));
      expect((await api('GET', '')).json().backupOverdue).toBe(false);
      await ts.db.orm.update(backupRuns).set({ completedAt: sql`clock_timestamp()-interval '25 hours'` }).where(eq(backupRuns.id, Number(result.backupId)));
      expect((await api('GET', '')).json().backupOverdue).toBe(true);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
  });
  it('allows only root to inspect or verify backups and rejects arbitrary paths', async () => {
    const result = await create();
    for (const [method,path] of [['GET','/backups'],['GET',`/backups/${result.backupId}/checks`],['POST',`/backups/${result.backupId}/verify`]] as const) {
      expect((await api(method, path, undefined, owner)).statusCode).toBe(403);
    }
    expect((await api('POST', `/backups/${result.backupId}/verify`, { path: '/etc/passwd' })).statusCode).toBe(400);
    expect((await api('GET', '/backups?status=anything')).statusCode).toBe(400);
    expect((await api('GET', '/backups?beforeId=-1')).statusCode).toBe(400);
    expect((await api('POST', '/backups/2147483647/verify')).statusCode).toBe(404);
  });
  it('distinguishes an archive mismatch from a missing archive while retaining creation history', async () => {
    const result = await create(), path = join(String(result.folder), String(result.file));
    const original = await readFile(path);
    await writeFile(path, Buffer.from('modified archive'));
    expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root')).check.status).toBe('mismatch');
    await unlink(path);
    expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root')).check.status).toBe('missing');
    await writeFile(path, original);
    expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root')).check.status).toBe('verified');
    const history = (await api('GET', `/backups/${result.backupId}/checks?limit=2`)).json();
    expect(history.checks.map((r: { status: string }) => r.status)).toEqual(['verified','missing']);
    expect(history.hasMore).toBe(true);
    expect((await api('GET', `/backups/${result.backupId}/checks?beforeId=${history.checks.at(-1).id}`)).json().checks[0].status).toBe('mismatch');
  });
  it('anchors the manifest independently of the archive checksum', async () => {
    const result = await create(), manifest = join(String(result.folder), 'manifest.json');
    const original = await readFile(manifest);
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(original.toString()), sha256: '0'.repeat(64) }));
    expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root')).check.status).toBe('mismatch');
  });
  it('refuses symlink archives and folders without reading their target', async () => {
    const result = await create(), path = join(String(result.folder), String(result.file));
    const secret = join(directory, 'private-outside-file'); await writeFile(secret, 'PRIVATE_EXTERNAL_CONTENT');
    await rename(path, path+'.original'); await symlink(secret, path);
    const checked = await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root');
    expect(checked.check.status).toBe('unavailable'); expect(JSON.stringify(checked)).not.toContain('PRIVATE_EXTERNAL');
    await unlink(path); await rename(path+'.original', path);
    const folder = String(result.folder); await rename(folder, folder+'.original'); await symlink(folder+'.original', folder, 'dir');
    expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'root')).check.status).toBe('unavailable');
    await unlink(folder); await rename(folder+'.original', folder);
    expect(await readFile(secret, 'utf8')).toBe('PRIVATE_EXTERNAL_CONTENT');
  });
  it('serializes backup creation before invoking a second snapshot', async () => {
    const gate = deferred(), entered = deferred(), snapshot = ts.db.snapshot!;
    const spy = vi.spyOn(ts.db, 'snapshot').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return snapshot(); });
    const first = create(); await entered.promise;
    try { await expect(create()).rejects.toMatchObject({ statusCode: 409 }); expect(spy).toHaveBeenCalledTimes(1); }
    finally { gate.resolve(); await first; }
  });
  it('renews a long snapshot using database time without permitting a second backup', async () => {
    const gate = deferred(), entered = deferred(), snapshot = ts.db.snapshot!;
    vi.spyOn(ts.db, 'snapshot').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return snapshot(); });
    const active = create(); await entered.promise;
    const lease = async () => (await ts.db.orm.select().from(appSettings).where(eq(appSettings.key, 'operations_backup_lease')))[0]!.value.until as number;
    const first = await lease();
    try {
      await vi.waitFor(async () => expect(await lease()).toBeGreaterThan(first), { timeout: 35_000, interval: 300 });
      await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    } finally { gate.resolve(); await active; }
  }, 45_000);
  it('refuses overlapping checks and prevents an expired checker from overwriting newer evidence', async () => {
    const result = await create(), gate = deferred(), entered = deferred(), inspect = files.inspectBackupFile;
    vi.spyOn(files, 'inspectBackupFile').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return inspect(...args); });
    const first = verifyBackup(ts.db, ts.config, Number(result.backupId), 'first');
    const firstResult = first.then(() => null, error => error);
    await entered.promise;
    try {
      await expect(verifyBackup(ts.db, ts.config, Number(result.backupId), 'second')).rejects.toMatchObject({ statusCode: 409 });
      await ts.db.orm.update(backupChecks).set({ leaseUntil: '2020-01-01' }).where(eq(backupChecks.backupId, Number(result.backupId)));
      expect((await verifyBackup(ts.db, ts.config, Number(result.backupId), 'second')).check.status).toBe('verified');
    } finally { gate.resolve(); }
    expect(await firstResult).toMatchObject({ statusCode: 409 });
    const history = (await api('GET', `/backups/${result.backupId}/checks`)).json().checks;
    expect(history.map((r: { status: string }) => r.status)).toEqual(['verified','interrupted']);
  });
  it('does not publish a successful verification if its audit transaction fails', async () => {
    const result = await create();
    await ts.db.exec("CREATE FUNCTION reject_backup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='operations.backup.verify' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_backup_audit_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_backup_audit();");
    try { expect((await api('POST', `/backups/${result.backupId}/verify`)).statusCode).toBe(500); }
    finally { await ts.db.exec('DROP TRIGGER reject_backup_audit_trigger ON audit_events; DROP FUNCTION reject_backup_audit();'); }
    const row = (await api('GET', `/backups/${result.backupId}/checks`)).json().checks[0];
    expect(row.status).toBe('running'); expect(row.completedAt).toBeNull();
  });
  it('preserves interrupted records and ignores late snapshot completion after ownership loss', async () => {
    const gate = deferred(), entered = deferred(), snapshot = ts.db.snapshot!;
    vi.spyOn(ts.db, 'snapshot').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return snapshot(); });
    const active = create(); const outcome = active.then(() => null, error => error); await entered.promise;
    await ts.db.orm.update(backupRuns).set({ leaseUntil: '2020-01-01' }).where(eq(backupRuns.status, 'running'));
    await reconcileBackupRecords(ts.db); gate.resolve(); expect(await outcome).toMatchObject({ statusCode: 503 });
    const latest = (await api('GET', '/backups?limit=1')).json().backups[0];
    expect(latest.status).toBe('interrupted'); expect(latest.sha256).toBeNull();
  });
  it('filters and pages retained backup history', async () => {
    const first = (await api('GET', '/backups?status=succeeded&limit=2')).json();
    expect(first.hasMore).toBe(true);
    const next = (await api('GET', `/backups?status=succeeded&limit=2&beforeId=${first.backups.at(-1).id}`)).json();
    expect(next.backups.every((r: { id: number; status: string }) => r.id < first.backups.at(-1).id && r.status === 'succeeded')).toBe(true);
  });
});
