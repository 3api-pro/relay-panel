<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch, type Component } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Bell,
  Menu,
  X,
  ShieldCheck,
  BookOpen,
  CreditCard,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Server,
  Settings,
  ShieldAlert,
  Store,
  TrendingUp,
  UserRound,
  Users,
  Wallet,
} from 'lucide-vue-next';
import { session } from '../api/session';
import { navigationFor, type NavigationItem } from '../navigation';
import Badge from '../components/ui/Badge.vue';
import ThemeToggle from '../components/ThemeToggle.vue';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';
import VersionBadge from '../components/VersionBadge.vue';

/**
 * 应用壳：玻璃侧导航轨 + 玻璃顶栏。
 * provide('canWrite')：viewer 角色为 false，L2 视图 inject 它隐藏写按钮。
 * 导航文案走 i18n t('nav.*')。
 */
const route = useRoute();
const { t } = useI18n();

provide('canWrite', session.canWrite);

const icons: Record<string, Component> = {
  overview: LayoutDashboard, finance: TrendingUp, upstream: Wallet, sites: Server,
  batch: Layers, marketplace: Store, ledger: BookOpen, alerts: Bell, risk: ShieldAlert,
  customers: UserRound, jobs: ListChecks, operators: Users, billing: CreditCard,
  settings: Settings, account: UserRound, help: LifeBuoy,
};
const navGroups = computed(() => navigationFor(session.state.user?.role ?? 'operator').map(g => ({ ...g, items: g.items.filter(i => session.state.workspaceRole === 'owner' || !i.to.startsWith('/billing')) })));
const navItems = computed(() => navGroups.value.flatMap(g => g.items));
const mainGroups = computed(() => navGroups.value.filter(g => g.key !== 'groupAccount'));
const accountItems = computed(() => navGroups.value.find(g => g.key === 'groupAccount')?.items ?? []);
const activeGroup = computed(() => navGroups.value.find(g => g.items.some(isActive)));
const mobileOpen = ref(false);
const isMobile = ref(false);
const rail = ref<HTMLElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
let media: MediaQueryList | undefined;
let previousOverflow = '';
function syncViewport(): void {
  isMobile.value = media?.matches ?? false;
  if (!isMobile.value) mobileOpen.value = false;
}
async function closeMenu(restoreFocus = true): Promise<void> {
  mobileOpen.value = false;
  if (restoreFocus) await nextTick(() => menuButton.value?.focus());
}
function onRailKeydown(event: KeyboardEvent): void {
  if (!isMobile.value || !mobileOpen.value) return;
  if (event.key === 'Escape') { event.preventDefault(); void closeMenu(); }
  if (event.key !== 'Tab') return;
  const links = rail.value?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
  if (!links?.length) return;
  const first = links[0]!;
  const last = links[links.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
watch(mobileOpen, async open => {
  if (open) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    await nextTick();
    rail.value?.querySelector<HTMLElement>('button, a[href]')?.focus();
  } else document.body.style.overflow = previousOverflow;
});
watch(() => route.fullPath, () => { void closeMenu(false); });
onMounted(() => {
  media = window.matchMedia('(max-width: 1023px)');
  syncViewport();
  media.addEventListener('change', syncViewport);
});
onBeforeUnmount(() => {
  media?.removeEventListener('change', syncViewport);
  if (mobileOpen.value) document.body.style.overflow = previousOverflow;
});

function isActive(item: NavigationItem): boolean {
  if (item.to === '/') return route.path === '/';
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

const user = computed(() => session.state.user);
const isRoot = session.isRoot;

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
    <a href="#main-content" class="rp-skip-link">{{ t('nav.skipToContent') }}</a>
    <div v-if="mobileOpen" class="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm lg:hidden" aria-hidden="true" @click="closeMenu()" />
    <aside
      id="primary-navigation" ref="rail"
      class="rp-rail fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col"
      :class="{ 'rp-rail-open': mobileOpen }"
      :role="isMobile && mobileOpen ? 'dialog' : undefined"
      :aria-modal="isMobile && mobileOpen ? true : undefined"
      :aria-label="t('nav.navigation')"
      @keydown="onRailKeydown"
    >
      <div class="flex h-16 shrink-0 items-center justify-between px-5">
        <RouterLink to="/" class="text-[16px] font-semibold tracking-tight">relay<span class="text-accent">/</span>panel</RouterLink>
        <button class="rounded-lg p-2 text-muted lg:hidden" :aria-label="t('nav.closeMenu')" @click="closeMenu()"><X :size="18" /></button>
      </div>
      <div class="mx-3 mb-2 flex items-center gap-2.5 rounded-xl border border-[var(--glass-border)] bg-panel-2/50 px-3 py-2.5">
        <ShieldCheck v-if="isRoot" :size="17" class="shrink-0 text-accent" />
        <Server v-else :size="17" class="shrink-0 text-accent" />
        <div class="min-w-0">
          <p class="text-xs font-semibold">{{ t(isRoot ? 'nav.adminWorkspace' : user?.role === 'viewer' ? 'nav.viewerWorkspace' : 'nav.userWorkspace') }}</p>
          <p class="mt-0.5 text-[10px] text-muted">{{ t(isRoot ? 'nav.adminScope' : user?.role === 'viewer' ? 'nav.viewerScope' : 'nav.userScope') }}</p>
        </div>
      </div>
      <RouterLink v-if="session.state.workspaceName" to="/team" class="mx-3 rounded border border-border px-3 py-2 text-xs text-accent">{{ session.state.workspaceName }} · {{ t(`team.${session.state.workspaceRole}`) }}</RouterLink>
      <nav class="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3" :aria-label="t('nav.navigation')">
        <section v-for="group in mainGroups" :key="group.key" :aria-labelledby="`nav-${group.key}`">
          <h2 :id="`nav-${group.key}`" class="mb-1.5 px-2.5 text-[10px] font-semibold tracking-wide text-muted/70">{{ t(`nav.${group.key}`) }}</h2>
          <RouterLink
            v-for="item in group.items" :key="item.to" :to="item.to"
            class="rp-nav-link group relative mb-0.5 flex min-h-9 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] transition-colors"
            :class="isActive(item) ? 'rp-nav-active font-medium text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text'"
            :aria-current="isActive(item) ? 'page' : undefined"
            @click="closeMenu(false)"
          >
            <component :is="icons[item.icon]" :size="15" class="shrink-0" :class="isActive(item) ? 'text-accent' : 'text-muted/80'" />
            {{ t(`nav.${item.key}`) }}
          </RouterLink>
        </section>
      </nav>
      <nav class="space-y-0.5 border-t border-[var(--glass-border)] px-3 py-2" :aria-label="t('nav.groupAccount')">
        <RouterLink v-for="item in accountItems" :key="item.to" :to="item.to"
          class="rp-nav-link flex min-h-9 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px]"
          :class="isActive(item) ? 'rp-nav-active text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text'"
          :aria-current="isActive(item) ? 'page' : undefined" @click="closeMenu(false)">
          <component :is="icons[item.icon]" :size="15" />{{ t(`nav.${item.key}`) }}
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
    <div class="flex min-w-0 flex-1 flex-col lg:pl-[248px]" :inert="isMobile && mobileOpen ? true : undefined">
      <!-- 顶栏（玻璃条，sticky，背景透过） -->
      <header class="rp-topbar sticky top-0 z-30 flex min-h-16 items-center justify-between gap-2 px-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <button ref="menuButton" type="button" class="shrink-0 rounded-lg p-2 text-muted hover:bg-panel-2 lg:hidden"
            :aria-label="t('nav.openMenu')" :aria-expanded="mobileOpen" aria-controls="primary-navigation" @click="mobileOpen = true"><Menu :size="20" /></button>
          <div class="min-w-0">
            <p class="text-[10px] text-muted">{{ activeGroup ? t(`nav.${activeGroup.key}`) : '' }}</p>
            <h1 class="truncate text-sm font-semibold">{{ pageTitle }}</h1>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="hidden max-w-[220px] truncate text-xs text-muted xl:inline">{{ user?.email }}</span>
          <div class="mx-1 hidden h-4 w-px bg-[var(--glass-border)] sm:block" />
          <!-- 版本徽章：仅 root（部署者）可见，有新版发行时琥珀提示 -->
          <VersionBadge v-if="isRoot" class="hidden sm:block" />
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main id="main-content" tabindex="-1" class="min-w-0 flex-1 px-4 py-5 outline-none sm:px-6">
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
.rp-nav-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.rp-skip-link { position: fixed; top: -100px; left: 1rem; z-index: 100; padding: 0.75rem 1rem; background: var(--color-panel); color: var(--color-text); }
.rp-skip-link:focus { top: 1rem; }
@media (max-width: 1023px) {
  .rp-rail { transform: translateX(-100%); visibility: hidden; transition: transform 180ms ease, visibility 180ms; width: min(288px, 85vw); background: var(--color-panel); }
  .rp-rail-open { transform: translateX(0); visibility: visible; }
}
@media (prefers-reduced-motion: reduce) { .rp-rail { transition: none; } }
</style>
