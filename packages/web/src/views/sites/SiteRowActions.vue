<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowUpCircle, Check, MoreHorizontal, Play, Square, Trash2 } from 'lucide-vue-next';
import type { SiteView } from '../../api/types';

const { t } = useI18n();

/**
 * 站点行内操作菜单（SitesView 专属局部组件）。
 * kebab 触发 → teleport 到 body 的浮层菜单（避开表格 overflow 裁剪）。
 * 生命周期项由父级在渲染前判定（external 站/viewer 直接不渲染本组件）。
 * 销毁项内联「保留数据卷」勾选，随 destroy 事件回传 keepData。
 */
const props = defineProps<{ site: SiteView; busy?: boolean }>();
const emit = defineEmits<{
  upgrade: [];
  start: [];
  stop: [];
  destroy: [keepData: boolean];
}>();

const MENU_W = 184;
const MENU_H = 208;

const open = ref(false);
const keepData = ref(false);
const btn = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const pos = ref<{ top: number; left: number }>({ top: 0, left: 0 });

const canStart = computed(() => props.site.status === 'stopped');
const canStop = computed(() => props.site.status === 'active');

function place(): void {
  const r = btn.value?.getBoundingClientRect();
  if (!r) return;
  const left = Math.min(Math.max(r.right - MENU_W, 8), window.innerWidth - MENU_W - 8);
  const below = r.bottom + 6;
  const top = below + MENU_H > window.innerHeight ? Math.max(8, r.top - MENU_H - 6) : below;
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
  keepData.value = false;
  place();
  open.value = true;
  void nextTick(bind);
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
  if (ev.key === 'Escape') close();
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
    :disabled="props.busy"
    :aria-label="t('sites.rowActions.more')"
    @click="toggle"
  >
    <MoreHorizontal :size="16" />
  </button>

  <Teleport to="body">
    <Transition name="rp-fade">
      <div
        v-if="open"
        ref="menu"
        class="rp-panel fixed z-[80] overflow-hidden py-1 shadow-[0_16px_40px_rgb(0_0_0/0.5)]"
        :style="{ top: pos.top + 'px', left: pos.left + 'px', width: MENU_W + 'px' }"
        role="menu"
      >
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
      </div>
    </Transition>
  </Teleport>
</template>
