import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, stat, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { appSettings } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { pgEnvFromUrl } from '../cli/backupCmds.js';
import { writeAudit } from '../audit.js';

const run = promisify(execFile);
export const BACKUP_STATE = 'operations_backup';
export async function performPanelBackup(db: Db, config: Config, actor = 'system'): Promise<Record<string, unknown>> {
  const lease = randomUUID();
  const now = toPgTimestamp(new Date());
  const [locked] = await db.orm.insert(appSettings).values({ key: 'operations_backup_lease', value: { lease, until: Date.now() + 900_000 }, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: { lease, until: Date.now() + 900_000 }, updatedAt: now },
      setWhere: sql`COALESCE((${appSettings.value}->>'until')::bigint, 0) < ${Date.now()}`,
    }).returning();
  if (!locked) throw new ApiError(409, '备份正在进行');
  const startedAt = new Date().toISOString();
  const folder = resolve(config.backupDirectory, `${startedAt.replace(/[:.]/g, '-')}-${lease.slice(0, 8)}`);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = db.kind === 'pg' ? 'panel.dump' : 'panel.tar.gz';
    const path = join(folder, file);
    if (db.kind === 'pg') {
      // Password goes through environment only; never argv, error payloads, or manifests.
      await run(config.pgDumpCommand, ['--format=custom', '--no-owner', '--no-privileges', '--file', path], {
        env: { ...process.env, ...pgEnvFromUrl(config.dbUrl) }, timeout: 600_000, maxBuffer: 1024 * 1024,
      });
    } else {
      if (!db.snapshot) throw new Error('Live database snapshot unavailable');
      await writeFile(path, await db.snapshot(), { mode: 0o600 });
    }
    const bytes = (await stat(path)).size;
    if (!bytes) throw new Error('Empty backup');
    await chmod(path, 0o600);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const manifest = { format: 1, database: db.kind, startedAt, completedAt: new Date().toISOString(), file, bytes, sha256,
      scope: 'panel-database', encryptionKeyIncluded: false, remoteEnginesIncluded: false };
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const result = { ...manifest, folder, status: 'success' };
    await db.orm.insert(appSettings).values({ key: BACKUP_STATE, value: result, updatedAt: toPgTimestamp(new Date()) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: result, updatedAt: toPgTimestamp(new Date()) } });
    await writeAudit(db, { actor, action: 'operations.backup', payload: { sha256, bytes, scope: manifest.scope }, ok: true });
    return result;
  } catch {
    const result = { status: 'failed', startedAt, error: '备份失败，请检查目标目录、磁盘空间和数据库备份工具' };
    await db.orm.insert(appSettings).values({ key: BACKUP_STATE, value: result, updatedAt: toPgTimestamp(new Date()) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: result, updatedAt: toPgTimestamp(new Date()) } });
    await writeAudit(db, { actor, action: 'operations.backup', ok: false, error: result.error });
    throw new ApiError(503, result.error);
  } finally {
    await db.orm.delete(appSettings).where(sql`${appSettings.key} = 'operations_backup_lease' AND ${appSettings.value}->>'lease' = ${lease}`);
  }
}

export function startBackupWorker(db: Db, config: Config): { stop(): Promise<void> } {
  let current: Promise<unknown> | null = null;
  const tick = async (): Promise<void> => {
    if (current || !config.backupIntervalMs) return;
    const [last] = await db.orm.select().from(appSettings).where(eq(appSettings.key, BACKUP_STATE));
    const when = Date.parse(String(last?.value.completedAt ?? last?.value.startedAt ?? ''));
    if (Number.isFinite(when) && Date.now() - when < (last?.value.status === 'failed' ? Math.min(3_600_000, config.backupIntervalMs) : config.backupIntervalMs)) return;
    current = performPanelBackup(db, config).catch(() => undefined).finally(() => { current = null; });
    await current;
  };
  const timer = config.backupIntervalMs > 0 ? setInterval(() => void tick().catch(() => undefined), 60_000) : null;
  timer?.unref();
  return { async stop() { if (timer) clearInterval(timer); await current; } };
}
