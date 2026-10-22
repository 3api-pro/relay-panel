import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { auditEvents, backupChecks, backupRuns, type BackupRunRow, type BackupCheckRow } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { BackupFileError, backupFiles, inspectBackupFile } from './backupFiles.js';

const expired = sql<boolean>`${backupRuns.leaseUntil} <= clock_timestamp()`;
const checkExpired = sql<boolean>`${backupChecks.leaseUntil} <= clock_timestamp()`;
export function backupView(row: BackupRunRow, leaseExpired = false) {
  const { leaseToken: _token, leaseUntil: _until, ...safe } = row;
  return { ...safe, status: row.status === 'running' && leaseExpired ? 'interrupted' : row.status };
}
export function checkView(row: BackupCheckRow, leaseExpired = false) {
  const { leaseUntil: _until, ...safe } = row;
  return { ...safe, status: row.status === 'running' && leaseExpired ? 'interrupted' : row.status };
}
export async function listBackups(db: Db, options: { beforeId?: number | undefined; status?: string | undefined; limit: number }) {
  const effectiveStatus = sql`CASE WHEN ${backupRuns.status}='running' AND ${expired} THEN 'interrupted' ELSE ${backupRuns.status} END`;
  const rows = await db.orm.select({ run: backupRuns, expired }).from(backupRuns)
    .where(and(options.beforeId ? lt(backupRuns.id, options.beforeId) : undefined,
      options.status ? sql`${effectiveStatus}=${options.status}` : undefined))
    .orderBy(desc(backupRuns.id)).limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  // A correlated max avoids loading every historic verification record for the page.
  const checks = page.length ? await db.orm.select({ row: backupChecks, expired: checkExpired }).from(backupChecks)
    .where(and(inArray(backupChecks.backupId, page.map(r => r.run.id)),
      sql`${backupChecks.id}=(SELECT max(latest.id) FROM backup_checks latest WHERE latest.backup_id=${backupChecks.backupId})`)) : [];
  return { backups: page.map(({ run, expired: stale }) => ({ ...backupView(run, stale), lastCheck: (() => {
    const found = checks.find(c => c.row.backupId === run.id); return found ? checkView(found.row, found.expired) : null;
  })() })), hasMore: rows.length > options.limit };
}
export async function listBackupChecks(db: Db, id: number, options: { beforeId?: number | undefined; limit: number }) {
  const [backup] = await db.orm.select({ id: backupRuns.id }).from(backupRuns).where(eq(backupRuns.id, id));
  if (!backup) throw new ApiError(404, '备份记录不存在');
  const rows = await db.orm.select({ row: backupChecks, expired: checkExpired }).from(backupChecks)
    .where(and(eq(backupChecks.backupId, id), options.beforeId ? lt(backupChecks.id, options.beforeId) : undefined))
    .orderBy(desc(backupChecks.id)).limit(options.limit + 1);
  return { checks: rows.slice(0, options.limit).map(r => checkView(r.row, r.expired)), hasMore: rows.length > options.limit };
}

const descriptions = {
  verified: '备份文件和清单与创建时的校验值一致；这不是恢复演练或异机副本验证',
  missing: '当前备份目录下找不到登记的文件；请检查存储位置和外部保留策略',
  mismatch: '文件或清单与登记值不一致，或读取期间发生变化；不要据此切换生产',
  unavailable: '无法安全读取登记的常规文件；请检查权限、存储位置和宿主机',
  interrupted: '检查中断或超时，文件完整性尚未确认',
} as const;

export async function verifyBackup(db: Db, config: Config, backupId: number, actor: string) {
  const { backup, check } = await db.orm.transaction(async orm => {
    const [backup] = await orm.select().from(backupRuns).where(eq(backupRuns.id, backupId)).for('update');
    if (!backup) throw new ApiError(404, '备份记录不存在');
    if (backup.status !== 'succeeded' || !backup.bytes || !backup.sha256 || !backup.manifestSha256) throw new ApiError(409, '仅已成功登记的备份可核验');
    await orm.update(backupChecks).set({ status: 'interrupted', completedAt: sql`clock_timestamp()`, detail: descriptions.interrupted })
      .where(and(eq(backupChecks.backupId, backupId), eq(backupChecks.status, 'running'), checkExpired));
    const [active] = await orm.select({ id: backupChecks.id }).from(backupChecks)
      .where(and(eq(backupChecks.backupId, backupId), eq(backupChecks.status, 'running'))).limit(1);
    if (active) throw new ApiError(409, '此备份正在核验');
    const [check] = await orm.insert(backupChecks).values({ backupId, actor, status: 'running', leaseUntil: sql`clock_timestamp()+interval '15 minutes'` }).returning();
    await orm.insert(auditEvents).values({ actor, action: 'operations.backup.verify.started', payload: { backupId, checkId: check!.id }, ok: true });
    return { backup, check: check! };
  });
  let status: keyof typeof descriptions = 'verified';
  let observedBytes: number | null = null, observedSha256: string | null = null;
  const signal = AbortSignal.timeout(600_000);
  try {
    const files = await backupFiles(config, backup);
    const manifest = await inspectBackupFile(files.manifest, signal, 65_536);
    if (manifest.sha256 !== backup.manifestSha256) throw new BackupFileError('mismatch');
    const archive = await inspectBackupFile(files.archive, signal, backup.bytes!);
    observedBytes = archive.bytes;
    observedSha256 = archive.sha256;
    if (archive.bytes !== backup.bytes || archive.sha256 !== backup.sha256) throw new BackupFileError('mismatch');
    // Reject directory replacement while the descriptors were open.
    await backupFiles(config, backup);
  } catch (error) {
    status = signal.aborted ? 'interrupted' : error instanceof BackupFileError ? error.status
      : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unavailable';
  }
  const saved = await db.orm.transaction(async orm => {
    const [row] = await orm.update(backupChecks).set({ status, observedBytes, observedSha256, detail: descriptions[status], completedAt: sql`clock_timestamp()` })
      .where(and(eq(backupChecks.id, check.id), eq(backupChecks.status, 'running'), sql`${backupChecks.leaseUntil} > clock_timestamp()`)).returning();
    if (!row) throw new ApiError(409, '检查已失效，请查看记录后重新核验');
    await orm.insert(auditEvents).values({ actor, action: 'operations.backup.verify', payload: { backupId, checkId: check.id, result: status }, ok: status === 'verified' });
    return row;
  });
  return { check: checkView(saved), recoveryVerified: false, offMachineCopyVerified: false };
}

export async function latestSuccessfulBackup(db: Db) {
  const [latest] = await db.orm.select({ row: backupRuns, ageMs: sql<number>`(extract(epoch from (clock_timestamp()-${backupRuns.completedAt}))*1000)::double precision` }).from(backupRuns).where(eq(backupRuns.status, 'succeeded')).orderBy(desc(backupRuns.id)).limit(1);
  if (!latest) return null;
  const row = latest.row;
  const [check] = await db.orm.select({ row: backupChecks, expired: checkExpired }).from(backupChecks)
    .where(eq(backupChecks.backupId, row.id)).orderBy(desc(backupChecks.id)).limit(1);
  return { ageMs: latest.ageMs, backup: { ...backupView(row), lastCheck: check ? checkView(check.row, check.expired) : null } };
}
