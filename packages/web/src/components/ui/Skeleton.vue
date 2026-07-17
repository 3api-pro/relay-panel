<script setup lang="ts">
/**
 * 骨架屏：单条（height/width）或多行文本（lines>1 时 width 忽略，行宽递减）。
 */
const props = withDefaults(
  defineProps<{
    height?: string;
    width?: string;
    lines?: number;
    rounded?: string;
  }>(),
  { height: '14px', width: '100%', lines: 1, rounded: '6px' },
);

/** 多行时行宽递减，模拟文本段落 */
function lineWidth(i: number): string {
  if (props.lines === 1) return props.width;
  const widths = ['100%', '92%', '76%', '84%', '60%'];
  return widths[(i - 1) % widths.length] ?? '80%';
}
</script>

<template>
  <div class="space-y-2" aria-hidden="true">
    <div
      v-for="i in props.lines"
      :key="i"
      class="rp-shimmer"
      :style="{ height: props.height, width: lineWidth(i), borderRadius: props.rounded }"
    />
  </div>
</template>
