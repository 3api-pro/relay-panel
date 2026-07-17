<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

/**
 * 单序列面积图（手写 SVG，无图表库）：2px 线 + 渐变面积 + 克制网格，
 * 悬停十字线 + 提示框。单序列不出图例（标题即命名）。
 * 用法：<AreaChart :points="[{label:'07-01',value:12}]" :format-value="v => `¥${v.toFixed(2)}`" />
 */
export interface AreaPoint {
  label: string;
  value: number;
}

const props = withDefaults(
  defineProps<{
    points: AreaPoint[];
    height?: number;
    /** 序列色（默认 accent） */
    color?: string;
    /** 数值格式化（提示框与 y 轴共用） */
    formatValue?: (v: number) => string;
  }>(),
  { height: 180, color: '#6d8bff', formatValue: undefined },
);

const gradId = `area-grad-${useId()}`;
const wrap = ref<HTMLDivElement | null>(null);
const width = ref(600);
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (!wrap.value) return;
  width.value = Math.max(wrap.value.clientWidth, 200);
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w && w > 0) width.value = Math.max(w, 200);
  });
  ro.observe(wrap.value);
});
onBeforeUnmount(() => ro?.disconnect());

const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

const fmt = computed(() => props.formatValue ?? ((v: number) => formatCompact(v)));

/** 缺省格式：整数千分位，大数 k/M 压缩 */
function formatCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
}

/** y 轴上界取 1/2/5 阶梯的 nice 值 */
const yMax = computed(() => {
  const max = Math.max(0, ...props.points.map((p) => p.value));
  if (max === 0) return 1;
  const raw = max * 1.05;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
});

const plotW = computed(() => width.value - PAD.left - PAD.right);
const plotH = computed(() => props.height - PAD.top - PAD.bottom);

function xAt(i: number): number {
  const n = props.points.length;
  if (n <= 1) return PAD.left + plotW.value / 2;
  return PAD.left + (i / (n - 1)) * plotW.value;
}
function yAt(v: number): number {
  return PAD.top + (1 - v / yMax.value) * plotH.value;
}

const linePath = computed(() => {
  if (props.points.length === 0) return '';
  return props.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
});

const areaPath = computed(() => {
  if (props.points.length === 0) return '';
  const base = PAD.top + plotH.value;
  const last = props.points.length - 1;
  return `${linePath.value} L${xAt(last).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`;
});

/** 3 条水平网格（0 线为轴线，另 2 条虚线） */
const gridLevels = computed(() => [0.5, 1].map((f) => ({ v: yMax.value * f, y: yAt(yMax.value * f) })));

/** x 轴标签：首尾必出，中间均匀最多 4 个 */
const xLabels = computed(() => {
  const n = props.points.length;
  if (n === 0) return [];
  if (n <= 6) return props.points.map((p, i) => ({ text: p.label, x: xAt(i), i }));
  const idxs = [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1];
  return [...new Set(idxs)].map((i) => ({ text: props.points[i]!.label, x: xAt(i), i }));
});

// ---- 悬停层：十字线 + 最近点 + 提示框 ----
const hoverIndex = ref<number | null>(null);

function onMove(ev: MouseEvent): void {
  const n = props.points.length;
  if (n === 0 || !wrap.value) return;
  const rect = wrap.value.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (n === 1) {
    hoverIndex.value = 0;
    return;
  }
  const t = (x - PAD.left) / plotW.value;
  hoverIndex.value = Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
}
function onLeave(): void {
  hoverIndex.value = null;
}

const hover = computed(() => {
  if (hoverIndex.value === null) return null;
  const p = props.points[hoverIndex.value];
  if (!p) return null;
  return { ...p, x: xAt(hoverIndex.value), y: yAt(p.value) };
});

/** 提示框位置：靠右过半时翻到左侧，避免溢出 */
const tipStyle = computed(() => {
  if (!hover.value) return {};
  const flip = hover.value.x > width.value * 0.62;
  return {
    left: `${hover.value.x + (flip ? -10 : 10)}px`,
    top: `${Math.max(hover.value.y - 14, 4)}px`,
    transform: flip ? 'translateX(-100%)' : 'none',
  };
});
</script>

<template>
  <div ref="wrap" class="relative w-full select-none" :style="{ height: `${props.height}px` }">
    <svg
      v-if="props.points.length > 0"
      :width="width"
      :height="props.height"
      class="block"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <defs>
        <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="props.color" stop-opacity="0.20" />
          <stop offset="100%" :stop-color="props.color" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- 网格（虚线、退居背景）与 y 轴刻度 -->
      <g v-for="g in gridLevels" :key="g.v">
        <line :x1="PAD.left" :x2="width - PAD.right" :y1="g.y" :y2="g.y" stroke="#1f2430" stroke-dasharray="3 4" />
        <text :x="PAD.left - 8" :y="g.y + 3.5" text-anchor="end" class="fill-muted tnum" font-size="10.5">
          {{ fmt(g.v) }}
        </text>
      </g>
      <!-- 基线（实线） -->
      <line
        :x1="PAD.left"
        :x2="width - PAD.right"
        :y1="PAD.top + plotH"
        :y2="PAD.top + plotH"
        stroke="#1f2430"
      />
      <text :x="PAD.left - 8" :y="PAD.top + plotH + 3.5" text-anchor="end" class="fill-muted tnum" font-size="10.5">
        0
      </text>

      <!-- x 轴标签 -->
      <text
        v-for="l in xLabels"
        :key="l.i"
        :x="l.x"
        :y="props.height - 6"
        :text-anchor="l.i === 0 ? 'start' : l.i === props.points.length - 1 ? 'end' : 'middle'"
        class="fill-muted tnum"
        font-size="10.5"
      >
        {{ l.text }}
      </text>

      <!-- 面积 + 线 -->
      <path :d="areaPath" :fill="`url(#${gradId})`" />
      <path :d="linePath" fill="none" :stroke="props.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

      <!-- 悬停：十字线 + 数据点（2px 底色描边圈出重叠） -->
      <g v-if="hover">
        <line :x1="hover.x" :x2="hover.x" :y1="PAD.top" :y2="PAD.top + plotH" stroke="#2b3142" />
        <circle :cx="hover.x" :cy="hover.y" r="4" :fill="props.color" stroke="#101218" stroke-width="2" />
      </g>
    </svg>

    <div v-else class="flex h-full items-center justify-center text-xs text-muted">暂无数据</div>

    <!-- 提示框（HTML 覆盖层） -->
    <div
      v-if="hover"
      class="pointer-events-none absolute z-10 rounded-lg border border-border-2 bg-panel-2 px-2.5 py-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
      :style="tipStyle"
    >
      <p class="tnum text-[10.5px] text-muted">{{ hover.label }}</p>
      <p class="tnum text-[13px] font-semibold" :style="{ color: props.color }">{{ fmt(hover.value) }}</p>
    </div>
  </div>
</template>
