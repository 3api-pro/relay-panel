<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Activity, CircleDollarSign, Hash, Plus, TrendingUp, Wallet } from 'lucide-vue-next';
import { get, post } from '../api/client';
import { session } from '../api/session';
import { toast } from '../components/ui/toast';
import type {
  LedgerResponse,
  LedgerRow,
  LedgerTotals,
  LedgerImportResponse,
  SitesResponse,
  SiteView,
} from '../api/types';
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

/**
 * 渠道市场分账账本：按月统计各站点各模板的上游成本 / 应收 / 毛利。
 * 数据源 GET /api/marketplace/ledger?month=YYYY-MM[&siteSlug=]。
 * root 额外可「手工补账」（POST /api/marketplace/ledger/import，source=manual）。
 * 全部为运营方内部对账数据，页面已用模板对外名（templateTitle），不暴露上游供应商。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>(
  'canWrite',
  computed(() => false),
);
const isRoot = session.isRoot;

// ---- 筛选状态 ----
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const month = ref(currentMonth());
const siteFilter = ref<string | number>('all');

const siteList = ref<SiteView[]>([]);
const siteOptions = computed<SelectOption[]>(() => [
  { value: 'all', label: t('ledger.allSites') },
  ...siteList.value.map((s) => ({ value: s.slug, label: s.label })),
]);

// ---- 账本数据 ----
function emptyTotals(): LedgerTotals {
  return { requests: 0, tokens: 0, upstreamCost: 0, billedCost: 0, margin: 0 };
}
const rows = ref<LedgerRow[]>([]);
const totals = ref<LedgerTotals>(emptyTotals());
const loading = ref(true);
const loadError = ref('');

async function loadSites(): Promise<void> {
  try {
    const res = await get<SitesResponse>('/api/sites', { silent: true });
    siteList.value = res.sites.filter((s) => s.status !== 'destroyed');
  } catch {
    siteList.value = []; // 站点列表失败仅退化为「全部」，不阻塞账本
  }
}

async function loadLedger(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await get<LedgerResponse>('/api/marketplace/ledger', {
      silent: true,
      query: {
        month: month.value,
        siteSlug: siteFilter.value === 'all' ? undefined : siteFilter.value,
      },
    });
    rows.value = Array.isArray(res?.rows) ? res.rows : [];
    totals.value = res?.totals ?? emptyTotals();
  } catch (err) {
    rows.value = [];
    totals.value = emptyTotals();
    loadError.value = err instanceof Error ? err.message : t('ledger.loadFailed');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadSites();
  void loadLedger();
});
watch([month, siteFilter], () => void loadLedger());

// ---- 格式化 ----
function fmtInt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}
/** 金额：$ 前缀 + 两位小数，负数前置负号（毛利可能为负） */
function fmtMoney(n: number): string {
  const v = Math.abs(n ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${(n ?? 0) < 0 ? '-' : ''}$${v}`;
}
function marginTone(n: number): 'green' | 'red' | 'default' {
  if (n > 0) return 'green';
  if (n < 0) return 'red';
  return 'default';
}
function marginClass(n: number): string {
  if (n > 0) return 'text-green';
  if (n < 0) return 'text-red';
  return 'text-muted';
}

// ---- 明细表 ----
const columns = computed<TableColumn[]>(() => [
  { key: 'siteSlug', label: t('ledger.colSite'), mono: true },
  { key: 'templateTitle', label: t('ledger.colTemplate') },
  { key: 'requests', label: t('ledger.colRequests'), align: 'right' },
  { key: 'tokens', label: t('ledger.colTokens'), align: 'right' },
  { key: 'upstreamCost', label: t('ledger.colUpstream'), align: 'right' },
  { key: 'billedCost', label: t('ledger.colBilled'), align: 'right' },
  { key: 'margin', label: t('ledger.colMargin'), align: 'right' },
]);
const tableRows = computed<Record<string, unknown>[]>(
  () => rows.value as unknown as Record<string, unknown>[],
);
/** Table 插槽回传的行是 Record<string, unknown>，还原为 LedgerRow 便于取字段 */
function asRow(r: Record<string, unknown>): LedgerRow {
  return r as unknown as LedgerRow;
}

// ---- 手工补账（root）----
const importOpen = ref(false);
const importing = ref(false);
const form = reactive({
  grantId: '' as string | number,
  periodStart: '',
  periodEnd: '',
  requests: '' as string | number,
  promptTokens: '' as string | number,
  completionTokens: '' as string | number,
  upstreamCost: '' as string | number,
  billedCost: '' as string | number,
});

function monthLastDay(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return '';
  const d = new Date(y, mo, 0).getDate();
  return `${m}-${String(d).padStart(2, '0')}`;
}
function numify(v: string | number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const canSubmit = computed(() => {
  const gid = Number(form.grantId);
  return form.grantId !== '' && Number.isFinite(gid) && gid > 0 && !!form.periodStart && !!form.periodEnd;
});

function openImport(): void {
  form.grantId = '';
  form.periodStart = `${month.value}-01`;
  form.periodEnd = monthLastDay(month.value);
  form.requests = '';
  form.promptTokens = '';
  form.completionTokens = '';
  form.upstreamCost = '';
  form.billedCost = '';
  importOpen.value = true;
}

async function submitImport(): Promise<void> {
  if (!canSubmit.value) return;
  importing.value = true;
  try {
    const res = await post<LedgerImportResponse>('/api/marketplace/ledger/import', {
      grantId: Number(form.grantId),
      rows: [
        {
          periodStart: form.periodStart,
          periodEnd: form.periodEnd,
          requests: numify(form.requests),
          promptTokens: numify(form.promptTokens),
          completionTokens: numify(form.completionTokens),
          upstreamCost: numify(form.upstreamCost),
          billedCost: numify(form.billedCost),
          source: 'manual',
        },
      ],
    });
    toast.success(t('ledger.importedToast', { n: res?.imported ?? 1 }));
    importOpen.value = false;
    await loadLedger();
  } catch {
    // 非 2xx 已由 client 弹错误 toast
  } finally {
    importing.value = false;
  }
}

// 原生 month / date 输入沿用 Input 的视觉，附 color-scheme:dark 让弹出选择器随深色
const fieldCls =
  'h-8.5 rounded-lg border border-border bg-bg/60 px-3 text-[13px] text-text transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 [color-scheme:dark]';
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 工具条 -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="rp-microlabel">{{ t('ledger.microlabel') }}</p>
        <p class="mt-1 text-xs text-muted">{{ t('ledger.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="month"
          type="month"
          :max="currentMonth()"
          :class="[fieldCls, 'w-[160px]']"
          :aria-label="t('ledger.monthAria')"
        />
        <div class="w-[176px]">
          <Select v-model="siteFilter" :options="siteOptions" />
        </div>
        <Button v-if="isRoot && canWrite" variant="outline" @click="openImport">
          <Plus :size="14" /> {{ t('ledger.manualImport') }}
        </Button>
      </div>
    </div>

    <!-- 合计统计卡 -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      <StatCard
        :label="t('ledger.statRequests')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.requests)"
        :loading="loading"
        :icon="Activity"
      />
      <StatCard
        :label="t('ledger.statTokens')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.tokens)"
        :loading="loading"
        :icon="Hash"
      />
      <StatCard
        :label="t('ledger.statUpstream')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.upstreamCost)"
        :loading="loading"
        :icon="CircleDollarSign"
      />
      <StatCard
        :label="t('ledger.statBilled')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.billedCost)"
        :loading="loading"
        :icon="Wallet"
      />
      <StatCard
        :label="t('ledger.statMargin')"
        :value="loading ? '' : loadError ? '—' : fmtMoney(totals.margin)"
        :loading="loading"
        :tone="loadError ? 'default' : marginTone(totals.margin)"
        :icon="TrendingUp"
        :hint="t('ledger.marginHint')"
      />
    </div>

    <!-- 分账明细 -->
    <div class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">
          {{ t('ledger.detailTitle')
          }}{{ !loading && !loadError ? t('ledger.detailCount', { n: rows.length }) : '' }}
        </p>
        <p class="tnum truncate text-xs text-muted">
          {{ month }}<span v-if="siteFilter !== 'all'"> · {{ siteFilter }}</span>
        </p>
      </header>

      <div v-if="loadError" class="p-8">
        <EmptyState :title="t('ledger.loadFailed')" :description="loadError" />
      </div>

      <Table
        v-else
        :columns="columns"
        :rows="tableRows"
        row-key="grantId"
        :loading="loading"
        :empty="t('ledger.tableEmpty')"
      >
        <template #cell-templateTitle="{ row }">
          {{ asRow(row).templateTitle || asRow(row).templateKey }}
        </template>
        <template #cell-requests="{ row }">{{ fmtInt(asRow(row).requests) }}</template>
        <template #cell-tokens="{ row }">{{ fmtInt(asRow(row).tokens) }}</template>
        <template #cell-upstreamCost="{ row }">{{ fmtMoney(asRow(row).upstreamCost) }}</template>
        <template #cell-billedCost="{ row }">{{ fmtMoney(asRow(row).billedCost) }}</template>
        <template #cell-margin="{ row }">
          <span :class="marginClass(asRow(row).margin)">{{ fmtMoney(asRow(row).margin) }}</span>
        </template>
      </Table>
    </div>

    <!-- 手工补账 Modal（root）-->
    <Modal v-model:open="importOpen" :title="t('ledger.modalTitle')" width="560px">
      <div class="space-y-4">
        <p class="text-[13px] leading-relaxed text-muted">
          {{ t('ledger.modalDescBefore')
          }}<code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-accent">manual</code
          >{{ t('ledger.modalDescAfter') }}
        </p>

        <Field :label="t('ledger.fieldGrant')" required :hint="t('ledger.fieldGrantHint')">
          <Input v-model="form.grantId" type="number" :placeholder="t('ledger.grantPlaceholder')" />
        </Field>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field :label="t('ledger.fieldPeriodStart')" required>
            <input v-model="form.periodStart" type="date" :class="[fieldCls, 'w-full']" />
          </Field>
          <Field :label="t('ledger.fieldPeriodEnd')" required>
            <input v-model="form.periodEnd" type="date" :class="[fieldCls, 'w-full']" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field :label="t('ledger.fieldRequests')">
            <Input v-model="form.requests" type="number" placeholder="0" />
          </Field>
          <Field :label="t('ledger.fieldPromptTokens')">
            <Input v-model="form.promptTokens" type="number" placeholder="0" />
          </Field>
          <Field :label="t('ledger.fieldCompletionTokens')">
            <Input v-model="form.completionTokens" type="number" placeholder="0" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field :label="t('ledger.fieldUpstream')" :hint="t('ledger.fieldUpstreamHint')">
            <Input v-model="form.upstreamCost" type="number" placeholder="0.00" />
          </Field>
          <Field :label="t('ledger.fieldBilled')" :hint="t('ledger.fieldBilledHint')">
            <Input v-model="form.billedCost" type="number" placeholder="0.00" />
          </Field>
        </div>
      </div>

      <template #footer>
        <Button variant="ghost" :disabled="importing" @click="importOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!canSubmit" :loading="importing" @click="submitImport">
          {{ t('ledger.submit') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>
