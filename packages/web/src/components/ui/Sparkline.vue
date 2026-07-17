<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * 迷你趋势线（统计卡装饰用，无轴无提示）。
 * viewBox 拉伸 + non-scaling-stroke 保持线宽恒定。
 */
const props = withDefaults(
  defineProps<{
    points: number[];
    height?: number;
    color?: string;
  }>(),
  { height: 28, color: '#6d8bff' },
);

const gradId = `spark-grad-${useId()}`;

const VW = 100;
const VH = 28;

const coords = computed(() => {
  const n = props.points.length;
  if (n < 2) return [];
  const max = Math.max(...props.points, 1e-9);
  const min = Math.min(...props.points, 0);
  const span = max - min || 1;
  return props.points.map((v, i) => ({
    x: (i / (n - 1)) * VW,
    y: 2 + (1 - (v - min) / span) * (VH - 4),
  }));
});

const linePath = computed(() =>
  coords.value.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' '),
);

const areaPath = computed(() => {
  if (coords.value.length === 0) return '';
  const first = coords.value[0]!;
  const last = coords.value[coords.value.length - 1]!;
  return `${linePath.value} L${last.x.toFixed(2)},${VH} L${first.x.toFixed(2)},${VH} Z`;
});
</script>

<template>
  <svg
    v-if="coords.length > 0"
    class="block w-full"
    :style="{ height: `${props.height}px` }"
    :viewBox="`0 0 ${VW} ${VH}`"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="props.color" stop-opacity="0.16" />
        <stop offset="100%" :stop-color="props.color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path :d="areaPath" :fill="`url(#${gradId})`" />
    <path
      :d="linePath"
      fill="none"
      :stroke="props.color"
      stroke-width="1.5"
      vector-effect="non-scaling-stroke"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
</template>
