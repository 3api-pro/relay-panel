// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import VersionBadge from '../src/components/VersionBadge.vue';
import zh from '../src/locales/zh/version.json';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../src/api/client', () => api);
let app: App, host: HTMLDivElement;
let status: Record<string, unknown>;
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } }
function button(text: string) { const b = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text); if (!b) throw new Error(`Missing: ${text}`); return b; }
async function mount() {
  host = document.createElement('div'); document.body.append(host); app = createApp(VersionBadge);
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { version: zh } } })); app.mount(host); await flush();
  host.querySelector('button')!.click(); await flush();
}
beforeEach(() => {
  vi.useFakeTimers(); status = { supported: true, phase: 'idle', error: null, reason: null };
  api.get.mockReset().mockImplementation(async path => path === '/api/system/update' ? { ...status } : { current: '2.14.0', latest: '2.14.1', hasUpdate: true });
  api.post.mockReset().mockImplementation(async () => { status.phase = 'downloading'; return { ...status }; });
});
afterEach(() => { app?.unmount(); host?.remove(); vi.useRealTimers(); });
describe('version badge one-click update', () => {
  it('requires explicit confirmation and sends the displayed target only once', async () => {
    await mount(); button('一键更新').click(); await flush(); expect(api.post).not.toHaveBeenCalled();
    expect(host.textContent).toContain('v2.14.0 → v2.14.1');
    button('备份并更新').click(); button('备份并更新').click(); await flush();
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/system/update', { target: '2.14.1', confirmed: true }, { silent: true });
    expect(host.textContent).toContain('正在下载发行包');
  });
  it('disables updating and explains unmanaged installations', async () => {
    status.supported = false; status.reason = '需要启用管理更新的启动程序'; await mount();
    expect(button('一键更新').disabled).toBe(true); expect(host.textContent).toContain(status.reason);
  });
  it('reconciles a lost response without resubmitting and survives restart disconnects', async () => {
    api.post.mockImplementation(async () => { status.phase = 'restarting'; throw new Error('连接中断'); });
    await mount(); button('一键更新').click(); await flush(); button('备份并更新').click(); await flush();
    expect(api.post).toHaveBeenCalledOnce(); expect(host.textContent).toContain('正在重启面板');
    status.phase = 'succeeded'; status.target = '2.14.1'; await vi.advanceTimersByTimeAsync(3100); await flush();
    expect(host.textContent).toContain('健康检查通过'); expect(button('刷新使用新版')).toBeTruthy();
  });
  it('allows the next release after a previous successful update is already running', async () => {
    status.phase = 'succeeded'; status.target = '2.14.0'; await mount();
    expect(button('一键更新').disabled).toBe(false);
  });
  it('keeps failed updates visible and stops polling after unmount', async () => {
    status.phase = 'failed'; status.error = '备份失败'; await mount(); expect(host.textContent).toContain('备份失败');
    app.unmount(); const count = api.get.mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(api.get).toHaveBeenCalledTimes(count);
  });
});
