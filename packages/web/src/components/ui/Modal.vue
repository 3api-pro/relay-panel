<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue';
import { X } from 'lucide-vue-next';

/**
 * 居中弹窗：v-model:open 控制；ESC / 遮罩点击关闭（closable=false 时禁用）。
 * slots：default 内容 / footer 操作区
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    /** 最大宽度 CSS 值 */
    width?: string;
    closable?: boolean;
  }>(),
  { title: '', width: '520px', closable: true },
);

const emit = defineEmits<{ 'update:open': [v: boolean]; close: [] }>();

function close(): void {
  if (!props.closable) return;
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
      <div
        v-if="props.open"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
        @mousedown.self="close"
      >
        <Transition name="rp-pop" appear>
          <div
            class="rp-panel flex max-h-[85vh] w-full flex-col shadow-[0_24px_64px_rgb(0_0_0/0.55)]"
            :style="{ maxWidth: props.width }"
            role="dialog"
            aria-modal="true"
          >
            <header v-if="props.title || $slots.title" class="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <slot name="title">
                <h2 class="text-sm font-semibold">{{ props.title }}</h2>
              </slot>
              <button
                v-if="props.closable"
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
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
