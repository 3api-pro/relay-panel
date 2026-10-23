<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowUpCircle, Check, MoreHorizontal, Play, Square, Trash2 } from 'lucide-vue-next';
import type { SiteView } from '../../api/types';

const { t } = useI18n();

/**
 * 站点行内操作菜单（SitesView 专属局部组件）。
 * kebab 触发 → teleport 到 body 的浮层菜单（避开表格 overflow 裁剪）。
 * 接入站与 SaaS 仅提供面板移除；本机生命周期操作需要自部署权限。
 * 销毁项内联「保留数据卷」勾选，随 destroy 事件回传 keepData。
 */
const props = defineProps<{ site: SiteView; busy?: boolean; lifecycleEnabled?: boolean }>();
const emit = defineEmits<{
  remove: [];
  upgrade: [];
  start: [];
  stop: [];
  destroy: [keepData: boolean];
}>();

const MENU_W = 184;


const open = ref(false);
const keepData = ref(false);
const btn = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const pos = ref<{ top: number; left: number }>({ top: 0, left: 0 });

const canLifecycle = computed(() => props.lifecycleEnabled === true && props.site.managed === 'compose' && !props.site.readonly);
const disabled = computed(() => props.busy || Boolean(props.site.activeJob));
const canStart = computed(() => props.site.status === 'stopped');
const canStop = computed(() => props.site.status === 'active');

function place(): void {
  const r = btn.value?.getBoundingClientRect();
  if (!r) return;
  const left = Math.min(Math.max(r.right - MENU_W, 8), window.innerWidth - MENU_W - 8);
  const height = menu.value?.getBoundingClientRect().height ?? 0;
  const below = r.bottom + 6;
  const top = below + height > window.innerHeight ? Math.max(8, r.top - height - 6) : below;
  pos.value = { top, left };
}

function bind(): void {
  window.addEventListener('mousedown', onOutside, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('keydown', onKey);
}
function unbind(): void {
  window.removeEventListener('mousedown', onOutside, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('keydown', onKey);
}

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  if (disabled.value) return;
  keepData.value = false;
  open.value = true;
  void nextTick(() => {
    if (!open.value) return;
    place();
    menu.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    bind();
  });
}
function close(): void {
  if (!open.value) return;
  open.value = false;
  unbind();
}
function onOutside(ev: MouseEvent): void {
  const t = ev.target as Node;
  if (btn.value?.contains(t) || menu.value?.contains(t)) return;
  close();
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') { ev.preventDefault(); close(); btn.value?.focus({ preventScroll: true }); }
  if (ev.key === 'Tab') close();
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
    ev.preventDefault();
    const items = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : (current + (ev.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }
}

function pick(action: 'upgrade' | 'start' | 'stop'): void {
  close();
  if (action === 'upgrade') emit('upgrade');
  else if (action === 'start') emit('start');
  else emit('stop');
}
function pickDestroy(): void {
  const keep = keepData.value;
  close();
  emit('destroy', keep);
}

onBeforeUnmount(() => {
  unbind();
});
</script>

<template>
  <button
    ref="btn"
    type="button"
    class="inline-flex size-7 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border hover:bg-panel-2 hover:text-text"
    :class="open ? 'border-border bg-panel-2 text-text' : ''"
    :disabled="disabled"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-label="t('sites.rowActions.more')"
    @click.stop="toggle"
    @keydown.down.prevent="!open && toggle()"
  >
    <MoreHorizontal :size="16" />
  </button>

  <Teleport to="body">
    <Transition name="rp-fade">
      <div
        v-if="open"
        ref="menu"
        class="rp-panel z-[80] overflow-y-auto py-1 shadow-[0_16px_40px_rgb(0_0_0/0.5)]"
        :style="{ position: 'fixed', maxHeight: 'calc(100dvh - 16px)', top: pos.top + 'px', left: pos.left + 'px', width: MENU_W + 'px' }"
        role="menu"
        :aria-label="t('sites.rowActions.more')"
        @click.stop
      >
        <template v-if="canLifecycle">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-panel-2"
            role="menuitem"
            @click="pick('upgrade')"
          >
            <ArrowUpCircle :size="14" class="text-muted" />
            {{ t('sites.rowActions.upgrade') }}
          </button>

          <button
            v-if="canStop"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-panel-2"
            role="menuitem"
            @click="pick('stop')"
          >
            <Square :size="14" class="text-muted" />
            {{ t('sites.rowActions.stop') }}
          </button>
          <button
            v-else-if="canStart"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-panel-2"
            role="menuitem"
            @click="pick('start')"
          >
            <Play :size="14" class="text-muted" />
            {{ t('sites.rowActions.start') }}
          </button>

          <div class="my-1 border-t border-border/70" />

          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-panel-2 hover:text-text"
            role="menuitemcheckbox"
            :aria-checked="keepData"
            @click.stop="keepData = !keepData"
          >
            <span
              class="inline-flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors"
              :class="keepData ? 'border-accent bg-accent/20 text-accent' : 'border-border-2'"
            >
              <Check v-if="keepData" :size="11" />
            </span>
            {{ t('sites.rowActions.keepData') }}
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red transition-colors hover:bg-red/10"
            role="menuitem"
            @click="pickDestroy"
          >
            <Trash2 :size="14" />
            {{ t('sites.rowActions.destroy') }}
          </button>
        </template>
        <div v-if="canLifecycle" class="my-1 border-t border-border/70" />
        <button type="button" role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red transition-colors hover:bg-red/10"
          @click="close(); emit('remove')">
          <Trash2 :size="14" /> {{ t('sites.remove.menu') }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
