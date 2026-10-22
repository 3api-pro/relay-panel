import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Config } from '../config.js';
import type { BackupRunRow } from '../db/schema.js';

export class BackupFileError extends Error {
  constructor(readonly status: 'missing' | 'mismatch' | 'unavailable') { super(status); }
}

/** Read one regular file through a stable descriptor; never return archive contents. */
export async function inspectBackupFile(path: string, signal: AbortSignal, maximumBytes?: number) {
  signal.throwIfAborted();
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new BackupFileError('unavailable');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || !Number.isSafeInteger(before.size)) {
      throw new BackupFileError('unavailable');
    }
    if (maximumBytes !== undefined && before.size > maximumBytes) throw new BackupFileError('mismatch');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      bytes += chunk.length;
      if (maximumBytes !== undefined && bytes > maximumBytes) throw new BackupFileError('mismatch');
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.dev !== after.dev || current.ino !== after.ino) throw new BackupFileError('mismatch');
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new BackupFileError('mismatch');
    }
    signal.throwIfAborted();
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

/** All input paths come from the recorded backup and configured private root, never from an API body. */
export async function backupFiles(config: Config, run: BackupRunRow) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(run.storageKey)) throw new BackupFileError('unavailable');
  if (run.archiveFile !== (run.databaseKind === 'pg' ? 'panel.dump' : 'panel.tar.gz')) throw new BackupFileError('unavailable');
  const root = await realpath(config.backupDirectory);
  const folder = join(root, run.storageKey);
  const entry = await lstat(folder);
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(root, await realpath(folder)) !== run.storageKey) throw new BackupFileError('unavailable');
  return { folder, archive: join(folder, run.archiveFile), manifest: join(folder, 'manifest.json') };
}
