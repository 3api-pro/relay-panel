import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, statfs } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname, platform } from 'node:os';

const exec = promisify(execFile);
export interface EnvironmentCheck { key: string; ok: boolean; detail: string; }
export interface EnvironmentDependencies {
  command(args: string[]): Promise<string>;
  disk(path: string): Promise<number>;
  container: boolean;
}
export function environmentDependencies(viaWsl: boolean): EnvironmentDependencies {
  return {
    async command(args) {
      if (process.env.DOCKER_HOST && !/^(unix:|npipe:)/.test(process.env.DOCKER_HOST)) throw new Error('Remote DOCKER_HOST is unsupported');
      const result = await exec(viaWsl ? 'wsl' : 'docker', viaWsl ? ['-e', 'docker', ...args] : args,
        { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return result.stdout.trim();
    },
    async disk(path) {
      let existing = resolve(path);
      while (!existsSync(existing)) { const parent = dirname(existing); if (parent === existing) break; existing = parent; }
      await access(existing, constants.W_OK);
      const fs = await statfs(existing); return fs.bavail * fs.bsize;
    },
    container: existsSync('/.dockerenv'),
  };
}

/** Reads only; no package installation, daemon changes or container mutations. */
export async function inspectLocalEnvironment(sitesRoot: string, viaWsl = false, deps = environmentDependencies(viaWsl)) {
  const checks: EnvironmentCheck[] = [];
  let dockerVersion: string | null = null, composeVersion: string | null = null, memoryBytes: number | null = null, cpuCount: number | null = null, diskFreeBytes: number | null = null;
  try {
    const info = JSON.parse(await deps.command(['info', '--format', '{{json .}}']));
    dockerVersion = typeof info.ServerVersion === 'string' ? info.ServerVersion : null;
    memoryBytes = Number.isFinite(info.MemTotal) ? info.MemTotal : null;
    cpuCount = Number.isFinite(info.NCPU) ? info.NCPU : null;
    checks.push({ key: 'docker', ok: !!dockerVersion && info.OSType === 'linux', detail: info.OSType === 'linux' ? 'Docker Linux engine reachable' : 'Docker must use Linux containers' });
  } catch { checks.push({ key: 'docker', ok: false, detail: 'Install/start Docker and grant the panel permission to its socket' }); }
  try {
    const context = JSON.parse(await deps.command(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
    checks.push({ key: 'local', ok: typeof context === 'string' && /^(unix:|npipe:)/.test(context), detail: 'A local Docker socket is required; remote Docker contexts are not supported' });
  } catch { checks.push({ key: 'local', ok: false, detail: 'Could not verify the local Docker context' }); }
  try {
    composeVersion = await deps.command(['compose', 'version', '--short']);
    const version = composeVersion.match(/^v?(\d+)\.(\d+)/);
    checks.push({ key: 'compose', ok: !!version && (Number(version[1]) > 2 || Number(version[1]) === 2 && Number(version[2]) >= 20), detail: 'Docker Compose 2.20 or later is required' });
  } catch { checks.push({ key: 'compose', ok: false, detail: 'Install the Docker Compose plugin' }); }
  try {
    diskFreeBytes = await deps.disk(sitesRoot);
    checks.push({ key: 'storage', ok: diskFreeBytes >= 2 * 1024 ** 3, detail: 'Writable site directory and at least 2 GiB free for installation; monitor Docker volume storage separately' });
  } catch { checks.push({ key: 'storage', ok: false, detail: 'The panel cannot write the site directory or inspect free space' }); }
  if (deps.container) {
    let hostNetwork = false;
    try { hostNetwork = await deps.command(['inspect', '--format', '{{.HostConfig.NetworkMode}}', hostname()]) === 'host'; } catch { /* Fail closed. */ }
    checks.push({ key: 'network', ok: hostNetwork, detail: 'Containerized local management needs host networking to reach the engines on host loopback; use the local compose override' });
  }
  return { ready: checks.every(c => c.ok), platform: platform(), dockerVersion, composeVersion, memoryBytes, cpuCount, diskFreeBytes, checks };
}

export async function assertLocalEnvironment(sitesRoot: string): Promise<void> {
  const environment = await inspectLocalEnvironment(sitesRoot, process.env.RP_DOCKER_VIA_WSL === '1');
  if (!environment.ready) throw new Error(`Local environment not ready: ${environment.checks.filter(c => !c.ok).map(c => c.detail).join('; ')}`);
}

export function assertPinnedVersion(version: string): void {
  if (version === 'latest' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new Error('Use a pinned image tag; latest and shell/environment expressions are not allowed');
}
