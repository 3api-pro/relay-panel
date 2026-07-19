<script setup lang="ts">
import { computed, provide, type Component } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Bell,
  BookOpen,
  CreditCard,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Server,
  Settings,
  Store,
  Users,
} from 'lucide-vue-next';
import { session } from '../api/session';
import Badge from '../components/ui/Badge.vue';
import ThemeToggle from '../components/ThemeToggle.vue';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';

/**
 * 应用壳：玻璃侧导航轨 + 玻璃顶栏。
 * provide('canWrite')：viewer 角色为 false，L2 视图 inject 它隐藏写按钮。
 * 导航文案走 i18n t('nav.*')。
 */
const route = useRoute();
const { t } = useI18n();

provide('canWrite', session.canWrite);

interface NavItem {
  to: string;
  key: string; // i18n key: nav.<key>
  icon: Component;
  rootOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', key: 'overview', icon: LayoutDashboard },
  { to: '/sites', key: 'sites', icon: Server },
  { to: '/batch', key: 'batch', icon: Layers },
  { to: '/marketplace', key: 'marketplace', icon: Store },
  { to: '/ledger', key: 'ledger', icon: BookOpen },
  { to: '/alerts', key: 'alerts', icon: Bell },
  { to: '/jobs', key: 'jobs', icon: ListChecks },
  { to: '/operators', key: 'operators', icon: Users, rootOnly: true },
  { to: '/billing', key: 'billing', icon: CreditCard },
  { to: '/settings', key: 'settings', icon: Settings },
  { to: '/help', key: 'help', icon: LifeBuoy },
];

const navItems = computed(() => NAV.filter((n) => !n.rootOnly || session.isRoot.value));

function isActive(item: NavItem): boolean {
  if (item.to === '/') return route.path === '/';
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

const user = computed(() => session.state.user);

const roleBadge = computed(() => {
  switch (user.value?.role) {
    case 'root':
      return { tone: 'accent' as const, text: t('nav.roleRoot') };
    case 'viewer':
      return { tone: 'muted' as const, text: t('nav.roleViewer') };
    default:
      return { tone: 'default' as const, text: t('nav.roleOperator') };
  }
});

// 顶栏标题：优先当前激活顶级导航的译名，回落 route.meta.title
const pageTitle = computed(() => {
  const active = navItems.value.find((n) => isActive(n));
  if (active) return t(`nav.${active.key}`);
  return typeof route.meta.title === 'string' ? route.meta.title : '';
});

async function onLogout(): Promise<void> {
  await session.logout();
  // 硬跳转而非 SPA 路由：彻底重置内存态并绕过浏览器 bfcache（后退键复现已登录页）
  window.location.assign('/login');
}
</script>

<template>
  <div class="flex min-h-screen">
    <!-- 侧边导航轨（玻璃） -->
    <aside class="rp-rail fixed inset-y-0 left-0 z-40 flex w-[224px] flex-col">
      <!-- 品牌字标 -->
      <RouterLink to="/" class="flex h-14 items-center gap-2 border-b border-[var(--glass-border)] px-5">
        <span class="text-[15px] font-semibold tracking-tight">
          relay<span class="text-accent">/</span>panel
        </span>
      </RouterLink>

      <nav class="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="group relative flex items-center gap-2.5 rounded-[11px] px-2.5 py-[7px] text-[13px] transition-all duration-200"
          :class="
            isActive(item)
              ? 'rp-nav-active font-medium text-text'
              : 'text-muted hover:bg-panel-2/50 hover:text-text'
          "
        >
          <!-- 活跃指示条 -->
          <span
            v-if="isActive(item)"
            class="absolute -left-2.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
          />
          <component
            :is="item.icon"
            :size="15"
            :class="isActive(item) ? 'text-accent' : 'text-muted/80 group-hover:text-muted'"
          />
          {{ t(`nav.${item.key}`) }}
        </RouterLink>
      </nav>

      <!-- 底部用户区 -->
      <div class="border-t border-[var(--glass-border)] p-3">
        <div class="flex items-center gap-2.5 rounded-[11px] px-1.5 py-1">
          <div
            class="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--glass-border)] bg-panel-2/70 text-[11px] font-semibold text-accent"
          >
            {{ (user?.displayName || user?.email || '?').slice(0, 1).toUpperCase() }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium">{{ user?.displayName || user?.email }}</p>
            <Badge :tone="roleBadge.tone" size="sm">{{ roleBadge.text }}</Badge>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-red"
            :title="t('nav.logout')"
            :aria-label="t('nav.logout')"
            @click="onLogout"
          >
            <LogOut :size="14" />
          </button>
        </div>
      </div>
    </aside>

    <!-- 主区 -->
    <div class="flex min-w-0 flex-1 flex-col pl-[224px]">
      <!-- 顶栏（玻璃条，sticky，背景透过） -->
      <header class="rp-topbar sticky top-0 z-30 flex h-14 items-center justify-between gap-3 px-6">
        <h1 class="truncate text-sm font-semibold">{{ pageTitle }}</h1>
        <div class="flex items-center gap-2">
          <span class="hidden max-w-[220px] truncate text-xs text-muted sm:inline">{{ user?.email }}</span>
          <div class="mx-1 hidden h-4 w-px bg-[var(--glass-border)] sm:block" />
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main class="min-w-0 flex-1 px-6 py-5">
        <RouterView v-slot="{ Component: ViewComponent }">
          <component :is="ViewComponent" :key="route.path" class="rp-page" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* 玻璃导航轨：半透明 + 模糊 + 右描边 + 顶部内高光 */
.rp-rail {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-right: 1px solid var(--glass-border);
  box-shadow: inset -1px 0 0 0 var(--glass-highlight);
}

/* 玻璃顶栏：背景透过下方内容 */
.rp-topbar {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-bottom: 1px solid var(--glass-border);
}

/* 活跃导航项：玻璃描边填充 */
.rp-nav-active {
  background: color-mix(in oklab, var(--color-panel-2) 75%, transparent);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 0 var(--glass-highlight);
}
</style>
