<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Activity,
  CircleDollarSign,
  Coins,
  Percent,
  Settings2,
  TrendingUp,
  Wallet,
} from 'lucide-vue-next';
import { get, put } from '../api/client';
import { session } from '../api/session';
import { toast } from '../components/ui/toast';
import type {
  CostRatiosResponse,
  FinanceSummaryResponse,
  FinanceSummaryRow,
  FinanceTotals,
  FinanceTrendPoint,
} from '../api/types';
import Badge from '../components/ui/Badge.vue';
import Button from '../components/ui/Button.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import Field from '../components/ui/Field.vue';
import Input from '../components/ui/Input.vue';
import Modal from '../components/ui/Modal.vue';
import Select from '../components/ui/Select.vue';
import type { SelectOption } from '../components/ui/Select.vue';
import StatCard from '../components/ui/StatCard.vue';
import Table from '../components/ui/Table.vue';
import type { TableColumn } from '../components/ui/Table.vue';
import FinanceTrendChart from '../components/finance/FinanceTrendChart.vue';
import FinanceBreakdownTable from '../components/finance/FinanceBreakdownTable.vue';
import type { BreakdownDim, FinanceBreakdownResponse, FinanceBreakdownRow } from '../api/types';

/**
 * 经营概览：跨站营收/成本/毛利。
 *  - 营收（流水）= 各站用户消费（对客价），真实数据（GET /api/finance/summary）。
 *  - 成本 = 营收 × 每站成本率（root 在弹窗里配），未配置显示「—」，绝不用 0 冒充盈利。
 *  - 毛利 = 营收 − 成本。
 * 全部为运营方内部经营数据。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>(
  'canWrite',
  computed(() => false),
);
const isRoot = session.isRoot;

// ---- 时间范围（北京日历日 YYYY-MM-DD，闭区间）----
/** 北京今日（前端也按北京口径，与后端一致） */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
const today = beijingToday();
const from = ref(addDays(today, -6));
const to = ref(today);

interface Preset {
  key: string;
  label: string;
  range: () => [string, string];
}
const presets = computed<Preset[]>(() => {
  const td = beijingToday();
  return [
    { key: 'today', label: t('finance.rangeToday'), range: () => [td, td] },
    { key: '7d', label: t('finance.range7d'), range: () => [addDays(td, -6), td] },
    { key: '30d', label: t('finance.range30d'), range: () => [addDays(td, -29), td] },
  ];
});
const activePreset = computed<string | null>(() => {
  const match = presets.value.find((p) => {
    const [f, t2] = p.range();
    return f === from.value && t2 === to.value;
  });
  return match?.key ?? null;
});
function applyPreset(p: Preset): void {
  const [f, t2] = p.range();
  from.value = f;
  to.value = t2;
}

// ---- 数据 ----
function emptyTotals(): FinanceTotals {
  return { requests: 0, tokens: 0, revenue: 0, cost: 0, profit: 0, recharge: null };
}
const rows = ref<FinanceSummaryRow[]>([]);
const totals = ref<FinanceTotals>(emptyTotals());
const trend = ref<FinanceTrendPoint[]>([]);
const allCosted = ref(true);
const loading = ref(true);
const loadError = ref('');

async function load(): Promise<void> {
  if (from.value > to.value) {
    loadError.value = t('finance.rangeInvalid');
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    const res = await get<FinanceSummaryResponse>('/api/finance/summary', {
      silent: true,
      query: { from: from.value, to: to.value },
    });
    rows.value = Array.isArray(res?.rows) ? res.rows : [];
    totals.value = res?.totals ?? emptyTotals();
    trend.value = Array.isArray(res?.trend) ? res.trend : [];
    allCosted.value = res?.allCosted ?? true;
  } catch (err) {
    rows.value = [];
    totals.value = emptyTotals();
    trend.value = [];
    loadError.value = err instanceof Error ? err.message : t('finance.loadFailed');
  } finally {
    loading.value = false;
  }
}

// ---- 经营下钻 ----
const dim = ref<BreakdownDim>('model');
const breakdownDays = ref<number>(7);
const bdRows = ref<FinanceBreakdownRow[]>([]);
const bdConcentration = ref<{ top3Share: number | null; count: number } | null>(null);
const bdLoading = ref(true);
const bdError = ref('');

const dimOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [
    { value: 'model', label: t('finance.dimModel') },
    { value: 'customer', label: t('finance.dimCustomer') },
  ];
  if (isRoot.value) opts.push({ value: 'account', label: t('finance.dimAccount') });
  return opts;
});
const daysOptions = computed<SelectOption[]>(() => [
  { value: 7, label: t('finance.days7') },
  { value: 30, label: t('finance.days30') },
  { value: 90, label: t('finance.days90') },
]);

let bdReqId = 0;
let lastBdSig = '';
async function loadBreakdown(): Promise<void> {
  // 非法区间：与上方汇总一致进入错误态（清空旧数据），不静默保留旧行
  if (dim.value !== 'account' && from.value > to.value) {
    bdRows.value = [];
    bdConcentration.value = null;
    bdError.value = t('finance.rangeInvalid');
    bdLoading.value = false;
    lastBdSig = '';
    return;
  }
  // 去重签名：account 维度只认 days（改日期不重复打）；其余认 dim+from+to
  const sig = dim.value === 'account' ? `account:${breakdownDays.value}` : `${dim.value}:${from.value}:${to.value}`;
  if (sig === lastBdSig && !bdError.value) return;
  lastBdSig = sig;
  const myId = ++bdReqId;
  bdLoading.value = true;
  bdError.value = '';
  try {
    const query: Record<string, string | number | undefined> = { dim: dim.value };
    if (dim.value === 'account') {
      query.days = breakdownDays.value;
    } else {
      query.from = from.value;
      query.to = to.value;
      if (dim.value === 'customer') query.limit = 20;
    }
    const res = await get<FinanceBreakdownResponse>('/api/finance/breakdown', { silent: true, query });
    if (myId !== bdReqId) return; // 乱序响应：丢弃过期结果（防维度快速切换串列）
    bdRows.value = Array.isArray(res?.rows) ? res.rows : [];
    bdConcentration.value = res?.concentration ?? null;
  } catch (err) {
    if (myId !== bdReqId) return;
    bdRows.value = [];
    bdConcentration.value = null;
    bdError.value = err instanceof Error ? err.message : t('finance.loadFailed');
    lastBdSig = ''; // 失败允许重试
  } finally {
    if (myId === bdReqId) bdLoading.value = false;
  }
}

// 日期/维度变化即重新加载
watch([from, to], () => void load());
watch([dim, breakdownDays, from, to], () => void loadBreakdown());
onMounted(() => {
  void load();
  void loadBreakdown();
});

// ---- 格式化 ----
function fmtInt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}
/**
 * 金额：$ 前缀，自适应精度——≥1 用两位小数；<1 用 4~6 位，
 * 免得亚分级流水被两位小数抹成 $0.00（这正是老板此前"看不到成本毛利"的坑）。
 * null（成本率未配置）显示 —。
 */
function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  let digits = 2;
  if (abs > 0 && abs < 1) digits = abs < 0.01 ? 6 : 4;
  const v = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '-' : ''}$${v}`;
}
function marginPct(revenue: number, profit: number | null): string {
  if (profit === null || !(revenue > 0)) return '—';
  return `${((profit / revenue) * 100).toFixed(1)}%`;
}
/** 充值金额（RMB 口径，¥ 前缀）；本行业美元/人民币 1:1，可直接与营收对比 */
function fmtCny(n: number): string {
  return `¥${(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function marginClass(n: number | null): string {
  if (n === null) return 'text-muted';
  if (n > 0) return 'text-green';
  if (n < 0) return 'text-red';
  return 'text-muted';
}
const totalMarginPct = computed(() =>
  allCosted.value ? marginPct(totals.value.revenue, totals.value.profit) : '—',
);
const totalMarginTone = computed<'green' | 'red' | 'default'>(() => {
  if (!allCosted.value) return 'default';
  if (totals.value.profit > 0) return 'green';
  if (totals.value.profit < 0) return 'red';
  return 'default';
});

// ---- 每日明细（充值/消耗/成本/毛利/请求/token 逐日）----
const dailyColumns = computed<TableColumn[]>(() => [
  { key: 'date', label: t('finance.colDate'), mono: true },
  { key: 'recharge', label: t('finance.colRecharge'), align: 'right' },
  { key: 'revenue', label: t('finance.colConsume'), align: 'right' },
  { key: 'cost', label: t('finance.colCost'), align: 'right' },
  { key: 'profit', label: t('finance.colProfit'), align: 'right' },
  { key: 'marginPct', label: t('finance.colMarginPct'), align: 'right' },
  { key: 'requests', label: t('finance.colRequests'), align: 'right' },
  { key: 'tokens', label: t('finance.colTokens'), align: 'right' },
]);
// 新到旧（当天在最上）
const dailyRows = computed<Record<string, unknown>[]>(
  () => [...trend.value].reverse() as unknown as Record<string, unknown>[],
);
function asTrend(r: Record<string, unknown>): FinanceTrendPoint {
  return r as unknown as FinanceTrendPoint;
}

// ---- 明细表 ----
const columns = computed<TableColumn[]>(() => [
  { key: 'label', label: t('finance.colSite') },
  { key: 'revenue', label: t('finance.colRevenue'), align: 'right' },
  { key: 'costSource', label: t('finance.colCostSource'), align: 'right' },
  { key: 'cost', label: t('finance.colCost'), align: 'right' },
  { key: 'profit', label: t('finance.colProfit'), align: 'right' },
  { key: 'marginPct', label: t('finance.colMarginPct'), align: 'right' },
  { key: 'requests', label: t('finance.colRequests'), align: 'right' },
]);
const tableRows = computed<Record<string, unknown>[]>(
  () => rows.value as unknown as Record<string, unknown>[],
);
function asRow(r: Record<string, unknown>): FinanceSummaryRow {
  return r as unknown as FinanceSummaryRow;
}
/** 成本口径列：成本率覆盖显示 x%，引擎真实成本显示译名，均无显示 — */
function costSourceLabel(r: FinanceSummaryRow): string {
  if (r.costSource === 'ratio' && r.costRatio !== null) return `${(r.costRatio * 100).toFixed(0)}%`;
  if (r.costSource === 'engine') return t('finance.sourceEngine');
  return '—';
}

// ---- 成本率设置（root）----
const ratioOpen = ref(false);
const savingSlug = ref<string | null>(null);
// slug -> 百分比（Input type=number 会回传 number；空串=清除）
const ratioForm = reactive<Record<string, string | number>>({});

function openRatios(): void {
  for (const r of rows.value) {
    ratioForm[r.slug] = r.costRatio === null ? '' : String(Math.round(r.costRatio * 100));
  }
  ratioOpen.value = true;
}

async function saveRatio(r: FinanceSummaryRow): Promise<void> {
  const raw = String(ratioForm[r.slug] ?? '').trim();
  let ratio: number | null;
  if (raw === '') {
    ratio = null;
  } else {
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error(t('finance.ratioRange'));
      return;
    }
    ratio = pct / 100;
  }
  savingSlug.value = r.slug;
  try {
    await put<CostRatiosResponse>('/api/finance/cost-ratios', { slug: r.slug, ratio });
    toast.success(t('finance.ratioSaved', { site: r.label }));
    await load();
  } catch {
    // client 已弹错误
  } finally {
    savingSlug.value = null;
  }
}

// 原生 date 输入沿用 Input 视觉，[color-scheme:dark] 让弹出选择器随深色
const fieldCls =
  'h-8.5 rounded-lg border border-border bg-bg/60 px-3 text-[13px] text-text transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 [color-scheme:dark]';
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 工具条 -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="rp-microlabel">{{ t('finance.microlabel') }}</p>
        <p class="mt-1 text-xs text-muted">{{ t('finance.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <!-- 预设 -->
        <div class="inline-flex overflow-hidden rounded-lg border border-border">
          <button
            v-for="p in presets"
            :key="p.key"
            type="button"
            class="px-2.5 py-1.5 text-xs transition-colors"
            :class="
              activePreset === p.key
                ? 'bg-panel-2 font-medium text-text'
                : 'text-muted hover:bg-panel-2/50 hover:text-text'
            "
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        </div>
        <!-- 自定义区间 -->
        <div class="flex items-center gap-1.5">
          <input v-model="from" type="date" :max="to" :class="[fieldCls, 'w-[142px]']" :aria-label="t('finance.dateFrom')" />
          <span class="text-xs text-muted">–</span>
          <input v-model="to" type="date" :min="from" :max="today" :class="[fieldCls, 'w-[142px]']" :aria-label="t('finance.dateTo')" />
        </div>
        <Button v-if="isRoot && canWrite" variant="outline" @click="openRatios">
          <Settings2 :size="14" /> {{ t('finance.setCostRatios') }}
        </Button>
      </div>
    </div>

    <!-- 合计统计卡 -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard
        :label="t('finance.statRevenue')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.revenue)"
        :loading="loading"
        :icon="Wallet"
        :hint="t('finance.statRevenueHint')"
      />
      <StatCard
        :label="t('finance.statRecharge')"
        :value="loading ? '' : loadError || totals.recharge === null ? '—' : fmtCny(totals.recharge)"
        :loading="loading"
        :icon="Coins"
        :hint="t('finance.statRechargeHint')"
      />
      <StatCard
        :label="t('finance.statCost')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.cost)"
        :loading="loading"
        :icon="CircleDollarSign"
        :hint="allCosted ? t('finance.statCostHint') : t('finance.statPartial')"
      />
      <StatCard
        :label="t('finance.statProfit')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.profit)"
        :loading="loading"
        :tone="loadError ? 'default' : totalMarginTone"
        :icon="TrendingUp"
        :hint="allCosted ? t('finance.statProfitHint') : t('finance.statPartial')"
      />
      <StatCard
        :label="t('finance.statMarginPct')"
        :value="loading ? '' : loadError ? '—' : totalMarginPct"
        :loading="loading"
        :tone="loadError ? 'default' : totalMarginTone"
        :icon="Percent"
      />
      <StatCard
        :label="t('finance.statRequests')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.requests)"
        :loading="loading"
        :icon="Activity"
      />
    </div>

    <!-- 走势图 -->
    <FinanceTrendChart v-if="!loadError" :points="trend" />

    <!-- 每日明细：逐日 充值 · 消耗 · 成本 · 毛利 · 请求 · token -->
    <div v-if="!loadError" class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">{{ t('finance.dailyTitle') }}</p>
        <p class="tnum truncate text-xs text-muted">{{ t('finance.dailyNote') }}</p>
      </header>
      <Table
        :columns="dailyColumns"
        :rows="dailyRows"
        row-key="date"
        :loading="loading"
        :empty="t('finance.tableEmpty')"
      >
        <template #cell-recharge="{ row }">
          <span class="tnum" :class="asTrend(row).recharge === null ? 'text-muted' : ''">{{
            asTrend(row).recharge === null ? '—' : fmtCny(asTrend(row).recharge as number)
          }}</span>
        </template>
        <template #cell-revenue="{ row }"><span class="tnum">{{ fmtMoney(asTrend(row).revenue) }}</span></template>
        <template #cell-cost="{ row }"><span class="tnum">{{ fmtMoney(asTrend(row).cost) }}</span></template>
        <template #cell-profit="{ row }">
          <span class="tnum" :class="marginClass(asTrend(row).profit)">{{ fmtMoney(asTrend(row).profit) }}</span>
        </template>
        <template #cell-marginPct="{ row }">
          <span class="tnum" :class="marginClass(asTrend(row).profit)">{{
            marginPct(asTrend(row).revenue, asTrend(row).profit)
          }}</span>
        </template>
        <template #cell-requests="{ row }">{{ fmtInt(asTrend(row).requests) }}</template>
        <template #cell-tokens="{ row }">{{ fmtInt(asTrend(row).tokens) }}</template>
      </Table>
    </div>

    <!-- 成本率未配置提示 -->
    <div
      v-if="!loading && !loadError && !allCosted && rows.length > 0"
      class="rp-panel flex flex-wrap items-center justify-between gap-2 px-4 py-3"
    >
      <p class="text-xs text-muted">{{ t('finance.pricingHint') }}</p>
      <Button v-if="isRoot && canWrite" size="sm" variant="ghost" @click="openRatios">
        {{ t('finance.setCostRatios') }}
      </Button>
    </div>

    <!-- 明细表 -->
    <div class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">
          {{ t('finance.detailTitle')
          }}{{ !loading && !loadError ? t('finance.detailCount', { n: rows.length }) : '' }}
        </p>
        <p class="tnum truncate text-xs text-muted">{{ t('finance.revenueSource') }}</p>
      </header>

      <div v-if="loadError" class="p-8">
        <EmptyState :title="t('finance.loadFailed')" :description="loadError" />
      </div>

      <Table
        v-else
        :columns="columns"
        :rows="tableRows"
        row-key="slug"
        :loading="loading"
        :empty="t('finance.tableEmpty')"
      >
        <template #cell-label="{ row }">
          <div class="flex items-center gap-2">
            <span>{{ asRow(row).label }}</span>
            <Badge v-if="!asRow(row).ok" tone="red" size="sm">{{ t('finance.siteError') }}</Badge>
          </div>
        </template>
        <template #cell-revenue="{ row }">
          <span v-if="asRow(row).ok" class="tnum">{{ fmtMoney(asRow(row).revenue) }}</span>
          <span v-else class="tnum text-muted" :title="asRow(row).error">—</span>
        </template>
        <template #cell-costSource="{ row }">
          <span
            class="tnum text-muted"
            :class="{ 'text-accent': asRow(row).costSource === 'ratio' }"
            :title="asRow(row).costSource === 'engine' ? t('finance.sourceEngineHint') : ''"
          >{{ costSourceLabel(asRow(row)) }}</span>
        </template>
        <template #cell-cost="{ row }">
          <span class="tnum">{{ fmtMoney(asRow(row).cost) }}</span>
        </template>
        <template #cell-profit="{ row }">
          <span class="tnum" :class="marginClass(asRow(row).profit)">{{ fmtMoney(asRow(row).profit) }}</span>
        </template>
        <template #cell-marginPct="{ row }">
          <span class="tnum" :class="marginClass(asRow(row).profit)">
            {{ marginPct(asRow(row).revenue, asRow(row).profit) }}
          </span>
        </template>
        <template #cell-requests="{ row }">{{ fmtInt(asRow(row).requests) }}</template>
      </Table>
    </div>

    <!-- 经营下钻（按模型/客户/上游渠道）-->
    <div class="rp-panel overflow-hidden">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">{{ t('finance.breakdownTitle') }}</p>
        <div class="flex items-center gap-2">
          <div class="w-[132px]">
            <Select
              :model-value="dim"
              :options="dimOptions"
              @update:model-value="(v) => (dim = v as BreakdownDim)"
            />
          </div>
          <div v-if="dim === 'account'" class="w-[116px]">
            <Select
              :model-value="breakdownDays"
              :options="daysOptions"
              @update:model-value="(v) => (breakdownDays = Number(v))"
            />
          </div>
        </div>
      </header>
      <div class="p-4">
        <p v-if="dim === 'account'" class="mb-3 text-xs text-muted">{{ t('finance.accountNote') }}</p>
        <div v-if="bdError">
          <EmptyState :title="t('finance.loadFailed')" :description="bdError" />
        </div>
        <FinanceBreakdownTable
          v-else
          :dim="dim"
          :rows="bdRows"
          :loading="bdLoading"
          :concentration="bdConcentration"
        />
      </div>
    </div>

    <!-- 成本率设置 Modal（root）-->
    <Modal v-model:open="ratioOpen" :title="t('finance.ratioModalTitle')" width="560px">
      <div class="space-y-4">
        <p class="text-[13px] leading-relaxed text-muted">{{ t('finance.ratioModalDesc') }}</p>
        <div
          v-for="r in rows"
          :key="r.slug"
          class="flex items-end gap-3 rounded-lg border border-border bg-bg/40 px-3 py-2.5"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium">{{ r.label }}</p>
            <p class="truncate text-xs text-muted">
              {{ t('finance.ratioRevenue') }} {{ fmtMoney(r.revenue) }}
            </p>
          </div>
          <Field :label="t('finance.ratioLabel')" class="w-[120px]">
            <Input
              :model-value="ratioForm[r.slug] ?? ''"
              type="number"
              min="0"
              max="100"
              placeholder="—"
              @update:model-value="(v) => (ratioForm[r.slug] = v)"
            />
          </Field>
          <Button
            size="sm"
            variant="primary"
            :loading="savingSlug === r.slug"
            @click="saveRatio(r)"
          >
            {{ t('common.save') }}
          </Button>
        </div>
        <p class="text-xs text-muted">{{ t('finance.ratioClearHint') }}</p>
      </div>

      <template #footer>
        <Button variant="ghost" @click="ratioOpen = false">{{ t('common.cancel') }}</Button>
      </template>
    </Modal>
  </div>
</template>
