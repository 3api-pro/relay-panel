import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { setUnauthorizedHandler } from './api/client';
import { session } from './api/session';
import Shell from './layouts/Shell.vue';
import LoginView from './views/LoginView.vue';
import OverviewView from './views/OverviewView.vue';

/**
 * 路由表：除 H1 实现的三个视图外，其余全部指向占位视图。
 * H2 各 agent 替换方式：改对应 route 的 component 为
 *   () => import('./views/XxxView.vue')
 * 不要动守卫与其它路由行。
 */

declare module 'vue-router' {
  interface RouteMeta {
    /** 顶栏与占位页标题 */
    title?: string;
    /** 免登录页面 */
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView, meta: { title: '登录', public: true } },
  { path: '/signup', component: () => import('./views/SignupView.vue'), meta: { title: '注册', public: true } },
  // 登出态门面（获客漏斗落地页）：裸首页未登录时由守卫重定向到此
  { path: '/welcome', component: () => import('./views/LandingView.vue'), meta: { title: 'relay-panel', public: true } },
  // 组件厨房：仅 dev 构建注册
  ...(import.meta.env.DEV
    ? [{ path: '/kitchen', component: () => import('./views/DevKitchenSink.vue'), meta: { title: '组件厨房', public: true } }]
    : []),
  {
    path: '/',
    component: Shell,
    children: [
      { path: '', component: OverviewView, meta: { title: '总览' } },
      { path: 'sites', component: () => import('./views/SitesView.vue'), meta: { title: '站点' } },
      { path: 'sites/:slug', component: () => import('./views/SiteDetailView.vue'), meta: { title: '站点详情' } },
      { path: 'marketplace', component: () => import('./views/MarketplaceView.vue'), meta: { title: '渠道市场' } },
      { path: 'ledger', component: () => import('./views/LedgerView.vue'), meta: { title: '账本' } },
      { path: 'alerts', component: () => import('./views/AlertsView.vue'), meta: { title: '告警' } },
      { path: 'jobs', component: () => import('./views/JobsView.vue'), meta: { title: '任务' } },
      { path: 'operators', component: () => import('./views/OperatorsView.vue'), meta: { title: '操作员' } },
      { path: 'billing', component: () => import('./views/BillingView.vue'), meta: { title: '计费' } },
      { path: 'batch', component: () => import('./views/BatchView.vue'), meta: { title: '批量操作' } },
      { path: 'help', component: () => import('./views/HelpView.vue'), meta: { title: '帮助与支持' } },
      { path: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 401 统一出口：清会话并带回跳地址去登录页（client.ts 无法 import router，走注册回调）
setUnauthorizedHandler(() => {
  session.clear();
  const current = router.currentRoute.value;
  if (current.path !== '/login') {
    void router.push({ path: '/login', query: current.fullPath !== '/' ? { redirect: current.fullPath } : {} });
  }
});

// 守卫：boot 时 GET /api/auth/me 缓存到 session store；未登录跳 /login
router.beforeEach(async (to) => {
  if (to.meta.public) {
    // 已登录访问登录页 / 落地页 → 回后台总览
    if (to.path === '/login' || to.path === '/welcome') {
      const me = await session.ensureLoaded();
      if (me) return { path: '/' };
    }
    return true;
  }
  const me = await session.ensureLoaded();
  if (!me) {
    // 裸首页未登录 → 落地页（获客门面，不带 redirect）；其它深链 → 登录页带回跳地址
    if (to.path === '/') return { path: '/welcome' };
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · relay-panel` : 'relay-panel';
});
