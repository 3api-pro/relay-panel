<script setup lang="ts">
import { computed, type Component } from 'vue';
import Sparkline from './Sparkline.vue';

/**
 * 统计卡：微标签 + 大数字（tabular-nums）+ 可选提示/图标/迷你趋势线。
 * tone 只染数值色（状态语义保留给状态色，默认白）。
 */
const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    tone?: 'default' | 'accent' | 'green' | 'red' | 'amber';
    icon?: Component;
    /** 迷你趋势线数据（可选） */
    spark?: number[];
    loading?: boolean;
  }>(),
  { hint: '', tone: 'default', icon: undefined, spark: undefined, loading: false },
);

const valueClass = computed(() => {
  switch (props.tone) {
    case 'accent':
      return 'text-accent';
    case 'green':
      return 'text-green';
    case 'red':
      return 'text-red';
    case 'amber':
      return 'text-amber';
    default:
      return 'text-text';
  }
});
</script>

<template>
  <section class="rp-panel rp-panel-hover relative overflow-hidden p-4">
    <div class="flex items-start justify-between gap-2">
      <p class="rp-microlabel">{{ props.label }}</p>
      <component :is="props.icon" v-if="props.icon" :size="15" class="mt-px shrink-0 text-muted/70" />
    </div>
    <div v-if="props.loading" class="rp-shimmer mt-2.5 h-7 w-24 rounded-md" />
    <p v-else class="tnum mt-1.5 text-[26px] font-semibold leading-none tracking-tight" :class="valueClass">
      {{ props.value }}
    </p>
    <p v-if="props.hint" class="mt-1.5 truncate text-xs text-muted">{{ props.hint }}</p>
    <div v-if="props.spark && props.spark.length > 1" class="mt-2.5 -mb-1">
      <Sparkline :points="props.spark" :height="28" />
    </div>
    <slot />
  </section>
</template>
