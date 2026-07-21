<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BreakdownDim, FinanceBreakdownRow } from '../../api/types';
import Badge from '../ui/Badge.vue';
import Table from '../ui/Table.vue';
import type { TableColumn } from '../ui/Table.vue';

/**
 * 经营下钻表：按模型/客户/上游渠道展示营收·成本·毛利·毛利率。
 * 亏本行（营收>0 且成本>营收）红 Badge。客户维度顶部显示大客户集中度。
 */
const props = defineProps<{
  dim: BreakdownDim;
  rows: FinanceBreakdownRow[];
  loading: boolean;
  concentration?: { top3Share: number | null; count: number } | null;
}>();
const { t } = useI18n();

function fmtInt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}
function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? (abs < 0.01 ? 6 : 4) : 2;
  const v = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '-' : ''}$${v}`;
}
function marginPct(m: number | null): string {
  return m === null ? '—' : `${(m * 100).toFixed(1)}%`;
}
function toneClass(n: number | null): string {
  if (n === null) return 'text-muted';
  if (n > 0) return 'text-green';
  if (n < 0) return 'text-red';
  return 'text-muted';
}

const nameLabel = computed(() => {
  switch (props.dim) {
    case 'model':
      return t('finance.colModel');
    case 'customer':
      return t('finance.colCustomer');
    default:
      return t('finance.colChannel');
  }
});

const columns = computed<TableColumn[]>(() => [
  { key: 'label', label: nameLabel.value },
  { key: 'revenue', label: t('finance.colRevenue'), align: 'right' },
  { key: 'cost', label: t('finance.colCost'), align: 'right' },
  { key: 'profit', label: t('finance.colProfit'), align: 'right' },
  { key: 'margin', label: t('finance.colMarginPct'), align: 'right' },
  { key: 'requests', label: t('finance.colRequests'), align: 'right' },
]);
const tableRows = computed<Record<string, unknown>[]>(() => props.rows as unknown as Record<string, unknown>[]);
function asRow(r: Record<string, unknown>): FinanceBreakdownRow {
  return r as unknown as FinanceBreakdownRow;
}

const top3Pct = computed(() => {
  const s = props.concentration?.top3Share;
  return s === null || s === undefined ? '—' : `${(s * 100).toFixed(1)}%`;
});
</script>

<template>
  <div class="space-y-3">
    <!-- 客户集中度 -->
    <div
      v-if="dim === 'customer' && concentration && !loading"
      class="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border bg-bg/40 px-4 py-2.5"
    >
      <div class="flex items-baseline gap-2">
        <span class="rp-microlabel">{{ t('finance.concentration') }}</span>
        <span class="tnum text-lg font-semibold" :class="(concentration.top3Share ?? 0) >= 0.6 ? 'text-amber' : 'text-text'">{{ top3Pct }}</span>
      </div>
      <p class="text-xs text-muted">{{ t('finance.concentrationDesc', { n: concentration.count }) }}</p>
    </div>

    <Table
      :columns="columns"
      :rows="tableRows"
      row-key="key"
      :loading="loading"
      :empty="t('finance.breakdownEmpty')"
    >
      <template #cell-label="{ row }">
        <div class="flex items-center gap-2">
          <div class="min-w-0">
            <span class="truncate">{{ asRow(row).label }}</span>
            <span v-if="asRow(row).sublabel" class="ml-1.5 text-xs text-muted">· {{ asRow(row).sublabel }}</span>
          </div>
          <Badge v-if="asRow(row).loss" tone="red" size="sm">{{ t('finance.lossBadge') }}</Badge>
        </div>
      </template>
      <template #cell-revenue="{ row }"><span class="tnum">{{ fmtMoney(asRow(row).revenue) }}</span></template>
      <template #cell-cost="{ row }"><span class="tnum">{{ fmtMoney(asRow(row).cost) }}</span></template>
      <template #cell-profit="{ row }">
        <span class="tnum" :class="toneClass(asRow(row).profit)">{{ fmtMoney(asRow(row).profit) }}</span>
      </template>
      <template #cell-margin="{ row }">
        <span class="tnum" :class="toneClass(asRow(row).margin)">{{ marginPct(asRow(row).margin) }}</span>
      </template>
      <template #cell-requests="{ row }">{{ fmtInt(asRow(row).requests) }}</template>
    </Table>
  </div>
</template>
