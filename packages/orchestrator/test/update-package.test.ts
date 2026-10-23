import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { extractBundle, safeArchivePath, stageRelease, verifyBundle } from '../src/system/update-package.js';
const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
async function folder() { const path = await mkdtemp(join(tmpdir(), 'update-package-')); folders.push(path); return path; }
async function put(root: string, path: string, contents: string | Buffer) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), contents); }
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
// Minimal stored ZIP builder keeps archive validation tests independent of system zip/Python.
function zip(entries: { name: string; text?: string; attrs?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), bytes = Buffer.from(e.text ?? 'test'); let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(crc, 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(e.attrs ?? (0o100600 << 16) >>> 0, 38); index.writeUInt32LE(offset, 42); central.push(index, name); offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture() {
  const root = await folder(), old = await folder();
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ version: '2.14.1', engines: { node: '>=22.12' } }),
    'package-lock.json': JSON.stringify({ packages: {} }),
    'packages/orchestrator/package.json': JSON.stringify({ version: '2.14.1' }),
    'packages/web/package.json': JSON.stringify({ version: '2.14.1' }),
    'packages/orchestrator/dist/index.js': '// server', 'packages/orchestrator/dist/system/supervisor.js': '// supervisor', 'packages/web/dist/index.html': '<html/>',
    'packages/orchestrator/src/db/migrations/001.sql': 'SELECT 1;',
  };
  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  await put(old, 'packages/orchestrator/src/db/migrations/001.sql', 'SELECT 1;');
  const manifest = { version: '2.14.1', updateProtocol: 1, files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha(t)])) };
  await put(root, 'release-manifest.json', JSON.stringify(manifest));
  return { root, old, files: new Set([...Object.keys(files), 'release-manifest.json']), manifest };
}
describe('release package verification', () => {
  it.each(['../file', '/absolute', 'a/../b', 'C:/file', 'a\\b', 'a/CON.txt', 'a/trailing.', 'a//b', 'a/space '])('rejects non-portable or escaping path %s', path => { expect(safeArchivePath(path)).toBe(false); });
  it('extracts regular files only under the exact release directory', async () => {
    const root = await folder(); await put(root, 'test.zip', zip([{ name: 'relay-panel-2.14.1/package.json', text: '{}' }]));
    expect(await extractBundle(join(root, 'test.zip'), join(root, 'out'), '2.14.1')).toEqual(new Set(['package.json']));
  });
  it.each([
    [{ name: 'relay-panel-2.14.1/../../escape' }],
    [{ name: 'relay-panel-2.14.1/link', attrs: (0o120777 << 16) >>> 0 }],
    [{ name: 'relay-panel-2.14.1/A' }, { name: 'relay-panel-2.14.1/a' }],
    [{ name: 'wrong-release/file' }],
  ])('rejects archive traversal, symlinks, duplicates and wrong release roots', async (...entries) => {
    const root = await folder(); await put(root, 'test.zip', zip(entries));
    await expect(extractBundle(join(root, 'test.zip'), join(root, 'out'), '2.14.1')).rejects.toThrow();
  });
  it('accepts a complete verified same-schema bundle', async () => { const f = await fixture(); await verifyBundle(f.root, f.old, '2.14.1', f.files); });
  it('rejects changed bytes even when filenames and version match', async () => {
    const f = await fixture(); await put(f.root, 'packages/orchestrator/dist/index.js', '// tampered');
    await expect(verifyBundle(f.root, f.old, '2.14.1', f.files)).rejects.toThrow('完整性');
  });
  it('rejects a database migration before installing dependencies or stopping the application', async () => {
    const f = await fixture(), path = 'packages/orchestrator/src/db/migrations/002.sql';
    await put(f.root, path, 'SELECT 2;'); f.files.add(path); f.manifest.files[path] = sha('SELECT 2;'); await put(f.root, 'release-manifest.json', JSON.stringify(f.manifest));
    await expect(verifyBundle(f.root, f.old, '2.14.1', f.files)).rejects.toThrow('数据库结构变更');
  });
  it('rejects old packages without an update protocol and files outside the manifest', async () => {
    const f = await fixture(); f.manifest.updateProtocol = 0; await put(f.root, 'release-manifest.json', JSON.stringify(f.manifest));
    await expect(verifyBundle(f.root, f.old, '2.14.1', f.files)).rejects.toThrow('尚不支持');
    f.manifest.updateProtocol = 1; await put(f.root, 'release-manifest.json', JSON.stringify(f.manifest)); f.files.add('extra.js');
    await expect(verifyBundle(f.root, f.old, '2.14.1', f.files)).rejects.toThrow('不一致');
  });
  it('rejects a corrupt download before extraction, dependency install or maintenance', async () => {
    const directory = await folder(), base = 'https://github.com/owner/repo/releases/download/v2.14.1/', name = 'relay-panel-v2.14.1-bundle.zip';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('api.github.com') ? new Response(JSON.stringify({ tag_name: 'v2.14.1', assets: [name, 'SHA256SUMS.txt'].map(n => ({ name: n, browser_download_url: base + n })) })) : String(url).endsWith('SHA256SUMS.txt') ? new Response(`${'a'.repeat(64)}  ${name}`) : new Response('corrupt'));
    const progress = vi.fn(async () => {});
    await expect(stageRelease({ repo: 'owner/repo', version: '2.14.1', directory, currentRoot: '/unused', npmCli: '/unused', progress, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow('SHA-256');
    expect(progress.mock.calls).not.toContainEqual(['installing']);
  });
  it('refuses a redirect outside GitHub before making another network request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(stageRelease({ repo: 'owner/repo', version: '2.14.1', directory: await folder(), currentRoot: '/unused', npmCli: '/unused', progress: async () => {}, fetchImpl })).rejects.toThrow('不受信任');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
