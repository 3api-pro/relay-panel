<script setup lang="ts">
import { computed, provide, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Bell,
  BookOpen,
  CreditCard,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Server,
  Settings,
  Store,
  Users,
} from 'lucide-vue-next';
import { session } from '../api/session';
import Badge from '../components/ui/Badge.vue';

/**
 * 应用壳：左侧导航 + 顶栏。
 * provide('canWrite')：viewer 角色为 false，H2 视图 inject 它隐藏写按钮。
 */
const route = useRoute();
const router = useRouter();

// H2 视图统一 inject<ComputedRef<boolean>>('canWrite')
provide('canWrite', session.canWrite);

interface NavItem {
  to: string;
  label: string;
  icon: Component;
  rootOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/sites', label: '站点', icon: Server },
  { to: '/marketplace', label: '渠道市场', icon: Store },
  { to: '/ledger', label: '账本', icon: BookOpen },
  { to: '/alerts', label: '告警', icon: Bell },
  { to: '/jobs', label: '任务', icon: ListChecks },
  { to: '/operators', label: '操作员', icon: Users, rootOnly: true },
  { to: '/billing', label: '计费', icon: CreditCard },
  { to: '/settings', label: '设置', icon: Settings },
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
      return { tone: 'accent' as const, text: '管理员' };
    case 'viewer':
      return { tone: 'muted' as const, text: '只读' };
    default:
      return { tone: 'default' as const, text: '操作员' };
  }
});

const pageTitle = computed(() => (typeof route.meta.title === 'string' ? route.meta.title : ''));

async function onLogout(): Promise<void> {
  await session.logout();
  await router.push('/login');
}
</script>

<template>
  <div class="flex min-h-screen">
    <!-- 侧边栏 -->
    <aside class="fixed inset-y-0 left-0 z-40 flex w-[216px] flex-col border-r border-border bg-[#0b0d12]/90">
      <!-- 品牌字标 -->
      <RouterLink to="/" class="flex h-14 items-center gap-2 border-b border-border px-5">
        <span class="text-[15px] font-semibold tracking-tight">
          relay<span class="text-accent">/</span>panel
        </span>
      </RouterLink>

      <nav class="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors"
          :class="
            isActive(item)
              ? 'bg-panel-2 font-medium text-text'
              : 'text-muted hover:bg-panel-2/60 hover:text-text'
          "
        >
          <!-- 活跃指示条 -->
          <span
            v-if="isActive(item)"
            class="absolute -left-2.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
          />
          <component
            :is="item.icon"
            :size="15"
            :class="isActive(item) ? 'text-accent' : 'text-muted/80 group-hover:text-muted'"
          />
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- 底部用户区 -->
      <div class="border-t border-border p-3">
        <div class="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <div
            class="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-2 bg-panel-2 text-[11px] font-semibold text-accent"
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
            title="登出"
            aria-label="登出"
            @click="onLogout"
          >
            <LogOut :size="14" />
          </button>
        </div>
      </div>
    </aside>

    <!-- 主区 -->
    <div class="flex min-w-0 flex-1 flex-col pl-[216px]">
      <!-- 顶栏 -->
      <header
        class="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg/80 px-6 backdrop-blur-md"
      >
        <h1 class="text-sm font-semibold">{{ pageTitle }}</h1>
        <div class="flex items-center gap-2 text-xs text-muted">
          <span class="hidden truncate sm:inline">{{ user?.email }}</span>
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
