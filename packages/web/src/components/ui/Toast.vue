<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from 'lucide-vue-next';
import { useToast, type ToastTone } from './toast';

// toast 渲染宿主：App.vue 挂一次；状态在 toast.ts 单例里
const { toasts, dismiss } = useToast();

const iconOf: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

const toneClass: Record<ToastTone, string> = {
  info: 'text-accent',
  success: 'text-green',
  error: 'text-red',
};
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex flex-col items-center gap-2 px-4">
      <TransitionGroup name="rp-toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="rp-panel pointer-events-auto flex max-w-[420px] items-center gap-2.5 py-2.5 pl-3.5 pr-2 shadow-[0_12px_32px_rgb(0_0_0/0.45)]"
        >
          <component :is="iconOf[t.tone]" :size="16" :class="toneClass[t.tone]" class="shrink-0" />
          <p class="min-w-0 flex-1 break-words text-[13px] leading-snug">{{ t.message }}</p>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-text"
            aria-label="关闭"
            @click="dismiss(t.id)"
          >
            <X :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
