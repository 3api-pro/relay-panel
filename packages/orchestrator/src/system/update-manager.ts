import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareSemver } from './version.js';
import { stableVersion } from './update-package.js';
import { initialUpdateStatus, updateActive, type UpdatePhase, type UpdateStatus } from './update-types.js';

export interface UpdateRuntime {
  stage(version: string, id: string, progress: (phase: UpdatePhase) => Promise<void>): Promise<string>;
  backup(actor: string): Promise<number>;
  stop(): Promise<void>;
  boot(root: string): Promise<void>;
  activate(): Promise<void>;
  resume(): Promise<void>;
}
interface SavedUpdate { actor?: string; currentRoot: string; currentVersion: string; status: UpdateStatus }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

/** Single supervisor owns the state file and runs at most one update. No database restore is automatic. */
export class UpdateManager {
  private saved: SavedUpdate;
  private task: Promise<void> | null = null;
  private starting = false;
  constructor(private directory: string, root: string, version: string, private runtime: UpdateRuntime, reason: string | null = null) {
    this.saved = { currentRoot: root, currentVersion: version, status: initialUpdateStatus(!reason, reason) };
  }
  get root(): string { return this.saved.currentRoot; }
  get version(): string { return this.saved.currentVersion; }
  status(): UpdateStatus { return structuredClone(this.saved.status); }
  async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let raw: string;
    try { raw = await readFile(join(this.directory, 'state.json'), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
    const previous = JSON.parse(raw) as SavedUpdate;
    if (!previous.currentRoot || !stableVersion(previous.currentVersion) || !previous.status || !['idle','downloading','verifying','installing','backing_up','restarting','checking','succeeded','failed'].includes(previous.status.phase)) throw new Error('更新状态文件无效，请检查宿主机');
    if (compareSemver(this.version, previous.currentVersion) > 0) {
      // A deliberate host/image upgrade supersedes the older persistent application pointer.
      await this.save(); return;
    }
    previous.status.supported = this.saved.status.supported; previous.status.reason = this.saved.status.reason;
    this.saved = previous;
    if (updateActive(previous.status.phase)) {
      this.saved.status.phase = 'failed'; this.saved.status.error = '更新被中断，已保留上次确认的版本；请核对状态后重试';
      this.saved.status.completedAt = new Date().toISOString(); await this.save();
    }
  }
  private async save(): Promise<void> { await atomicJson(join(this.directory, 'state.json'), this.saved); }
  private async phase(phase: UpdatePhase): Promise<void> { this.saved.status.phase = phase; await this.save(); }
  async start(target: string, actor: string): Promise<UpdateStatus> {
    if (!this.saved.status.supported) throw new Error(this.saved.status.reason!);
    if (this.task || this.starting) throw new Error('已有更新正在进行');
    if (!stableVersion(target) || compareSemver(target, this.version) <= 0) throw new Error('请选择比当前版本更新的稳定发行版');
    this.starting = true;
    try {
      this.saved.actor = actor;
      this.saved.status = { ...initialUpdateStatus(true), id: randomUUID(), phase: 'downloading', from: this.version, target, startedAt: new Date().toISOString() };
      await this.save();
      this.task = this.execute(target, actor).catch(() => { this.saved.status.supported = false; this.saved.status.reason = '无法保存更新状态，请检查宿主机磁盘'; }).finally(() => { this.task = null; });
      return this.status();
    } finally { this.starting = false; }
  }
  async idle(): Promise<void> { await this.task; }
  private async execute(target: string, actor: string): Promise<void> {
    const oldRoot = this.root, oldVersion = this.version;
    let stopped = false, committed = false;
    try {
      const root = await this.runtime.stage(target, this.saved.status.id!, phase => this.phase(phase));
      await this.phase('backing_up');
      this.saved.status.backupId = await this.runtime.backup(actor); await this.save();
      await this.phase('restarting');
      // stop() must confirm process exit; it may not launch a second process on a live port/database.
      await this.runtime.stop(); stopped = true;
      await this.phase('checking'); await this.runtime.boot(root);
      this.saved.currentRoot = root; this.saved.currentVersion = target; await this.save(); committed = true;
      await this.runtime.activate();
      this.saved.status.completedAt = new Date().toISOString(); await this.phase('succeeded');
    } catch (error) {
      // Once activated, never switch back over writes made by a newer application.
      if (!committed) {
        this.saved.currentRoot = oldRoot; this.saved.currentVersion = oldVersion;
        try { if (stopped) { await this.runtime.stop(); await this.runtime.boot(oldRoot); await this.runtime.activate(); } else await this.runtime.resume(); }
        catch { this.saved.status.supported = false; this.saved.status.reason = '恢复服务失败，请检查宿主机进程和日志'; }
      }
      this.saved.status.error = error instanceof Error ? error.message : '更新失败';
      this.saved.status.completedAt = new Date().toISOString();
      await this.phase('failed');
    }
  }
}
