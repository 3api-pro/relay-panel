import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db, Orm } from '../db/client.js';
import type { Config } from '../config.js';
import { appSettings, auditEvents, backupChecks, backupRuns } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { pgEnvFromUrl } from '../cli/backupCmds.js';
import { inspectBackupFile } from './backupFiles.js';

const run = promisify(execFile);
export const BACKUP_STATE = 'operations_backup';
const LEASE_KEY = 'operations_backup_lease';
const LEASE_MS = 900_000;
const nowMs = sql`floor(extract(epoch from clock_timestamp())*1000)::bigint`;
const failedMessage = '备份失败，请检查目标目录、磁盘空间和数据库备份工具';
const interruptedMessage = '备份执行进程失联，文件结果未确认；请检查宿主机后重新备份';

async function expireRecords(orm: Orm): Promise<void> {
  const expired = await orm.update(backupRuns).set({ status: 'interrupted', completedAt: sql`clock_timestamp()`, error: interruptedMessage })
    .where(and(eq(backupRuns.status, 'running'), sql`${backupRuns.leaseUntil} <= clock_timestamp()`)).returning({ id: backupRuns.id });
  for (const row of expired) await orm.insert(auditEvents).values({ actor: 'system', action: 'operations.backup.interrupted', payload: { backupId: row.id }, ok: false, error: interruptedMessage });
  await orm.update(backupChecks).set({ status: 'interrupted', completedAt: sql`clock_timestamp()`, detail: '检查进程失联，文件完整性尚未确认' })
    .where(and(eq(backupChecks.status, 'running'), sql`${backupChecks.leaseUntil} <= clock_timestamp()`));
}
export async function reconcileBackupRecords(db: Db): Promise<void> {
  await db.orm.transaction(expireRecords);
}

export async function performPanelBackup(db: Db, config: Config, actor = 'system'): Promise<Record<string, unknown>> {
  const lease = randomUUID();
  const startedAt = new Date().toISOString();
  const storageKey = `${startedAt.replace(/[:.]/g, '-')}-${lease.slice(0, 8)}`;
  const folder = resolve(config.backupDirectory, storageKey);
  const file = db.kind === 'pg' ? 'panel.dump' : 'panel.tar.gz';
  const excludedTables = db.kind === 'pg' ? config.backupExcludeTables : [];
  const leaseValue = sql`jsonb_build_object('lease', ${lease}::text, 'until', ${nowMs}+${LEASE_MS}::bigint)`;
  const ownedLease = and(eq(appSettings.key, LEASE_KEY), sql`${appSettings.value}->>'lease' = ${lease}`, sql`(${appSettings.value}->>'until')::bigint > ${nowMs}`);
  const record = await db.orm.transaction(async orm => {
    const [locked] = await orm.insert(appSettings).values({ key: LEASE_KEY, value: leaseValue })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: leaseValue, updatedAt: sql`clock_timestamp()` },
        setWhere: sql`COALESCE((${appSettings.value}->>'until')::bigint, 0) <= ${nowMs}` }).returning();
    if (!locked) throw new ApiError(409, '备份正在进行，或旧执行进程的占用尚未到期');
    await expireRecords(orm);
    const [created] = await orm.insert(backupRuns).values({ storageKey, databaseKind: db.kind, status: 'running', archiveFile: file,
      excludedTables, actor, leaseToken: lease, leaseUntil: sql`clock_timestamp()+interval '15 minutes'` }).returning();
    await orm.insert(auditEvents).values({ actor, action: 'operations.backup.started', payload: { backupId: created!.id }, ok: true });
    return created!;
  });
  const liveRun = and(eq(backupRuns.id, record.id), eq(backupRuns.leaseToken, lease), eq(backupRuns.status, 'running'), sql`${backupRuns.leaseUntil} > clock_timestamp()`);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || signal.aborted) return;
    renewing = true;
    void db.orm.transaction(async orm => {
      const claimed = await orm.update(appSettings).set({ value: leaseValue, updatedAt: sql`clock_timestamp()` }).where(ownedLease).returning();
      const renewed = await orm.update(backupRuns).set({ leaseUntil: sql`clock_timestamp()+interval '15 minutes'` }).where(liveRun).returning();
      if (!claimed.length || !renewed.length) throw new Error('Backup ownership lost');
    }).catch(() => controller.abort()).finally(() => { renewing = false; });
  }, 30_000);
  timer.unref();
  try {
    await mkdir(resolve(config.backupDirectory), { recursive: true, mode: 0o700 });
    await mkdir(folder, { mode: 0o700 });
    const path = join(folder, file);
    if (db.kind === 'pg') {
      await run(config.pgDumpCommand, ['--format=custom', '--no-owner', '--no-privileges',
        ...excludedTables.map(table => `--exclude-table=${table}`), '--file', path], {
        env: { ...process.env, ...pgEnvFromUrl(config.dbUrl) }, timeout: 600_000, signal, maxBuffer: 1024 * 1024,
      });
    } else {
      if (!db.snapshot) throw new Error('Live database snapshot unavailable');
      const snapshot = await db.snapshot();
      signal.throwIfAborted();
      await writeFile(path, snapshot, { mode: 0o600, flag: 'wx' });
    }
    signal.throwIfAborted();
    await chmod(path, 0o600);
    const { bytes, sha256 } = await inspectBackupFile(path, signal);
    if (!bytes) throw new Error('Empty backup');
    const manifest = { format: 2, backupId: record.id, database: db.kind, startedAt, completedAt: new Date().toISOString(), file, bytes, sha256,
      scope: 'panel-database', encryptionKeyIncluded: false, remoteEnginesIncluded: false, excludedTables };
    const contents = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(contents) > 65_536) throw new Error('Backup manifest exceeds the verification limit');
    const manifestSha256 = createHash('sha256').update(contents).digest('hex');
    await writeFile(join(folder, 'manifest.json'), contents, { mode: 0o600, flag: 'wx' });
    signal.throwIfAborted();
    const result = { ...manifest, folder, status: 'success' };
    await db.orm.transaction(async orm => {
      const [lock] = await orm.select({ key: appSettings.key }).from(appSettings).where(ownedLease).for('update');
      if (!lock || signal.aborted) { controller.abort(); throw new Error('Backup ownership lost'); }
      const [saved] = await orm.update(backupRuns).set({ status: 'succeeded', completedAt: sql`clock_timestamp()`, bytes, sha256, manifestSha256 }).where(liveRun).returning();
      if (!saved) { controller.abort(); throw new Error('Backup ownership lost'); }
      await orm.insert(appSettings).values({ key: BACKUP_STATE, value: result })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: result, updatedAt: sql`clock_timestamp()` } });
      await orm.insert(auditEvents).values({ actor, action: 'operations.backup', payload: { backupId: record.id, sha256, bytes, scope: manifest.scope }, ok: true });
    });
    return result;
  } catch {
    const message = signal.aborted ? interruptedMessage : failedMessage;
    await db.orm.transaction(async orm => {
      const [lock] = await orm.select({ key: appSettings.key }).from(appSettings).where(ownedLease).for('update');
      if (!lock) {
        const [lost] = await orm.update(backupRuns).set({ status: 'interrupted', completedAt: sql`clock_timestamp()`, error: interruptedMessage })
          .where(and(eq(backupRuns.id, record.id), eq(backupRuns.leaseToken, lease), eq(backupRuns.status, 'running'))).returning();
        if (lost) await orm.insert(auditEvents).values({ actor, action: 'operations.backup.interrupted', payload: { backupId: record.id }, ok: false, error: interruptedMessage });
        return;
      }
      const [saved] = await orm.update(backupRuns).set({ status: signal.aborted ? 'interrupted' : 'failed', completedAt: sql`clock_timestamp()`, error: message }).where(liveRun).returning();
      if (!saved) return;
      const result = { backupId: record.id, status: 'failed', startedAt, error: message };
      await orm.insert(appSettings).values({ key: BACKUP_STATE, value: result })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: result, updatedAt: sql`clock_timestamp()` } });
      await orm.insert(auditEvents).values({ actor, action: 'operations.backup', payload: { backupId: record.id }, ok: false, error: message });
    });
    throw new ApiError(503, message);
  } finally {
    clearInterval(timer);
    await db.orm.delete(appSettings).where(and(eq(appSettings.key, LEASE_KEY), sql`${appSettings.value}->>'lease' = ${lease}`));
  }
}

export function startBackupWorker(db: Db, config: Config): { stop(): Promise<void> } {
  let current: Promise<unknown> | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (current || stopped) return;
    current = (async () => {
      await reconcileBackupRecords(db);
      if (!config.backupIntervalMs || stopped) return;
      const [latest] = await db.orm.select({ row: backupRuns, ageMs: sql<number>`(extract(epoch from (clock_timestamp()-coalesce(${backupRuns.completedAt},${backupRuns.startedAt})))*1000)::double precision` }).from(backupRuns).orderBy(desc(backupRuns.id)).limit(1);
      const last = latest?.row;
      const [legacy] = last ? [] : await db.orm.select().from(appSettings).where(eq(appSettings.key, BACKUP_STATE));
      if (last?.status === 'running') return;
      const ageMs = latest?.ageMs ?? Date.now() - Date.parse(String(legacy?.value.completedAt ?? legacy?.value.startedAt ?? ''));
      const failed = last ? last.status !== 'succeeded' : legacy?.value.status === 'failed';
      if (Number.isFinite(ageMs) && ageMs < (failed ? Math.min(3_600_000, config.backupIntervalMs) : config.backupIntervalMs)) return;
      await performPanelBackup(db, config);
    })().catch(() => undefined).finally(() => { current = null; });
    await current;
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return { async stop() { stopped = true; clearInterval(timer); await current; } };
}
