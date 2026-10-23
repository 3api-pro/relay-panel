// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import SiteRowActions from '../src/views/sites/SiteRowActions.vue';
import SiteRemoveDialog from '../src/views/sites/SiteRemoveDialog.vue';
import type { SiteView } from '../src/api/types';
import sites from '../src/locales/zh/sites.json';
import common from '../src/locales/zh/common.json';
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../src/api/client', () => api);
vi.mock('../src/components/ui/toast', () => ({ toast: { success: vi.fn() } }));
const site = { slug: 'failed-site', label: '失败站点', status: 'failed:compose-up', managed: 'compose', activeJob: null } as SiteView;
let app: App, host: HTMLElement;
async function flush() { for (let i=0;i<10;i++) { await Promise.resolve(); await nextTick(); } }
async function mount(component: typeof SiteRowActions | typeof SiteRemoveDialog, props: Record<string, unknown>) {
  host = document.createElement('div'); document.body.append(host); app = createApp(component, props);
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { sites, common } } })); app.mount(host); await flush();
}
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; vi.clearAllMocks(); });
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;
describe('site actions', () => {
  it('places the menu in a fixed body overlay and closes with Escape or outside click', async () => {
    await mount(SiteRowActions, { site, lifecycleEnabled: true });
    const trigger = host.querySelector('button')!; trigger.click(); await flush();
    expect(menu().style.position).toBe('fixed'); expect(host.contains(menu())).toBe(false); expect(trigger.getAttribute('aria-expanded')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush(); expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger);
    trigger.click(); await flush(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await flush(); expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it.each([{ managed: 'compose', lifecycleEnabled: false }, { managed: 'external', lifecycleEnabled: true }])('offers panel removal without unsupported lifecycle actions: %j', async options => {
    const removed = vi.fn(); await mount(SiteRowActions, { site: { ...site, managed: options.managed }, lifecycleEnabled: options.lifecycleEnabled, onRemove: removed });
    host.querySelector('button')!.click(); await flush(); expect(menu().querySelectorAll('button')).toHaveLength(1);
    menu().querySelector('button')!.click(); await flush(); expect(removed).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
  });
  it('disables actions for a task still running or awaiting review', async () => {
    await mount(SiteRowActions, { site: { ...site, activeJob: { id: 1, status: 'uncertain', kind: 'provision' } } });
    expect(host.querySelector('button')!.disabled).toBe(true);
  });
  it('requires the visible site name and blocks duplicate removal submissions', async () => {
    let resolve!: (value: object) => void; api.post.mockImplementation(() => new Promise(r => { resolve = r; })); const removed = vi.fn();
    await mount(SiteRemoveDialog, { open: true, site, onRemoved: removed });
    const action = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '从面板移除')!;
    expect(action.disabled).toBe(true); const input=document.querySelector('input')!; input.value=site.label; input.dispatchEvent(new Event('input')); await flush(); expect(action.disabled).toBe(false);
    action.click(); await flush(); action.click(); await flush(); expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/sites/failed-site/remove', { confirm: site.slug, preserveResources: true }); expect(removed).not.toHaveBeenCalled();
    resolve({ removed: true }); await flush(); expect(removed).toHaveBeenCalledOnce();
  });
});
