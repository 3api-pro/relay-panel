<script setup lang="ts">
import type { Component } from 'vue';
import { Inbox } from 'lucide-vue-next';

/** 空状态：图标 + 标题 + 说明 + 可选操作插槽 */
const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: Component;
  }>(),
  { description: '', icon: undefined },
);
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 py-6 text-center">
    <div class="rounded-xl border border-border bg-panel-2/60 p-3 text-muted/70">
      <component :is="props.icon ?? Inbox" :size="20" />
    </div>
    <p class="text-[13px] font-medium text-text/80">{{ props.title }}</p>
    <p v-if="props.description" class="max-w-[320px] text-xs leading-relaxed text-muted">{{ props.description }}</p>
    <div v-if="$slots.default" class="mt-1.5">
      <slot />
    </div>
  </div>
</template>
