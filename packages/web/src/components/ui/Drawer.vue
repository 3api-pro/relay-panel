<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue';
import { X } from 'lucide-vue-next';

/** 右侧滑出抽屉：v-model:open；任务详情/明细查看用 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    /** 宽度 CSS 值 */
    width?: string;
  }>(),
  { title: '', width: '480px' },
);

const emit = defineEmits<{ 'update:open': [v: boolean]; close: [] }>();

function close(): void {
  emit('update:open', false);
  emit('close');
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close();
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="rp-fade">
      <div v-if="props.open" class="fixed inset-0 z-[60] bg-black/45" @mousedown.self="close" />
    </Transition>
    <Transition name="rp-slide">
      <aside
        v-if="props.open"
        class="fixed inset-y-0 right-0 z-[65] flex w-full flex-col border-l border-border bg-panel shadow-[-16px_0_48px_rgb(0_0_0/0.45)]"
        :style="{ maxWidth: props.width }"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <slot name="title">
            <h2 class="text-sm font-semibold">{{ props.title }}</h2>
          </slot>
          <button
            type="button"
            class="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-text"
            aria-label="关闭"
            @click="close"
          >
            <X :size="16" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
