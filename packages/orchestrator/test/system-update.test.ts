import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTestServer } from './helpers.js';
import { UpdateManager, type UpdateRuntime } from '../src/system/update-manager.js';
import { initialUpdateStatus, type UpdateStatus } from '../src/system/update-types.js';
vi.setConfig({ testTimeout: 30_000 });
const folders: string[] = [];
afterEach(async () => { for (const p of folders.splice(0)) await rm(p, { recursive: true, force: true }); });
async function manager(overrides: Partial<UpdateRuntime> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'panel-update-')); folders.push(directory);
  const runtime = { stage: vi.fn(async () => '/new'), backup: vi.fn(async () => 42), stop: vi.fn(async () => {}),
    boot: vi.fn(async (_root: string) => {}), activate: vi.fn(async () => {}), resume: vi.fn(async () => {}), ...overrides };
  const subject = new UpdateManager(directory, '/old', '2.14.0', runtime); await subject.restore();
  return { subject, runtime, directory };
}
describe('managed update transaction', () => {
  it('persists success only after backup, confirmed exit, health check and activation', async () => {
    const { subject, runtime, directory } = await manager();
    const response = await subject.start('2.14.1', 'root@example.test');
    expect(response.id).toBeTruthy(); await subject.idle();
    expect(subject.status()).toMatchObject({ phase: 'succeeded', backupId: 42, from: '2.14.0', target: '2.14.1' });
    const calls = [runtime.stage, runtime.backup, runtime.stop, runtime.boot, runtime.activate].map(f => (f as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).currentVersion).toBe('2.14.1');
  });
  it.each(['2.14.0', '2.13.9', '../path', '2.15.0-beta.1', '02.15.0', '2.15.0;reboot'])('rejects unsafe or non-newer target %s', async target => {
    const { subject, runtime } = await manager();
    await expect(subject.start(target, 'admin')).rejects.toThrow(); expect(runtime.stage).not.toHaveBeenCalled();
  });
  it('serializes concurrent requests even while persisting the first request', async () => {
    let done!: () => void;
    const wait = new Promise<void>(r => { done = r; });
    const { subject, runtime } = await manager({ stage: vi.fn(async () => { await wait; return '/new'; }) });
    const first = subject.start('2.14.1', 'admin');
    await expect(subject.start('2.14.2', 'admin')).rejects.toThrow('正在进行'); await first;
    await expect(subject.start('2.14.2', 'admin')).rejects.toThrow('正在进行'); done(); await subject.idle();
    expect(runtime.stage).toHaveBeenCalledTimes(1);
  });
  it.each(['stage', 'backup'])('does not stop the running application when %s fails', async name => {
    const { subject, runtime } = await manager({ [name]: vi.fn(async () => { throw new Error('受控失败'); }) });
    await subject.start('2.14.1', 'admin'); await subject.idle();
    expect(subject.status()).toMatchObject({ phase: 'failed', error: '受控失败' });
    expect(runtime.stop).not.toHaveBeenCalled(); expect(runtime.resume).toHaveBeenCalledOnce(); expect(subject.root).toBe('/old');
  });
  it('never boots a second application if the old process has not exited', async () => {
    const { subject, runtime } = await manager({ stop: vi.fn(async () => { throw new Error('仍在运行'); }) });
    await subject.start('2.14.1', 'admin'); await subject.idle(); expect(runtime.boot).not.toHaveBeenCalled();
  });
  it('returns to the prior binary on candidate health failure without restoring the database', async () => {
    const boot = vi.fn(async (path: string) => { if (path === '/new') throw new Error('启动失败'); });
    const { subject, runtime } = await manager({ boot }); await subject.start('2.14.1', 'admin'); await subject.idle();
    expect(boot.mock.calls).toEqual([['/new'], ['/old']]); expect(runtime.activate).toHaveBeenCalledOnce();
    expect(subject.root).toBe('/old'); expect(subject.status()).toMatchObject({ phase: 'failed', backupId: 42 });
  });
  it('does not roll back after the candidate has been committed and could have served writes', async () => {
    const { subject, runtime } = await manager({ activate: vi.fn(async () => { throw new Error('激活回执丢失'); }) });
    await subject.start('2.14.1', 'admin'); await subject.idle();
    expect(subject.root).toBe('/new'); expect(runtime.boot).toHaveBeenCalledTimes(1); expect(subject.status().phase).toBe('failed');
  });
  it('uses a deliberate newer host deployment instead of pinning an older downloaded version', async () => {
    const { subject, directory, runtime } = await manager();
    await subject.start('2.14.1', 'admin'); await subject.idle();
    const newer = new UpdateManager(directory, '/new-host-image', '2.15.0', runtime); await newer.restore();
    expect(newer.root).toBe('/new-host-image'); expect(newer.version).toBe('2.15.0'); expect(newer.status().phase).toBe('idle');
  });
  it('recovers interrupted state without repeating downloads, backups or mutations', async () => {
    const { subject, directory, runtime } = await manager();
    await subject.start('2.14.1', 'admin'); await subject.idle();
    const restored = new UpdateManager(directory, '/bootstrap', '2.14.0', runtime); await restored.restore();
    expect(restored.root).toBe('/new'); expect(restored.status().phase).toBe('succeeded');
    expect(runtime.stage).toHaveBeenCalledTimes(1);
  });
});

describe('update API permissions and maintenance', () => {
  it('requires a root session and confirmation; rejects foreign origins and arbitrary fields', async () => {
    const state = initialUpdateStatus(true), start = vi.fn(async (): Promise<UpdateStatus> => ({ ...state, phase: 'downloading' }));
    const ts = await makeTestServer({ updater: { status: async () => state, start } });
    try {
      for (const role of ['operator', 'viewer', 'root'] as const) {
        const { cookie } = await ts.seedLogin({ email: `${role}@example.test`, password: 'test-pass-123', role });
        const cookies = { rp_session: cookie };
        const get = await ts.app.inject({ url: '/api/system/update', cookies }); expect(get.statusCode).toBe(role === 'root' ? 200 : 403);
        const post = await ts.app.inject({ method: 'POST', url: '/api/system/update', cookies, payload: { target: '2.14.1', confirmed: true } });
        expect(post.statusCode).toBe(role === 'root' ? 202 : 403);
        if (role === 'root') {
          for (const payload of [{ target: '2.14.1' }, { target: '2.14.1', confirmed: true, command: 'reboot' }]) expect((await ts.app.inject({ method: 'POST', url: '/api/system/update', cookies, payload })).statusCode).toBe(400);
          expect((await ts.app.inject({ method: 'POST', url: '/api/system/update', cookies, headers: { origin: 'https://evil.test' }, payload: { target: '2.14.1', confirmed: true } })).statusCode).toBe(403);
        }
      }
      expect((await ts.app.inject({ url: '/api/system/update' })).statusCode).toBe(401);
      expect(start).toHaveBeenCalledExactlyOnceWith('2.14.1', 'root@example.test');
    } finally { await ts.close(); }
  });
  it('keeps update status visible during maintenance but blocks ordinary reads and writes', async () => {
    const maintenance = { active: false, requests: new Set<string>() };
    const ts = await makeTestServer({ updateMaintenance: maintenance });
    try {
      const { cookie } = await ts.seedLogin({ email: 'admin@example.test', password: 'test-pass-123', role: 'root' });
      maintenance.active = true;
      expect((await ts.app.inject({ url: '/api/system/update', cookies: { rp_session: cookie } })).json()).toMatchObject({ supported: false });
      expect((await ts.app.inject({ url: '/api/sites', cookies: { rp_session: cookie } })).statusCode).toBe(503);
      expect((await ts.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode).toBe(503);
      expect((await ts.app.inject({ url: '/readyz' })).statusCode).toBe(200);
      expect(maintenance.requests.size).toBe(0);
      Object.assign(maintenance, { allowStatus: false });
      expect((await ts.app.inject({ url: '/api/system/update', cookies: { rp_session: cookie } })).statusCode).toBe(503);
    } finally { await ts.close(); }
  });
});
