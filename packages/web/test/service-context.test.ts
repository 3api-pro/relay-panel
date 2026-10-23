// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import ServiceCenterView from '../src/views/ServiceCenterView.vue';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), downloadFile: vi.fn() }));
vi.mock('../src/api/client', () => api);
vi.mock('../src/api/session', () => ({ session: { state: { user: { role: 'root' }, workspaceRole: 'owner' }, canWrite: { value: true }, isRoot: { value: true } } }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }));

const cases = [1, 2].map(id => ({ id, kind: 'incident', title: `Case ${id}`, description: `Review case ${id}`, priority: 'normal', status: 'open', version: 1, evidence: null, details: { checks: [] }, partnerId: null, ticketId: null, updatedAt: '2026-01-01' }));
const publication = (siteId: number) => ({ siteId, version: 1, title: `Site ${siteId} title`, body: `Public message for site ${siteId}`, state: 'maintenance', published: false, token: `token-${siteId}` });
const detail = (id: number) => ({ item: cases[id - 1], events: [], historyLimited: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } }
let app: App, host: HTMLDivElement;
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function caseButton(id: number) { return [...host.querySelectorAll('button')].find(b => b.textContent?.includes(`#${id} Case ${id}`))!; }
function field(label: string) { const item = [...host.querySelectorAll('label')].find(e => e.querySelector('span')?.textContent?.trim() === label); return item!.querySelector('input,textarea,select') as HTMLInputElement | HTMLTextAreaElement; }
// The DOM test environment does not include ancestor fieldsets in :disabled matching.
const disabled = (control: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement) => control.disabled || control.closest('fieldset[disabled]') !== null;
function getResult(path: string): unknown {
  const url = new URL(path, 'https://panel.example.test'), siteId = Number(url.searchParams.get('siteId'));
  if (url.pathname.endsWith('/catalog')) return { sites: [1, 2].map(id => ({ id, slug: `site-${id}`, label: `Site ${id}`, engine: 'sub2api', version: '1', managed: 'external', status: 'active' })), checklists: { incident: ['scope'] } };
  if (url.pathname.endsWith('/quality')) return { run: null, records: [], groups: [], sourceScope: 'unavailable', sampleLimited: false, latestEvidenceAt: null };
  if (url.pathname.endsWith('/work')) return { items: siteId === 1 ? cases : [], hasMore: false };
  if (url.pathname.endsWith('/partners')) return { items: [] };
  if (url.pathname.endsWith('/publication')) return { item: publication(siteId) };
  if (url.pathname.endsWith('/collection-settings')) return { enabled: true, intervalMs: 0 };
  if (/\/work\/[12]$/.test(url.pathname)) return detail(Number(url.pathname.split('/').at(-1)));
  throw new Error(`Unexpected request: ${path}`);
}
async function mount() {
  host = document.createElement('div'); document.body.append(host);
  app = createApp(ServiceCenterView);
  app.component('RouterLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }));
  app.use(createI18n({ legacy: false, locale: 'zh', missingWarn: false, fallbackWarn: false, messages: { zh: {} } }));
  app.mount(host); await flush();
}
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => getResult(path));
  api.post.mockReset().mockResolvedValue({}); api.downloadFile.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { app?.unmount(); host?.remove(); });

describe('service workspace request ordering', () => {
  it('serializes case selection so a slow detail cannot overwrite a later selection', async () => {
    const pending = deferred<ReturnType<typeof detail>>();
    api.get.mockImplementation((path: string) => path.endsWith('/work/1') ? pending.promise : Promise.resolve(getResult(path)));
    await mount(); button('事件与交付').click(); await flush();
    caseButton(1).click(); await flush();
    expect(disabled(caseButton(2))).toBe(true);
    caseButton(2).click(); await flush();
    expect(api.get.mock.calls.some(([path]) => path === '/api/services/work/2')).toBe(false);
    pending.resolve(detail(1)); await flush();
    expect(host.textContent).toContain('Review case 1');
    caseButton(2).click(); await flush();
    expect(host.textContent).toContain('Review case 2');
    expect(host.textContent).not.toContain('Review case 1');
  });

  it('clears old publication text on site change and blocks writes while the new scope loads', async () => {
    const pending = deferred<{ item: ReturnType<typeof publication> }>();
    api.get.mockImplementation((path: string) => path === '/api/services/publication?siteId=2' ? pending.promise : Promise.resolve(getResult(path)));
    await mount(); button('客户接入与公告').click(); await flush();
    expect(field('公开说明').value).toBe('Public message for site 1');
    const select = host.querySelector('select')!; select.value = '2'; select.dispatchEvent(new Event('change')); await flush();
    expect(field('公开说明').value).toBe('');
    expect(disabled(field('公开说明'))).toBe(true);
    button('预览公开内容').click(); button('发布以上内容').click(); await flush();
    expect(api.post).not.toHaveBeenCalled();
    pending.resolve({ item: publication(2) }); await flush();
    expect(field('公开说明').value).toBe('Public message for site 2');
    expect(disabled(field('公开说明'))).toBe(false);
    button('预览公开内容').click(); await flush(); button('发布以上内容').click(); await flush();
    expect(api.post).toHaveBeenCalledWith('/api/services/publication', expect.objectContaining({ siteId: 2, body: 'Public message for site 2', published: true }));
  });

  it('requires a fresh preview after editing the publication and blocks duplicate writes', async () => {
    const pending = deferred<object>(); api.post.mockReturnValue(pending.promise);
    await mount(); button('客户接入与公告').click(); await flush();
    button('预览公开内容').click(); await flush(); expect(button('发布以上内容').disabled).toBe(false);
    field('公开说明').value = 'Changed content requiring review'; field('公开说明').dispatchEvent(new Event('input')); await flush();
    expect(button('发布以上内容').disabled).toBe(true);
    button('预览公开内容').click(); await flush(); button('发布以上内容').click(); await flush();
    expect(disabled(field('公开说明'))).toBe(true);
    button('保存草稿 / 撤回公开页面').click(); await flush(); expect(api.post).toHaveBeenCalledTimes(1);
    pending.resolve({}); await flush();
    expect(disabled(field('公开说明'))).toBe(false);
  });
});

describe('service overview and detail scope', () => {
  function evidence(flagged: number) {
    const time = new Date().toISOString();
    return { run: {status:'complete',updatedAt:time,error:null},records:[],groups:[{channelId:'1',model:'sample-model',records:20,errorLogs:flagged,latestEvidenceAt:time,freshness:'recent',flagged}],sourceScope:'consume-and-error-logs',sampleLimited:false,latestEvidenceAt:time };
  }
  it('keeps today’s site-wide issue visible when a clean model is selected below', async () => {
    api.get.mockImplementation(async (path: string) => {
      const url = new URL(path,'https://panel.example.test');
      if (url.pathname.endsWith('/quality')) return evidence(url.searchParams.has('model') ? 0 : 5);
      if (url.pathname.endsWith('/work')) return {items:[],hasMore:false};
      return getResult(path);
    });
    await mount();expect(host.querySelector('[data-status]')?.getAttribute('data-status')).toBe('signals');
    const model = field('模型（精确匹配）');model.value='clean-model';model.dispatchEvent(new Event('input'));await flush();
    button('查询已有证据').click();await flush();
    expect(host.querySelector('[data-status]')?.getAttribute('data-status')).toBe('signals');
    expect(host.querySelector('[aria-label="今日服务概览"]')?.textContent).toContain('5 条记录需要核查');
    expect(host.querySelector('#service-quality-results')?.textContent).toContain('当前为筛选结果');
    expect(host.querySelector('#service-quality-results')?.textContent).toContain('未发现异常');
  });
  it('shows a clean observed scope without a persistent warning for partial consumption-only logs', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.includes('/quality?')) { const r=evidence(0);r.run.status='partial';r.sourceScope='consumption-only';r.sampleLimited=true;return r; }
      if (path.includes('/work?')) return {items:[],hasMore:false};
      return getResult(path);
    });
    await mount();const overview=host.querySelector('[aria-label="今日服务概览"]')!;
    expect(overview.getAttribute('data-tone')).toBe('green');
    expect(overview.querySelector('h2')?.textContent).toBe('未发现异常');
    expect(overview.textContent).toContain('今日已观测 20 条请求记录');
    expect(overview.querySelector('.text-amber')).toBeNull();
    const scope=overview.querySelector('details')!;expect(scope.open).toBe(false);
    expect(scope.textContent).toContain('不包含全部失败请求');
    expect(scope.textContent).toContain('日志仍在同步');
    expect(scope.textContent).toContain('已达到样本上限');
    expect(host.querySelector('#service-quality-results .text-amber')).toBeNull();
  });

  it('removes a clear conclusion when a refresh cannot load data', async () => {
    let failed = false;
    api.get.mockImplementation(async (path: string) => {
      if (path.includes('/quality?')) { if (failed) throw new Error('Read failed'); return evidence(0); }
      if (path.includes('/work?')) return {items:[],hasMore:false};
      return getResult(path);
    });
    await mount();expect(host.querySelector('[data-status]')?.getAttribute('data-status')).toBe('clear');
    failed=true;button('刷新概览').click();await flush();
    expect(host.querySelector('[data-status]')?.getAttribute('data-status')).toBe('unavailable');
    expect(host.querySelector('[aria-label="今日服务概览"]')?.textContent).not.toContain('未发现异常');
  });
  it('takes the pending-work action to a filtered queue without creating anything', async () => {
    await mount();button('查看待处理事项').click();await flush();
    expect((host.querySelector('#service-work-queue input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });
});
