import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createUpdateChannel } from './update-channel.js';
import { UpdateManager } from './update-manager.js';
import { stageRelease } from './update-package.js';

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const config = loadConfig(), bootstrap = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const directory = resolve(config.updateDirectory), lock = join(directory, 'supervisor.lock');
await mkdir(directory, { recursive: true, mode: 0o700 });
try { await mkdir(lock, { mode: 0o700 }); }
catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  const owner = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('更新进程锁需要人工检查');
  try { process.kill(owner, 0); throw new Error('已有面板管理进程正在运行'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
}
await writeFile(join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });

const npmCli = [config.updateNpmCli, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p));
const version = JSON.parse(await readFile(join(bootstrap, 'package.json'), 'utf8')).version as string;
let child: ChildProcess | null = null, channel: ReturnType<typeof createUpdateChannel> | null = null;
let ready = false, stopping = false, exiting = false;

function assertRoot(root: string): void {
  const rel = relative(join(directory, 'releases'), root);
  if (root !== bootstrap && (isAbsolute(rel) || rel.startsWith('..') || !/^[a-f0-9-]+[\\/]app$/.test(rel))) throw new Error('更新目录不在受管理的路径内');
}
async function stop(): Promise<void> {
  const old = child; if (!old || old.exitCode !== null || old.signalCode !== null) return;
  stopping = true;
  try {
    if (channel && old.connected) await channel.call('shutdown', undefined, 60_000).catch(() => undefined);
    const until = Date.now() + 60_000;
    while (old.exitCode === null && old.signalCode === null && Date.now() < until) await delay(100);
    if (old.exitCode === null && old.signalCode === null) throw new Error('服务尚未安全退出，更新已中止；请检查运行任务');
    channel?.close(); channel = null; child = null;
  } finally { stopping = false; }
}
async function boot(root: string): Promise<void> {
  assertRoot(root);
  if (child && child.exitCode === null && child.signalCode === null) throw new Error('旧服务尚未退出');
  ready = false;
  const next = fork(join(root, 'packages/orchestrator/dist/index.js'), [], {
    cwd: process.cwd(), execPath: process.execPath, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, RP_UPDATE_MANAGED: '1', RP_WEB_DIST: join(root, 'packages/web/dist') },
  });
  child = next;
  channel = createUpdateChannel(next, async (method, args) => {
    if (method === 'ready') { ready = true; return true; }
    if (method === 'status') return manager.status();
    if (method === 'start') {
      const input = args as { target?: unknown; actor?: unknown };
      if (typeof input?.target !== 'string' || typeof input.actor !== 'string' || input.actor.length > 320) throw new Error('更新请求无效');
      return manager.start(input.target, input.actor);
    }
    throw new Error('更新操作无效');
  });
  next.on('error', () => { ready = false; });
  next.on('exit', () => {
    if (!stopping && !exiting && !['restarting', 'checking'].includes(manager.status().phase)) {
      // Let the host service manager restart the supervisor, preserving its durable version pointer.
      void finish(1);
    }
  });
  const until = Date.now() + 90_000;
  while (!ready && next.exitCode === null && next.signalCode === null && Date.now() < until) await delay(100);
  if (!ready) throw new Error('新版本启动失败，正在恢复上一版本');
  const response = await fetch(`http://127.0.0.1:${config.port}/readyz`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('新版本健康检查未通过');
}
const manager: UpdateManager = new UpdateManager(directory, bootstrap, version, {
  stage: (target, id, progress) => stageRelease({ repo: config.releaseRepo ?? '3api-pro/relay-panel', version: target,
    currentRoot: manager.root, directory: join(directory, 'releases', id), npmCli: npmCli!, progress }),
  backup: actor => channel!.call<number>('backup', { actor }, 660_000),
  stop, boot,
  activate: () => channel!.call<void>('activate', undefined, 120_000),
  resume: async () => { if (child?.connected) await channel!.call('resume'); },
}, config.demo ? '演示模式不支持一键更新' : config.dbUrl === 'pglite:memory' ? '内存数据库无法在重启后保留数据，请先配置持久化数据库' : !npmCli ? '宿主机缺少 npm，请安装完整 Node.js 或配置 RP_UPDATE_NPM_CLI' : null);

async function finish(code: number): Promise<void> {
  if (exiting) return; exiting = true;
  try { await stop(); }
  catch { process.exit(1); } // Keep the lock when a child could still own the database.
  await rm(lock, { recursive: true, force: true }); process.exit(code);
}
process.on('SIGTERM', () => void finish(0)); process.on('SIGINT', () => void finish(0));
try {
  await manager.restore(); await boot(manager.root); await channel!.call('activate', undefined, 120_000);
} catch {
  console.error('[updater] 面板启动失败，请检查本机更新状态和进程日志'); await finish(1);
}
