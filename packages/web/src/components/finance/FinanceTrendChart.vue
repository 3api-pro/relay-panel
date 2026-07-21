<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FinanceTrendPoint } from '../../api/types';

/**
 * 经营走势图（内联 SVG，无外部依赖，深色/浅色随主题）。
 * 两条序列：营收（accent，面积+线，精确）与毛利（green，线，分摊估算）。
 * 悬停显示当日营收/成本/毛利。viewBox 固定，容器 w-full 等比缩放。
 */
const props = defineProps<{ points: FinanceTrendPoint[] }>();
const { t } = useI18n();

// ---- 画布几何（viewBox 坐标系）----
const W = 820;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 34, left: 52 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

const n = computed(() => props.points.length);

// Y 轴上界：营收与毛利的最大值（毛利可能为负，下界取 min(0, 最小毛利)）
const yMax = computed(() => {
  const vals = props.points.flatMap((p) => [p.revenue, p.profit]);
  return Math.max(1e-9, ...vals);
});
const yMin = computed(() => {
  const minProfit = Math.min(0, ...props.points.map((p) => p.profit));
  return minProfit;
});
const ySpan = computed(() => yMax.value - yMin.value || 1);

function xAt(i: number): number {
  if (n.value <= 1) return PAD.left + plotW / 2;
  return PAD.left + (i / (n.value - 1)) * plotW;
}
function yAt(v: number): number {
  return PAD.top + (1 - (v - yMin.value) / ySpan.value) * plotH;
}

function linePath(key: 'revenue' | 'profit'): string {
  return props.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`)
    .join(' ');
}
const revenueLine = computed(() => linePath('revenue'));
const profitLine = computed(() => linePath('profit'));
const revenueArea = computed(() => {
  if (n.value === 0) return '';
  const base = yAt(Math.max(0, yMin.value));
  return `${revenueLine.value} L${xAt(n.value - 1).toFixed(1)},${base.toFixed(1)} L${xAt(0).toFixed(1)},${base.toFixed(1)} Z`;
});

// ---- Y 网格线（含 0 基线）----
const yTicks = computed(() => {
  const ticks: { y: number; label: string }[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = yMin.value + (ySpan.value * i) / steps;
    ticks.push({ y: yAt(v), label: fmtCompact(v) });
  }
  return ticks;
});

// ---- X 轴日期标签（最多 ~7 个）----
const xTicks = computed(() => {
  const pts = props.points;
  if (pts.length === 0) return [];
  const maxLabels = 7;
  const step = Math.max(1, Math.ceil(pts.length / maxLabels));
  const out: { x: number; label: string }[] = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push({ x: xAt(i), label: (pts[i] as FinanceTrendPoint).date.slice(5) }); // MM-DD
  }
  const lastIdx = pts.length - 1;
  if (out[out.length - 1]?.x !== xAt(lastIdx)) {
    out.push({ x: xAt(lastIdx), label: (pts[lastIdx] as FinanceTrendPoint).date.slice(5) });
  }
  return out;
});

// ---- 悬停 ----
const hoverIdx = ref<number | null>(null);
const container = ref<HTMLElement | null>(null);
function onMove(e: PointerEvent): void {
  const el = container.value;
  if (!el || n.value === 0) return;
  const rect = el.getBoundingClientRect();
  const rel = (e.clientX - rect.left) / rect.width;
  hoverIdx.value = Math.max(0, Math.min(n.value - 1, Math.round(rel * (n.value - 1))));
}
function onLeave(): void {
  hoverIdx.value = null;
}
const hover = computed(() => (hoverIdx.value === null ? null : props.points[hoverIdx.value] ?? null));
const hoverLeftPct = computed(() =>
  hoverIdx.value === null || n.value <= 1 ? 0 : (hoverIdx.value / (n.value - 1)) * 100,
);

// ---- 格式化 ----
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return `${v < 0 ? '-' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  if (a >= 1) return `$${v.toFixed(0)}`;
  if (a === 0) return '$0';
  return `$${v.toFixed(2)}`;
}
function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const digits = a > 0 && a < 1 ? 4 : 2;
  return `${v < 0 ? '-' : ''}$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function fmtCny(v: number | null): string {
  return v === null ? '—' : `¥${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function fmtInt(v: number): string {
  return (v ?? 0).toLocaleString('en-US');
}
</script>

<template>
  <div class="rp-panel p-4">
    <div class="mb-2 flex items-center justify-between gap-3">
      <p class="rp-microlabel">{{ t('finance.trendTitle') }}</p>
      <div class="flex items-center gap-3 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full" style="background: var(--color-accent)" />
          {{ t('finance.statRevenue') }}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full" style="background: var(--color-green)" />
          {{ t('finance.statProfit') }}
        </span>
      </div>
    </div>

    <div v-if="n === 0" class="flex h-[220px] items-center justify-center text-xs text-muted">
      {{ t('finance.tableEmpty') }}
    </div>

    <div
      v-else
      ref="container"
      class="relative w-full"
      @pointermove="onMove"
      @pointerleave="onLeave"
    >
      <svg :viewBox="`0 0 ${W} ${H}`" class="block w-full" role="img">
        <defs>
          <linearGradient id="rp-fin-rev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.20" />
            <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
          </linearGradient>
        </defs>

        <!-- Y 网格 + 标签 -->
        <g>
          <line
            v-for="(tk, i) in yTicks"
            :key="'g' + i"
            :x1="PAD.left"
            :x2="W - PAD.right"
            :y1="tk.y"
            :y2="tk.y"
            stroke="var(--glass-border)"
            stroke-width="1"
          />
          <text
            v-for="(tk, i) in yTicks"
            :key="'yl' + i"
            :x="PAD.left - 8"
            :y="tk.y + 3"
            text-anchor="end"
            font-size="10"
            fill="var(--color-muted)"
          >
            {{ tk.label }}
          </text>
        </g>

        <!-- X 日期标签 -->
        <text
          v-for="(tk, i) in xTicks"
          :key="'xl' + i"
          :x="tk.x"
          :y="H - 12"
          text-anchor="middle"
          font-size="10"
          fill="var(--color-muted)"
        >
          {{ tk.label }}
        </text>

        <!-- 营收面积 + 线 -->
        <path :d="revenueArea" fill="url(#rp-fin-rev)" />
        <path
          :d="revenueLine"
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <!-- 毛利线 -->
        <path
          :d="profitLine"
          fill="none"
          stroke="var(--color-green)"
          stroke-width="1.75"
          stroke-dasharray="1 0"
          stroke-linejoin="round"
          stroke-linecap="round"
        />

        <!-- 短区间（含单日）画点，避免只有一个点时图看起来空 -->
        <g v-if="n <= 10">
          <circle
            v-for="(p, i) in points"
            :key="'rd' + i"
            :cx="xAt(i)"
            :cy="yAt(p.revenue)"
            r="2.5"
            fill="var(--color-accent)"
          />
          <circle
            v-for="(p, i) in points"
            :key="'pd' + i"
            :cx="xAt(i)"
            :cy="yAt(p.profit)"
            r="2.5"
            fill="var(--color-green)"
          />
        </g>

        <!-- 悬停竖线 + 点 -->
        <g v-if="hoverIdx !== null">
          <line
            :x1="xAt(hoverIdx)"
            :x2="xAt(hoverIdx)"
            :y1="PAD.top"
            :y2="H - PAD.bottom"
            stroke="var(--color-muted)"
            stroke-width="1"
            stroke-dasharray="3 3"
            opacity="0.6"
          />
          <circle :cx="xAt(hoverIdx)" :cy="yAt((hover as FinanceTrendPoint).revenue)" r="3.5" fill="var(--color-accent)" />
          <circle :cx="xAt(hoverIdx)" :cy="yAt((hover as FinanceTrendPoint).profit)" r="3.5" fill="var(--color-green)" />
        </g>
      </svg>

      <!-- 悬停浮层 -->
      <div
        v-if="hover"
        class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-border bg-panel-2/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
        :style="{ left: `${hoverLeftPct}%` }"
      >
        <p class="mb-0.5 font-medium text-text">{{ hover.date }}</p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.colRecharge') }}</span><span class="tnum text-text">{{ fmtCny(hover.recharge) }}</span>
        </p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.colConsume') }}</span><span class="tnum text-text">{{ fmtMoney(hover.revenue) }}</span>
        </p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.statCost') }}</span><span class="tnum text-text">{{ fmtMoney(hover.cost) }}</span>
        </p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.statProfit') }}</span><span class="tnum text-green">{{ fmtMoney(hover.profit) }}</span>
        </p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.colRequests') }}</span><span class="tnum text-text">{{ fmtInt(hover.requests) }}</span>
        </p>
        <p class="flex items-center justify-between gap-3 text-muted">
          <span>{{ t('finance.colTokens') }}</span><span class="tnum text-text">{{ fmtInt(hover.tokens) }}</span>
        </p>
      </div>
    </div>
    <p class="mt-2 text-[11px] text-muted">{{ t('finance.trendNote') }}</p>
  </div>
</template>
