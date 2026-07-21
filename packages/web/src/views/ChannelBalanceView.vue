<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ExternalLink,
  Info,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  TriangleAlert,
  Wallet,
} from 'lucide-vue-next';
import { get, post, put } from '../api/client';
import type {
  ChannelBalanceView as ChannelRow,
  RechargeLink,
  RechargeLinksResponse,
  ResetQuotaResponse,
  UpstreamBalancesResponse,
} from '../api/types';
import {
  Badge,
  Button,
  ConfirmDanger,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  StatCard,
  Table,
  toast,
  type SelectOption,
  type TableColumn,
} from '../components/ui';

/**
 * 上游渠道余额 + 低余额预警 + 快捷充值（F5，root only，口径风险最高，纯只读）。
 *  - 诚实 coverage 横幅：X 渠道有真实额度 / Y 仅估算 / Z 零覆盖 / 降级站提示。
 *  - kind='quota' 显 额度/已用/剩余/可撑天数 真数值 + 低余额红标；
 *    kind='window'/'none' 显『此渠道类型无余额接口，仅估算』+ 日均消耗/窗口闸，可撑天数显『—』绝不编造。
 *  - 充值入口：读 recharge-links，一键新标签外链跳转（target=_blank rel=noopener），root 可编辑增删。
 * 金额显式标 USD（本行业 USD:RMB 1:1，无汇率）。
 */

const { t } = useI18n();

// ---- 天数窗口 ----
const daysMode = ref<string | number>(7);
const customDays = ref<number | string>(14);
const daysOptions = computed<SelectOption[]>(() => [
  { value: 7, label: t('upstream.days7') },
  { value: 30, label: t('upstream.days30') },
  { value: 'custom', label: t('upstream.daysCustom') },
]);
function effectiveDays(): number {
  if (daysMode.value === 'custom') {
    const n = Number(customDays.value);
    return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 7;
  }
  return Number(daysMode.value) || 7;
}

// ---- 余额数据 ----
const loading = ref(true);
const data = ref<UpstreamBalancesResponse | null>(null);

const realRows = computed<ChannelRow[]>(() => (data.value?.rows ?? []).filter((r) => r.siteOk));
const degradedRows = computed<ChannelRow[]>(() => (data.value?.rows ?? []).filter((r) => !r.siteOk));
/** 服务端 RP_UPSTREAM_RESET_ENABLED；关时重置按钮禁用+提示（避免必然 403 的误点） */
const resetEnabled = computed<boolean>(() => data.value?.resetEnabled === true);

async function loadBalances(): Promise<void> {
  loading.value = true;
  try {
    data.value = await get<UpstreamBalancesResponse>('/api/upstream/balances', {
      query: { days: effectiveDays() },
      silent: true,
    });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('upstream.loadFailed'));
  } finally {
    loading.value = false;
  }
}

function onDaysChange(): void {
  if (daysMode.value !== 'custom') void loadBalances();
}

// ---- 格式化（USD 显式；号池绝不编造撑几天）----
function fmtUsd(n: number | undefined): string {
  return n === undefined ? '—' : `${n.toFixed(2)} USD`;
}
function fmtDays(d: number | null | undefined): string {
  return d === null || d === undefined ? '—' : d.toFixed(1);
}
function coverageTone(c: ChannelRow['coverage']): 'green' | 'amber' | 'muted' {
  if (c === 'exact') return 'green';
  if (c === 'estimate') return 'amber';
  return 'muted';
}
function coverageLabel(c: ChannelRow['coverage']): string {
  if (c === 'exact') return t('upstream.covExact');
  if (c === 'estimate') return t('upstream.covEstimate');
  return t('upstream.covNone');
}

const columns = computed<TableColumn[]>(() => [
  { key: 'name', label: t('upstream.colChannel') },
  { key: 'site', label: t('upstream.colSite') },
  { key: 'accountType', label: t('upstream.colType'), mono: true },
  { key: 'coverage', label: t('upstream.colCoverage') },
  { key: 'quotaLimit', label: t('upstream.colQuota'), align: 'right' },
  { key: 'quotaUsed', label: t('upstream.colUsed'), align: 'right' },
  { key: 'remaining', label: t('upstream.colRemaining'), align: 'right' },
  { key: 'daysLeft', label: t('upstream.colDaysLeft'), align: 'right' },
  { key: 'avgDailyCost', label: t('upstream.colAvgDaily'), align: 'right' },
  { key: 'windowCostLimit', label: t('upstream.colWindowLimit'), align: 'right' },
  { key: 'action', label: t('upstream.colAction'), align: 'right' },
]);

const tableRows = computed<Record<string, unknown>[]>(() =>
  realRows.value.map((r) => ({ ...r, rowKey: `${r.siteSlug}:${r.id}` })),
);

/** Table 单元格插槽 row 为 Record<string,unknown>，经 unknown 收敛回 ChannelRow */
function asRow(r: Record<string, unknown>): ChannelRow {
  return r as unknown as ChannelRow;
}

// ---- 充值外链 ----
const links = ref<RechargeLink[]>([]);
const linksLoading = ref(true);

async function loadLinks(): Promise<void> {
  linksLoading.value = true;
  try {
    const res = await get<RechargeLinksResponse>('/api/upstream/recharge-links', { silent: true });
    links.value = Array.isArray(res?.links) ? res.links : [];
  } catch {
    links.value = [];
  } finally {
    linksLoading.value = false;
  }
}

// ---- 充值外链编辑（root 可增删；只存外链，绝不触发任何引擎写）----
/** 编辑态行：note 归一为必填字符串（Input v-model 需 string，避免 undefined） */
interface EditLink {
  label: string;
  url: string;
  note: string;
}
const editOpen = ref(false);
const editRows = ref<EditLink[]>([]);
const saving = ref(false);

function openEdit(): void {
  editRows.value = links.value.map((l) => ({ label: l.label, url: l.url, note: l.note ?? '' }));
  editOpen.value = true;
}
function addRow(): void {
  editRows.value.push({ label: '', url: '', note: '' });
}
function removeRow(idx: number): void {
  editRows.value.splice(idx, 1);
}
function isHttp(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}
async function saveLinks(): Promise<void> {
  const cleaned = editRows.value
    .map((l) => ({ label: l.label.trim(), url: l.url.trim(), note: l.note.trim() }))
    .filter((l) => l.label !== '' && l.url !== '');
  if (cleaned.some((l) => !isHttp(l.url))) {
    toast.error(t('upstream.rechargeUrlInvalid'));
    return;
  }
  saving.value = true;
  try {
    const res = await put<RechargeLinksResponse>('/api/upstream/recharge-links', {
      links: cleaned.map((l) => ({ label: l.label, url: l.url, ...(l.note ? { note: l.note } : {}) })),
    });
    links.value = Array.isArray(res?.links) ? res.links : [];
    toast.success(t('upstream.rechargeSaved'));
    editOpen.value = false;
  } catch {
    // client 已弹后端中文错误
  } finally {
    saving.value = false;
  }
}

// ---- 快捷充值/重置已用（root only；不可逆；后端多重硬闸 + 前端逐字输入渠道名二次确认）----
const resetOpen = ref(false);
const resetting = ref(false);
const resetTarget = ref<ChannelRow | null>(null);

/** 仅对 kind='quota' 行开放；env 关闭时按钮 disabled（openReset 不被触发） */
function openReset(row: ChannelRow): void {
  resetTarget.value = row;
  resetOpen.value = true;
}

async function doReset(): Promise<void> {
  const target = resetTarget.value;
  if (!target) return;
  resetting.value = true;
  try {
    // confirm 令牌=渠道名，与后端精确比对（后端另有 root+env+readonly+仅 quota 守卫）
    const res = await post<ResetQuotaResponse>(
      `/api/upstream/channels/${encodeURIComponent(target.siteSlug)}/${encodeURIComponent(target.id)}/reset-quota`,
      { confirm: target.name, days: effectiveDays() },
    );
    toast.success(
      `${t('upstream.resetSuccess')}: ${res.quotaUsedBefore.toFixed(2)} → ${res.quotaUsedAfter.toFixed(2)} USD`,
    );
    resetOpen.value = false;
    resetTarget.value = null;
    await loadBalances(); // 重新拉取，reset 后已用归零即时可见
  } catch {
    // client 已弹后端中文错误（403/400/404 等）
  } finally {
    resetting.value = false;
  }
}

onMounted(() => {
  void loadBalances();
  void loadLinks();
});
</script>

<template>
  <div class="space-y-5">
    <!-- 头部：说明 + 天数 + 刷新 -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-2xl text-[13px] leading-relaxed text-muted">{{ t('upstream.subtitle') }}</p>
      <div class="flex shrink-0 items-end gap-2">
        <Field :label="t('upstream.daysLabel')">
          <div class="flex items-center gap-2">
            <div class="w-[120px]">
              <Select v-model="daysMode" :options="daysOptions" @update:model-value="onDaysChange" />
            </div>
            <template v-if="daysMode === 'custom'">
              <div class="w-[84px]">
                <Input v-model="customDays" type="number" />
              </div>
              <Button size="sm" @click="loadBalances">{{ t('upstream.daysApply') }}</Button>
            </template>
          </div>
        </Field>
        <Button size="sm" variant="ghost" :loading="loading" @click="loadBalances">
          <RefreshCw :size="14" />
          {{ t('upstream.refresh') }}
        </Button>
      </div>
    </div>

    <!-- 覆盖度横幅 -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        :label="t('upstream.coverageTitle')"
        :value="data?.coverage.withQuota ?? 0"
        tone="green"
        :icon="Wallet"
        :hint="t('upstream.coverageWithQuota')"
        :loading="loading"
      />
      <StatCard
        :label="t('upstream.covEstimate')"
        :value="data?.coverage.windowOnly ?? 0"
        tone="amber"
        :hint="t('upstream.coverageWindowOnly')"
        :loading="loading"
      />
      <StatCard
        :label="t('upstream.covNone')"
        :value="data?.coverage.zeroCoverage ?? 0"
        tone="default"
        :hint="t('upstream.coverageZero')"
        :loading="loading"
      />
      <StatCard
        :label="t('upstream.coverageDegraded')"
        :value="data?.coverage.degradedSites ?? 0"
        :tone="(data?.coverage.degradedSites ?? 0) > 0 ? 'red' : 'default'"
        :hint="t('upstream.coverageDegraded')"
        :loading="loading"
      />
    </div>

    <!-- 诚实口径说明 -->
    <div class="rp-panel flex items-start gap-2 p-3 text-xs leading-relaxed text-muted">
      <Info :size="14" class="mt-0.5 shrink-0 text-accent" />
      <span>{{ t('upstream.coverageNote') }}</span>
    </div>

    <!-- 阈值提示 -->
    <p
      v-if="data && data.thresholdUsd <= 0"
      class="flex items-start gap-1.5 text-xs text-muted"
    >
      <TriangleAlert :size="13" class="mt-0.5 shrink-0 text-amber" />
      {{ t('upstream.thresholdOff') }}
    </p>

    <!-- 降级站提示 -->
    <div
      v-if="degradedRows.length > 0"
      class="rp-panel flex flex-wrap items-center gap-2 p-3 text-xs text-muted"
    >
      <TriangleAlert :size="14" class="shrink-0 text-red" />
      <span>{{ t('upstream.degradedNote') }}</span>
      <Badge v-for="d in degradedRows" :key="d.siteSlug" tone="red" size="sm">
        {{ d.siteLabel || d.siteSlug }}
      </Badge>
    </div>

    <!-- 渠道表 -->
    <section class="rp-panel overflow-hidden">
      <div v-if="loading" class="p-4">
        <Skeleton :lines="4" />
      </div>
      <Table
        v-else
        :columns="columns"
        :rows="tableRows"
        row-key="rowKey"
        :empty="t('upstream.tableEmpty')"
      >
        <template #cell-name="{ row }">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-medium text-text/90">{{ asRow(row).name }}</span>
            <Badge v-if="!asRow(row).enabled" tone="muted" size="sm">
              {{ t('upstream.statusDisabled') }}
            </Badge>
          </div>
        </template>
        <template #cell-site="{ row }">
          <span class="text-xs text-muted">{{ asRow(row).siteLabel || asRow(row).siteSlug }}</span>
        </template>
        <template #cell-coverage="{ row }">
          <Badge :tone="coverageTone(asRow(row).coverage)" size="sm">
            {{ coverageLabel(asRow(row).coverage) }}
          </Badge>
        </template>
        <template #cell-quotaLimit="{ row }">
          <span class="tnum">{{ fmtUsd(asRow(row).quotaLimit) }}</span>
        </template>
        <template #cell-quotaUsed="{ row }">
          <span class="tnum">{{ fmtUsd(asRow(row).quotaUsed) }}</span>
        </template>
        <template #cell-remaining="{ row }">
          <span
            class="tnum"
            :class="asRow(row).low ? 'font-semibold text-red' : 'text-text/90'"
          >
            {{ fmtUsd(asRow(row).remaining) }}
          </span>
          <Badge v-if="asRow(row).low" tone="red" size="sm" class="ml-1.5">
            {{ t('upstream.lowBadge') }}
          </Badge>
        </template>
        <template #cell-daysLeft="{ row }">
          <span class="tnum text-muted">{{ fmtDays(asRow(row).daysLeft) }}</span>
        </template>
        <template #cell-avgDailyCost="{ row }">
          <span
            class="tnum text-muted"
            :title="asRow(row).kind !== 'quota' ? t('upstream.noBalanceApi') : ''"
          >
            {{ fmtUsd(asRow(row).avgDailyCost) }}
          </span>
        </template>
        <template #cell-windowCostLimit="{ row }">
          <span class="tnum text-muted">{{ fmtUsd(asRow(row).windowCostLimit) }}</span>
        </template>
        <template #cell-action="{ row }">
          <!-- 仅 quota 型可重置；window/none 无额度接口，只显提示不给动作 -->
          <template v-if="asRow(row).kind === 'quota'">
            <Button
              size="sm"
              variant="ghost"
              :disabled="!resetEnabled"
              :title="resetEnabled ? '' : t('upstream.resetDisabledHint')"
              @click="openReset(asRow(row))"
            >
              <RotateCcw :size="13" />
              {{ t('upstream.resetBtn') }}
            </Button>
          </template>
          <span v-else class="text-xs text-muted" :title="t('upstream.resetOnlyQuotaHint')">—</span>
        </template>
      </Table>
    </section>

    <!-- 充值入口 -->
    <section class="rp-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Wallet :size="15" class="text-accent" />
          <h2 class="text-sm font-semibold">{{ t('upstream.rechargeTitle') }}</h2>
        </div>
        <Button size="sm" variant="ghost" @click="openEdit">
          <Settings2 :size="14" />
          {{ t('upstream.rechargeManage') }}
        </Button>
      </div>
      <p class="mb-3 max-w-2xl text-xs leading-relaxed text-muted">{{ t('upstream.rechargeDesc') }}</p>

      <div v-if="linksLoading">
        <Skeleton :lines="2" />
      </div>
      <div v-else-if="links.length === 0">
        <EmptyState :icon="Wallet" :title="t('upstream.rechargeEmpty')" />
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <a
          v-for="(l, i) in links"
          :key="i"
          :href="l.url"
          target="_blank"
          rel="noopener noreferrer"
          class="group inline-flex items-center gap-2 rounded-lg border border-border bg-panel-2/50 px-3 py-2 text-[13px] text-text/90 transition-colors hover:border-accent/50 hover:bg-panel-2"
        >
          <ExternalLink :size="13" class="text-muted group-hover:text-accent" />
          <span class="font-medium">{{ l.label }}</span>
          <span v-if="l.note" class="text-xs text-muted">· {{ l.note }}</span>
        </a>
      </div>
    </section>

    <!-- 充值外链编辑弹窗 -->
    <Modal v-model:open="editOpen" :title="t('upstream.rechargeEditTitle')" width="640px" :closable="!saving">
      <div class="space-y-3">
        <p class="text-xs leading-relaxed text-muted">{{ t('upstream.rechargeUrlHint') }}</p>
        <div
          v-for="(row, idx) in editRows"
          :key="idx"
          class="grid grid-cols-1 gap-2 rounded-lg border border-border/70 bg-panel-2/40 p-3 sm:grid-cols-[1fr_1.5fr_1fr_auto]"
        >
          <Field :label="t('upstream.rechargeLabel')">
            <Input v-model="row.label" :disabled="saving" />
          </Field>
          <Field :label="t('upstream.rechargeUrl')">
            <Input v-model="row.url" placeholder="https://" :disabled="saving" />
          </Field>
          <Field :label="t('upstream.rechargeNote')">
            <Input v-model="row.note" :disabled="saving" />
          </Field>
          <div class="flex items-end">
            <Button size="sm" variant="ghost" :disabled="saving" @click="removeRow(idx)">
              <Trash2 :size="14" />
            </Button>
          </div>
        </div>
        <Button size="sm" variant="ghost" :disabled="saving" @click="addRow">
          <Plus :size="14" />
          {{ t('upstream.rechargeAdd') }}
        </Button>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="saving" @click="editOpen = false">
          {{ t('upstream.rechargeCancel') }}
        </Button>
        <Button variant="primary" :loading="saving" @click="saveLinks">
          {{ t('upstream.rechargeSave') }}
        </Button>
      </template>
    </Modal>

    <!-- 重置已用额度确认（不可逆；要求逐字输入渠道名，与后端 confirm 令牌一一对应）-->
    <ConfirmDanger
      v-model:open="resetOpen"
      :title="t('upstream.resetConfirmTitle')"
      :confirm-text="resetTarget?.name ?? ''"
      :message="t('upstream.resetConfirmMessage')"
      :action-label="t('upstream.resetConfirmAction')"
      :loading="resetting"
      @confirm="doReset"
    />
  </div>
</template>
