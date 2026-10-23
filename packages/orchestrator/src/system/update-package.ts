import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yauzl from 'yauzl';
import { compareSemver } from './version.js';

const run = promisify(execFile);
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
export const stableVersion = (v: string): boolean => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) && v.split('.').every(x => Number.isSafeInteger(Number(x)));
export const validRepo = (repo: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.split('/').some(x => x === '.' || x === '..');
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Only fixed GitHub release URLs and GitHub's asset hosts are followed. Never accept a client URL. */
async function download(url: string, limit: number, fetchFn: typeof fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('下载地址不受信任');
    const response = await fetchFn(url, { redirect: 'manual', signal, headers: { 'user-agent': 'relay-panel-updater', accept: 'application/vnd.github+json' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) throw new Error('下载跳转无效');
      url = new URL(next, url).href; continue;
    }
    if (!response.ok || !response.body) throw new Error('无法下载发行包，请稍后重试');
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('发行文件超过大小限制'); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('发行文件超过大小限制');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('下载跳转过多');
}

export function safeArchivePath(path: string): boolean {
  return path.length <= 240 && !path.includes('\\') && !/[\x00-\x1f:]/.test(path) &&
    path.split('/').every(p => p.length > 0 && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}

export async function extractBundle(archive: string, target: string, version: string): Promise<Set<string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, value) => err ? reject(err) : resolve(value!)));
  const files = new Set<string>(), folded = new Set<string>(); let expanded = 0, entries = 0;
  await mkdir(target, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (err: unknown): void => { if (!failed) { failed = true; zip.close(); reject(err); } };
    zip.on('error', fail); zip.on('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      const directory = entry.fileName.endsWith('/'), name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const prefix = `relay-panel-${version}/`;
      if (++entries > 10_000 || !safeArchivePath(name) || (!name.startsWith(prefix) && name !== prefix.slice(0, -1))) throw new Error('发行包路径无效');
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type && type !== (directory ? 0o040000 : 0o100000)) throw new Error('发行包包含链接或特殊文件');
      const path = name.slice(prefix.length);
      if (folded.has(name.toLowerCase())) throw new Error('发行包包含重复路径');
      folded.add(name.toLowerCase());
      if (directory) { if (path) await mkdir(join(target, path), { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
      if (!path || entry.uncompressedSize > 64 * 1024 * 1024 || (expanded += entry.uncompressedSize) > MAX_EXPANDED || (entry.generalPurposeBitFlag & 1)) throw new Error('发行包超过解压限制');
      const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s!)));
      await mkdir(dirname(join(target, path)), { recursive: true, mode: 0o700 });
      let bytes = 0;
      await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, cb) {
        bytes += chunk.length; cb(bytes > entry.uncompressedSize ? new Error('解压大小异常') : null, chunk);
      } }), createWriteStream(join(target, path), { flags: 'wx', mode: 0o600 }));
      files.add(path); zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
  return files;
}

async function migrationHashes(root: string): Promise<Record<string, string>> {
  const path = join(root, 'packages/orchestrator/src/db/migrations');
  const result: Record<string, string> = {};
  for (const name of (await readdir(path)).filter(p => p.endsWith('.sql')).sort()) result[name] = digest(await readFile(join(path, name)));
  const built = join(root, 'packages/orchestrator/dist/db/migrations');
  const copied = await readdir(built).catch(err => { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; });
  if (copied) {
    const effective: Record<string, string> = {};
    for (const name of copied.filter(p => p.endsWith('.sql')).sort()) effective[name] = digest(await readFile(join(built, name)));
    if (JSON.stringify(effective) !== JSON.stringify(result)) throw new Error('发行包的数据库迁移目录不一致');
  }
  return result;
}

export async function verifyBundle(root: string, currentRoot: string, version: string, files: Set<string>): Promise<void> {
  const manifestBytes = await readFile(join(root, 'release-manifest.json'));
  if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('发行清单过大');
  const manifest = JSON.parse(manifestBytes.toString()) as { version?: string; updateProtocol?: number; files?: Record<string, string> };
  if (manifest.version !== version || manifest.updateProtocol !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('此发行包尚不支持一键更新，请手动部署');
  const declared = Object.entries(manifest.files);
  if (declared.length !== files.size - 1) throw new Error('发行清单与文件不一致');
  for (const [path, hash] of declared) {
    if (!safeArchivePath(path) || !files.has(path) || path === 'release-manifest.json' || !/^[a-f0-9]{64}$/.test(hash) ||
      path.split('/').some(p => ['.git', 'node_modules', '.env', 'data'].includes(p)) || digest(await readFile(join(root, path))) !== hash) throw new Error('发行文件完整性校验失败');
  }
  for (const path of ['package.json', 'package-lock.json', 'packages/orchestrator/dist/index.js', 'packages/orchestrator/dist/system/supervisor.js', 'packages/web/dist/index.html']) {
    if (!files.has(path)) throw new Error('发行包缺少运行文件');
  }
  for (const name of ['', 'packages/orchestrator/', 'packages/web/']) {
    const pkg = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'));
    if (pkg.version !== version) throw new Error('发行包版本不一致');
    if (name === '') {
      const minimum = /^>=(\d+\.\d+(?:\.\d+)?)$/.exec(pkg.engines?.node ?? '')?.[1];
      if (!minimum || compareSemver(process.versions.node, minimum.split('.').length === 2 ? `${minimum}.0` : minimum) < 0) throw new Error('请先升级宿主机 Node.js');
    }
  }
  // A failed candidate may only return to the old binary when the SQL schema is identical.
  if (JSON.stringify(await migrationHashes(root)) !== JSON.stringify(await migrationHashes(currentRoot))) throw new Error('此版本包含数据库结构变更，请按发布说明手动升级');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  for (const pkg of Object.values(lock.packages ?? {}) as { resolved?: string; link?: boolean }[]) {
    if (pkg.resolved && !pkg.link && !pkg.resolved.startsWith('https://registry.npmjs.org/')) throw new Error('发行包依赖源不受信任');
  }
}

export async function stageRelease(opts: { repo: string; version: string; currentRoot: string; directory: string; npmCli: string; progress(phase: 'downloading' | 'verifying' | 'installing'): Promise<void>; fetchImpl?: typeof fetch }): Promise<string> {
  const { repo, version, directory } = opts, fetchFn = opts.fetchImpl ?? fetch;
  if (!validRepo(repo) || !stableVersion(version)) throw new Error('发行版本或仓库无效');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const space = await statfs(directory);
  if (space.bavail * space.bsize < 2 * 1024 ** 3) throw new Error('更新目录至少需要 2 GiB 可用空间');
  await opts.progress('downloading');
  const release = JSON.parse((await download(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, 2 * 1024 * 1024, fetchFn)).toString());
  if (release.draft || release.prerelease || release.tag_name !== `v${version}`) throw new Error('只能安装已发布的稳定版本');
  const base = `https://github.com/${repo}/releases/download/v${version}/`, filename = `relay-panel-v${version}-bundle.zip`;
  for (const name of [filename, 'SHA256SUMS.txt']) {
    if (!Array.isArray(release.assets) || release.assets.filter((a: { name?: string; browser_download_url?: string }) => a.name === name && a.browser_download_url === base + name).length !== 1) throw new Error('发行包或校验文件缺失');
  }
  const sums = (await download(base + 'SHA256SUMS.txt', 64 * 1024, fetchFn)).toString();
  const matches = sums.split(/\r?\n/).filter(line => line.trim().split(/\s+/)[1] === filename);
  const hash = matches[0]?.trim().split(/\s+/)[0];
  if (matches.length !== 1 || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('发行校验文件无效');
  const bytes = await download(base + filename, MAX_ARCHIVE, fetchFn);
  await opts.progress('verifying');
  if (digest(bytes) !== hash) throw new Error('发行包 SHA-256 校验失败');
  const archive = join(directory, 'bundle.zip'), root = join(directory, 'app');
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  const files = await extractBundle(archive, root, version);
  await verifyBundle(root, opts.currentRoot, version, files);
  await opts.progress('installing');
  const userconfig = join(directory, 'npmrc'); await writeFile(userconfig, '', { mode: 0o600 });
  // Do not pass database credentials, panel secrets or install hooks to dependency installation.
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  try {
    await run(process.execPath, [opts.npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', `--userconfig=${userconfig}`, `--cache=${join(directory, 'npm-cache')}`], { cwd: root, env, timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch { throw new Error('安装依赖失败，请检查网络、Node.js 和磁盘空间'); }
  return root;
}
