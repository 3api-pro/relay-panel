<script setup lang="ts">
import EmptyState from './EmptyState.vue';
import Skeleton from './Skeleton.vue';

/**
 * 通用表格。列定义 + 行数据，单元格可用 #cell-<key>="{ row, value }" 插槽自定义。
 * 外层自带横向滚动容器（页面永不横向溢出）。
 */
export interface TableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  /** CSS 宽度（如 '120px' / '20%'） */
  width?: string;
  /** 等宽字体（slug/版本/hash 类） */
  mono?: boolean;
}

const props = withDefaults(
  defineProps<{
    columns: TableColumn[];
    rows: Record<string, unknown>[];
    /** 行 key 字段名，缺省用下标 */
    rowKey?: string;
    loading?: boolean;
    /** 空数据提示文案 */
    empty?: string;
    /** 行可点（hover 高亮 + 触发 row-click） */
    clickable?: boolean;
  }>(),
  { rowKey: '', loading: false, empty: '暂无数据', clickable: false },
);

const emit = defineEmits<{ 'row-click': [row: Record<string, unknown>] }>();

function keyOf(row: Record<string, unknown>, index: number): string | number {
  if (props.rowKey && props.rowKey in row) return String(row[props.rowKey]);
  return index;
}

function alignClass(col: TableColumn): string {
  if (col.align === 'right') return 'text-right';
  if (col.align === 'center') return 'text-center';
  return 'text-left';
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-[13px]">
      <thead>
        <tr class="border-b border-border">
          <th
            v-for="col in props.columns"
            :key="col.key"
            class="rp-microlabel whitespace-nowrap px-3 py-2.5 font-semibold"
            :class="alignClass(col)"
            :style="col.width ? { width: col.width } : {}"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody v-if="props.loading">
        <tr v-for="i in 4" :key="i" class="border-b border-border/60">
          <td v-for="col in props.columns" :key="col.key" class="px-3 py-3">
            <Skeleton height="12px" :width="col.align === 'right' ? '48px' : '72%'" />
          </td>
        </tr>
      </tbody>
      <tbody v-else-if="props.rows.length > 0">
        <tr
          v-for="(row, i) in props.rows"
          :key="keyOf(row, i)"
          class="border-b border-border/60 transition-colors last:border-0"
          :class="props.clickable ? 'cursor-pointer hover:bg-panel-2/60' : 'hover:bg-panel-2/30'"
          @click="props.clickable && emit('row-click', row)"
        >
          <td
            v-for="col in props.columns"
            :key="col.key"
            class="px-3 py-2.5 align-middle"
            :class="[alignClass(col), col.mono ? 'font-mono text-xs tracking-tight' : '', 'tnum']"
          >
            <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">
              {{ row[col.key] ?? '—' }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!props.loading && props.rows.length === 0" class="py-10">
      <EmptyState :title="props.empty" />
    </div>
  </div>
</template>
