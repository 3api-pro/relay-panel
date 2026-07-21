<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  AlertTriangle,
  Camera,
  CreditCard,
  RefreshCw,
  SlidersHorizontal,
  UserRound,
  Users,
  Wallet,
} from 'lucide-vue-next';
import { get, post, put } from '../api/client';
import { session } from '../api/session';
import { toast } from '../components/ui/toast';
import type {
  CustomerCrmConfig,
  CustomerCrmRow,
  CustomersResponse,
  CustomerTotals,
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

/**
 * 客户 CRM + 流失预警（F4，root only）。
 *  - 客户资产/活跃/流失一屏：分层计数卡 + 负债合计（注明跨站重复计）+ 客户表（tier / 流失理由）。
 *  - 冷启动横幅：快照天数不足 minSnapshotDays 时提示需积累。
 *  - 阈值编辑 Modal（root）：分层门槛 / 流失阈值，金额显式标 USD。
 * 🔴 只呈现客户预付负债(user.balance) 与充值，绝不显示上游供应商/成本/倍率；与 channel 余额严格区分。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>(
  'canWrite',
  computed(() => false),
);
const isRoot = session.isRoot;

// ---- 数据 ----
function emptyTotals(): CustomerTotals {
  return {
    customers: 0,
    liabilityTotal: 0,
    tierBig: 0,
    tierMid: 0,
    tierSmall: 0,
    churnCount: 0,
    subscriptionCount: 0,
  };
}
const rows = ref<CustomerCrmRow[]>([]);
const totals = ref<CustomerTotals>(emptyTotals());
const config = ref<CustomerCrmConfig | null>(null);
const snapshotDaysAvailable = ref(0);
const degradedCount = ref(0);
const loading = ref(true);
const loadError = ref('');
const snapshotting = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await get<CustomersResponse>('/api/customers', { silent: true });
    rows.value = Array.isArray(res?.rows) ? res.rows : [];
    totals.value = res?.totals ?? emptyTotals();
    config.value = res?.config ?? null;
    snapshotDaysAvailable.value = res?.snapshotDaysAvailable ?? 0;
    degradedCount.value = Array.isArray(res?.degradedSites) ? res.degradedSites.length : 0;
  } catch (err) {
    rows.value = [];
    totals.value = emptyTotals();
    loadError.value = err instanceof Error ? err.message : t('customers.loadFailed');
  } finally {
    loading.value = false;
  }
}

// 冷启动：已积累天数 < minSnapshotDays 时提示
const coldStart = computed(
  () => config.value !== null && snapshotDaysAvailable.value < config.value.minSnapshotDays,
);

async function runSnapshot(): Promise<void> {
  snapshotting.value = true;
  try {
    const res = await post<{ written: number }>('/api/customers/snapshot');
    toast.success(t('customers.snapshotDone', { n: res?.written ?? 0 }));
    await load();
  } catch {
    // client 已弹错误
  } finally {
    snapshotting.value = false;
  }
}

// ---- 格式化 ----
function fmtInt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}
/** USD 金额：$ 前缀，≥1 两位小数，<1 自适应 4~6 位（免亚分级被抹平） */
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  let digits = 2;
  if (abs > 0 && abs < 1) digits = abs < 0.01 ? 6 : 4;
  const v = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '-' : ''}$${v}`;
}
/** 取活跃/使用较晚者作最近活跃展示 */
function lastActiveOf(r: CustomerCrmRow): string {
  const a = r.lastActiveAt ? Date.parse(r.lastActiveAt) : NaN;
  const u = r.lastUsedAt ? Date.parse(r.lastUsedAt) : NaN;
  const best = Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(u) ? u : -Infinity);
  if (!Number.isFinite(best)) return t('customers.never');
  return new Date(best).toISOString().slice(0, 10);
}
function dropText(r: CustomerCrmRow): string {
  if (!r.enoughHistory) return '—';
  return `${Math.round(r.dropPct * 100)}%`;
}
function tierLabel(tier: CustomerCrmRow['tier']): string {
  return tier === 'big' ? t('customers.tierBig') : tier === 'mid' ? t('customers.tierMid') : t('customers.tierSmall');
}
function tierTone(tier: CustomerCrmRow['tier']): 'accent' | 'default' | 'muted' {
  return tier === 'big' ? 'accent' : tier === 'mid' ? 'default' : 'muted';
}
function reasonLabel(reason: string): string {
  return reason === 'inactive' ? t('customers.reasonInactive') : t('customers.reasonSpendDrop');
}

// ---- 表格 ----
const columns = computed<TableColumn[]>(() => [
  { key: 'customer', label: t('customers.colCustomer') },
  { key: 'site', label: t('customers.colSite') },
  { key: 'tier', label: t('customers.colTier') },
  { key: 'balance', label: t('customers.colBalance'), align: 'right' },
  { key: 'recharged', label: t('customers.colRecharged'), align: 'right' },
  { key: 'dailySpend', label: t('customers.colDailySpend'), align: 'right' },
  { key: 'drop', label: t('customers.colDrop'), align: 'right' },
  { key: 'lastActive', label: t('customers.colLastActive'), align: 'right' },
  { key: 'churn', label: t('customers.colChurn') },
]);
const tableRows = computed<Record<string, unknown>[]>(
  () => rows.value as unknown as Record<string, unknown>[],
);
function asRow(r: Record<string, unknown>): CustomerCrmRow {
  return r as unknown as CustomerCrmRow;
}

// ---- 阈值配置（root）----
const cfgOpen = ref(false);
const cfgSaving = ref(false);
const cfgForm = reactive({
  tierBigUsd: '' as number | string,
  tierMidUsd: '' as number | string,
  churnInactiveDays: '' as number | string,
  dropWindowDays: '' as number | string,
  dropThresholdPct: '' as number | string,
  minSnapshotDays: '' as number | string,
  churnAlertsEnabled: 'off' as string | number,
});

const alertOptions = computed<SelectOption[]>(() => [
  { value: 'off', label: t('customers.no') },
  { value: 'on', label: t('customers.yes') },
]);

function openConfig(): void {
  const c = config.value;
  if (!c) return;
  cfgForm.tierBigUsd = c.tierBigUsd;
  cfgForm.tierMidUsd = c.tierMidUsd;
  cfgForm.churnInactiveDays = c.churnInactiveDays;
  cfgForm.dropWindowDays = c.dropWindowDays;
  cfgForm.dropThresholdPct = Math.round(c.dropThresholdPct * 100);
  cfgForm.minSnapshotDays = c.minSnapshotDays;
  cfgForm.churnAlertsEnabled = c.churnAlertsEnabled ? 'on' : 'off';
  cfgOpen.value = true;
}

function numOrUndef(v: number | string): number | undefined {
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function saveConfig(): Promise<void> {
  const pct = numOrUndef(cfgForm.dropThresholdPct);
  const body: Partial<CustomerCrmConfig> = {
    ...(numOrUndef(cfgForm.tierBigUsd) !== undefined ? { tierBigUsd: numOrUndef(cfgForm.tierBigUsd) } : {}),
    ...(numOrUndef(cfgForm.tierMidUsd) !== undefined ? { tierMidUsd: numOrUndef(cfgForm.tierMidUsd) } : {}),
    ...(numOrUndef(cfgForm.churnInactiveDays) !== undefined
      ? { churnInactiveDays: numOrUndef(cfgForm.churnInactiveDays) }
      : {}),
    ...(numOrUndef(cfgForm.dropWindowDays) !== undefined ? { dropWindowDays: numOrUndef(cfgForm.dropWindowDays) } : {}),
    ...(pct !== undefined ? { dropThresholdPct: Math.min(1, Math.max(0, pct / 100)) } : {}),
    ...(numOrUndef(cfgForm.minSnapshotDays) !== undefined ? { minSnapshotDays: numOrUndef(cfgForm.minSnapshotDays) } : {}),
    churnAlertsEnabled: cfgForm.churnAlertsEnabled === 'on',
  };
  cfgSaving.value = true;
  try {
    const res = await put<{ config: CustomerCrmConfig }>('/api/customers/config', body);
    config.value = res?.config ?? config.value;
    toast.success(t('customers.saved'));
    cfgOpen.value = false;
    await load();
  } catch {
    // client 已弹错误
  } finally {
    cfgSaving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 工具条 -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="rp-microlabel">{{ t('customers.microlabel') }}</p>
        <p class="mt-1 max-w-2xl text-xs text-muted">{{ t('customers.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :loading="loading" @click="load">
          <RefreshCw :size="14" /> {{ t('customers.refresh') }}
        </Button>
        <Button v-if="isRoot && canWrite" variant="outline" size="sm" :loading="snapshotting" @click="runSnapshot">
          <Camera :size="14" /> {{ snapshotting ? t('customers.snapshotRunning') : t('customers.runSnapshot') }}
        </Button>
        <Button v-if="isRoot && canWrite" variant="outline" size="sm" :disabled="!config" @click="openConfig">
          <SlidersHorizontal :size="14" /> {{ t('customers.editConfig') }}
        </Button>
      </div>
    </div>

    <!-- 冷启动横幅 -->
    <div
      v-if="!loading && !loadError && coldStart && config"
      class="rp-panel flex items-start gap-2 px-4 py-3"
    >
      <AlertTriangle :size="15" class="mt-0.5 shrink-0 text-amber" />
      <p class="text-xs leading-relaxed text-muted">
        {{ t('customers.coldStartBanner', { days: config.minSnapshotDays, have: snapshotDaysAvailable }) }}
      </p>
    </div>

    <!-- 降级站提示 -->
    <div v-if="!loading && !loadError && degradedCount > 0" class="text-xs text-muted">
      {{ t('customers.degradedNote', { n: degradedCount }) }}
    </div>

    <!-- 合计统计卡 -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard
        :label="t('customers.statCustomers')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.customers)"
        :loading="loading"
        :icon="Users"
      />
      <StatCard
        :label="t('customers.statBigR')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.tierBig)"
        :loading="loading"
        tone="accent"
        :icon="UserRound"
      />
      <StatCard
        :label="t('customers.statMidR')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.tierMid)"
        :loading="loading"
        :icon="UserRound"
      />
      <StatCard
        :label="t('customers.statSmallR')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.tierSmall)"
        :loading="loading"
        :icon="UserRound"
      />
      <StatCard
        :label="t('customers.statLiability')"
        :value="loading ? '' : loadError ? '—' : fmtUsd(totals.liabilityTotal)"
        :loading="loading"
        :icon="Wallet"
        :hint="t('customers.statLiabilityHint')"
      />
      <StatCard
        :label="t('customers.statChurn')"
        :value="loading ? '' : loadError ? '—' : fmtInt(totals.churnCount)"
        :loading="loading"
        :tone="totals.churnCount > 0 ? 'amber' : 'default'"
        :icon="AlertTriangle"
        :hint="t('customers.statChurnHint')"
      />
    </div>

    <!-- 口径提示 -->
    <p class="text-xs text-muted">{{ t('customers.liabilityDupNote') }} {{ t('customers.estimateNote') }}</p>

    <!-- 客户表 -->
    <div class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">{{ t('customers.microlabel') }}</p>
        <p class="tnum truncate text-xs text-muted">
          <CreditCard :size="12" class="mr-1 inline" />{{ t('customers.statSubscriptions') }}: {{ fmtInt(totals.subscriptionCount) }}
        </p>
      </header>

      <div v-if="loadError" class="p-8">
        <EmptyState :title="t('customers.loadFailed')" :description="loadError" />
      </div>

      <Table
        v-else
        :columns="columns"
        :rows="tableRows"
        row-key="key"
        :loading="loading"
        :empty="t('customers.tableEmpty')"
      >
        <template #cell-customer="{ row }">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px]">{{ asRow(row).email || `#${asRow(row).userId}` }}</span>
            <Badge v-if="asRow(row).hasSubscription" tone="accent" size="sm">{{ t('customers.colSubscription') }}</Badge>
          </div>
        </template>
        <template #cell-site="{ row }">
          <span class="truncate font-mono text-xs text-muted">{{ asRow(row).siteLabel || asRow(row).siteSlug }}</span>
        </template>
        <template #cell-tier="{ row }">
          <Badge :tone="tierTone(asRow(row).tier)" size="sm">{{ tierLabel(asRow(row).tier) }}</Badge>
        </template>
        <template #cell-balance="{ row }"><span class="tnum">{{ fmtUsd(asRow(row).balance) }}</span></template>
        <template #cell-recharged="{ row }"><span class="tnum">{{ fmtUsd(asRow(row).totalRecharged) }}</span></template>
        <template #cell-dailySpend="{ row }">
          <span class="tnum text-muted">{{ asRow(row).enoughHistory ? fmtUsd(asRow(row).dailySpendRecent) : '—' }}</span>
        </template>
        <template #cell-drop="{ row }">
          <span
            class="tnum"
            :class="asRow(row).enoughHistory && asRow(row).dropPct >= 0.5 ? 'text-amber' : 'text-muted'"
          >{{ dropText(asRow(row)) }}</span>
        </template>
        <template #cell-lastActive="{ row }"><span class="tnum text-xs text-muted">{{ lastActiveOf(asRow(row)) }}</span></template>
        <template #cell-churn="{ row }">
          <div v-if="asRow(row).churnRisk" class="flex flex-wrap items-center gap-1">
            <Badge
              v-for="reason in asRow(row).churnReasons"
              :key="reason"
              tone="amber"
              size="sm"
            >{{ reasonLabel(reason) }}</Badge>
          </div>
          <span v-else class="text-xs text-muted">—</span>
        </template>
      </Table>
    </div>

    <!-- 阈值配置 Modal（root）-->
    <Modal v-model:open="cfgOpen" :title="t('customers.configTitle')" width="560px">
      <div class="space-y-4">
        <p class="text-[13px] leading-relaxed text-muted">{{ t('customers.configDesc') }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <Field :label="t('customers.cfgTierBig')" :hint="t('customers.cfgTierBigHint')">
            <Input v-model="cfgForm.tierBigUsd" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgTierMid')" :hint="t('customers.cfgTierMidHint')">
            <Input v-model="cfgForm.tierMidUsd" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgChurnInactive')" :hint="t('customers.cfgChurnInactiveHint')">
            <Input v-model="cfgForm.churnInactiveDays" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgDropWindow')" :hint="t('customers.cfgDropWindowHint')">
            <Input v-model="cfgForm.dropWindowDays" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgDropThreshold')" :hint="t('customers.cfgDropThresholdHint')">
            <Input v-model="cfgForm.dropThresholdPct" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgMinSnapshot')" :hint="t('customers.cfgMinSnapshotHint')">
            <Input v-model="cfgForm.minSnapshotDays" type="number" :disabled="cfgSaving" />
          </Field>
          <Field :label="t('customers.cfgChurnAlerts')" :hint="t('customers.cfgChurnAlertsHint')">
            <Select v-model="cfgForm.churnAlertsEnabled" :options="alertOptions" :disabled="cfgSaving" />
          </Field>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="cfgSaving" @click="cfgOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="cfgSaving" @click="saveConfig">{{ t('customers.save') }}</Button>
      </template>
    </Modal>
  </div>
</template>
