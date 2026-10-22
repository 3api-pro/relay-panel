import { describe, it, expect, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createI18n } from 'vue-i18n';
import SettlementsView from '../src/views/SettlementsView.vue';

vi.mock('../src/api/session', () => ({ session: { state: { user: { role: 'root' }, workspaceRole: 'owner' } } }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { mode: 'manage' } }),
  RouterLink: { setup: (_: unknown, { slots }: { slots: { default?: () => unknown } }) => () => h('a', slots.default?.()) },
}));

describe('settlement workspace rendering', () => {
  it('initializes date-bearing financial drafts before rendering the administrator workspace', async () => {
    const app = createSSRApp(SettlementsView);
    app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: {} } }));
    const html = await renderToString(app);
    expect(html).toContain('合作结算单');
    expect(html).toContain('新建结算单');
    expect(html).toContain('共享给我的结算单');
  });
});
