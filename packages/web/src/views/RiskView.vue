<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RefreshCw, Scan, ShieldAlert, ShieldCheck, SlidersHorizontal, TriangleAlert } from 'lucide-vue-next';
import { get, post, put } from '../api/client';
import type {
  PlatformQuota,
  PlatformQuotaInput,
  QuotaPreviewResponse,
  QuotaWindow,
  RiskRulesResponse,
  RiskScanResponse,
  RiskSpikeRow,
} from '../api/types';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  toast,
  type SelectOption,
} from '../components/ui';

/**
 * 风控 / 异常消费告警 + 限额护栏（F3，root only）。
 *  - 规则编辑：骤增倍率 / 绝对下限USD / 基线天数（PUT /api/risk/rules）。
 *  - 骤增榜：POST /api/risk/scan（站点/客户/近期消费/基线/倍数）。
 *  - 每行「将限额」：GET-合并预览 + 写回；写回按钮受 API 返回的 enforce 门控
 *    （off 时禁用并提示「仅告警模式，写回需 RP_RISK_ENFORCE=on」）。
 * 金额显式标 USD（本行业 USD:RMB 1:1，无汇率）。
 */

const { t } = useI18n();

// enforce 快照：每次读实时值（GET rules / scan / preview 都回该字段），勿缓存旧值
const enforce = ref(false);

// ---- 规则 ----
const spikeMultiplier = ref<number | string>(3);
const absFloorUsd = ref<number | string>(10);
const baselineDays = ref<number | string>(7);
const rulesLoading = ref(true);
const rulesSaving = ref(false);

/** number 输入值 → number | undefined（空串/非数跳过，不落成 0） */
function numOrUndef(v: number | string): number | undefined {
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function loadRules(): Promise<void> {
  rulesLoading.value = true;
  try {
    const res = await get<RiskRulesResponse>('/api/risk/rules', { silent: true });
    spikeMultiplier.value = res.rules.spikeMultiplier;
    absFloorUsd.value = res.rules.absFloorUsd;
    baselineDays.value = res.rules.baselineDays;
    enforce.value = res.enforce;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('risk.loadFailed'));
  } finally {
    rulesLoading.value = false;
  }
}

async function saveRules(): Promise<void> {
  rulesSaving.value = true;
  try {
    const sm = numOrUndef(spikeMultiplier.value);
    const af = numOrUndef(absFloorUsd.value);
    const bd = numOrUndef(baselineDays.value);
    const res = await put<RiskRulesResponse>('/api/risk/rules', {
      ...(sm !== undefined ? { spikeMultiplier: sm } : {}),
      ...(af !== undefined ? { absFloorUsd: af } : {}),
      ...(bd !== undefined ? { baselineDays: bd } : {}),
    });
    spikeMultiplier.value = res.rules.spikeMultiplier;
    absFloorUsd.value = res.rules.absFloorUsd;
    baselineDays.value = res.rules.baselineDays;
    enforce.value = res.enforce;
    toast.success(t('risk.rulesSaved'));
  } catch {
    // client 已弹后端中文错误
  } finally {
    rulesSaving.value = false;
  }
}

// ---- 扫描 / 骤增榜 ----
const spikes = ref<RiskSpikeRow[]>([]);
const scanned = ref(false);
const scanning = ref(false);

async function runScan(): Promise<void> {
  scanning.value = true;
  try {
    const res = await post<RiskScanResponse>('/api/risk/scan');
    spikes.value = Array.isArray(res?.spikes) ? res.spikes : [];
    enforce.value = res.enforce;
    scanned.value = true;
  } catch {
    // client 已弹错误
  } finally {
    scanning.value = false;
  }
}

function fmtUsd(n: number): string {
  return `${n.toFixed(2)} USD`;
}
function fmtRatio(r: number | null): string {
  return r === null ? t('risk.ratioNew') : `${r.toFixed(1)}x`;
}

// ---- 限额（将限额）弹窗 ----
const limitOpen = ref(false);
const activeRow = ref<RiskSpikeRow | null>(null);
const platform = ref<string | number>('anthropic');
const quotaWindow = ref<string | number>('daily');
/** 空=不限(null)；0=禁用；正数=USD 上限 */
const limitInput = ref<number | string>('');
const previewing = ref(false);
const applying = ref(false);
const preview = ref<QuotaPreviewResponse | null>(null);

const platformOptions: SelectOption[] = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai', label: 'openai' },
  { value: 'gemini', label: 'gemini' },
  { value: 'codex', label: 'codex' },
  { value: 'grok', label: 'grok' },
];
const windowOptions = computed<SelectOption[]>(() => [
  { value: 'daily', label: t('risk.windowDaily') },
  { value: 'weekly', label: t('risk.windowWeekly') },
  { value: 'monthly', label: t('risk.windowMonthly') },
]);

function openLimit(row: RiskSpikeRow): void {
  activeRow.value = row;
  platform.value = 'anthropic';
  quotaWindow.value = 'daily';
  limitInput.value = '';
  preview.value = null;
  limitOpen.value = true;
}

/** 输入 → limitUsd：空=不限(null)，否则数值（0=禁用；非数回落 null） */
function limitUsdValue(): number | null {
  if (limitInput.value === '') return null;
  const n = Number(limitInput.value);
  return Number.isFinite(n) ? n : null;
}

/** 当前 {platform, window, limitUsd} 请求体 */
function changeBody(): { platform: string; window: QuotaWindow; limitUsd: number | null } {
  return {
    platform: String(platform.value),
    window: quotaWindow.value as QuotaWindow,
    limitUsd: limitUsdValue(),
  };
}

async function doPreview(): Promise<void> {
  const row = activeRow.value;
  if (!row) return;
  previewing.value = true;
  try {
    const res = await post<QuotaPreviewResponse>(
      `/api/risk/users/${encodeURIComponent(row.siteSlug)}/${encodeURIComponent(String(row.userId))}/quota-preview`,
      changeBody(),
    );
    preview.value = res;
    enforce.value = res.enforce;
  } catch {
    // client 已弹错误
  } finally {
    previewing.value = false;
  }
}

async function doApply(): Promise<void> {
  const row = activeRow.value;
  if (!row || !enforce.value) return;
  applying.value = true;
  try {
    await post(
      `/api/risk/users/${encodeURIComponent(row.siteSlug)}/${encodeURIComponent(String(row.userId))}/enforce`,
      changeBody(),
    );
    toast.success(t('risk.applied'));
    limitOpen.value = false;
  } catch {
    // client 已弹错误（含 off 时 403 仅告警模式）
  } finally {
    applying.value = false;
  }
}

// ---- 预览渲染：单元格值 ----
function fmtLimit(v: number | null | undefined): string {
  if (v === undefined) return '—';
  if (v === null) return t('risk.valUnlimited');
  if (v === 0) return t('risk.valDisabled');
  return `${v} USD`;
}
function currentLimit(platformName: string, w: QuotaWindow): number | null | undefined {
  const p = preview.value?.current.find((q) => q.platform === platformName);
  if (!p) return undefined;
  return p[w].limitUsd;
}
function mergedLimit(row: PlatformQuotaInput, w: QuotaWindow): number | null | undefined {
  if (w === 'daily') return row.dailyLimitUsd;
  if (w === 'weekly') return row.weeklyLimitUsd;
  return row.monthlyLimitUsd;
}
const windowKeys: QuotaWindow[] = ['daily', 'weekly', 'monthly'];

onMounted(() => {
  void loadRules();
});
</script>

<template>
  <div class="space-y-5">
    <!-- 头部：说明 + enforce 状态 -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-2xl text-[13px] leading-relaxed text-muted">{{ t('risk.subtitle') }}</p>
      <div class="shrink-0">
        <Badge v-if="enforce" tone="green" size="sm">
          <ShieldAlert :size="12" />
          {{ t('risk.enforceOn') }}
        </Badge>
        <Badge v-else tone="muted" size="sm">
          <ShieldCheck :size="12" />
          {{ t('risk.enforceOff') }}
        </Badge>
      </div>
    </div>

    <!-- 规则编辑 -->
    <section class="rp-panel p-4">
      <div class="mb-3 flex items-center gap-2">
        <SlidersHorizontal :size="15" class="text-accent" />
        <h2 class="text-sm font-semibold">{{ t('risk.rulesTitle') }}</h2>
      </div>
      <p class="mb-4 text-xs leading-relaxed text-muted">{{ t('risk.rulesDesc') }}</p>

      <div v-if="rulesLoading">
        <Skeleton :lines="2" />
      </div>
      <div v-else class="grid gap-4 sm:grid-cols-3">
        <Field :label="t('risk.spikeMultiplier')" :hint="t('risk.spikeMultiplierHint')">
          <Input v-model="spikeMultiplier" type="number" :disabled="rulesSaving" />
        </Field>
        <Field :label="t('risk.absFloor')" :hint="t('risk.absFloorHint')">
          <Input v-model="absFloorUsd" type="number" :disabled="rulesSaving" />
        </Field>
        <Field :label="t('risk.baselineDays')" :hint="t('risk.baselineDaysHint')">
          <Input v-model="baselineDays" type="number" :disabled="rulesSaving" />
        </Field>
      </div>
      <div v-if="!rulesLoading" class="mt-4 flex justify-end">
        <Button variant="primary" size="sm" :loading="rulesSaving" @click="saveRules">
          {{ t('risk.saveRules') }}
        </Button>
      </div>
    </section>

    <!-- 骤增榜 -->
    <section class="rp-panel overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 class="text-sm font-semibold">{{ t('risk.scanTitle') }}</h2>
          <p class="mt-0.5 max-w-xl text-xs text-muted">{{ t('risk.scanDesc') }}</p>
        </div>
        <Button size="sm" :loading="scanning" @click="runScan">
          <Scan :size="14" />
          {{ scanning ? t('risk.scanning') : t('risk.runScan') }}
        </Button>
      </div>

      <!-- 未扫描 -->
      <div v-if="!scanned && !scanning" class="p-8">
        <EmptyState :icon="ShieldCheck" :title="t('risk.scanNeverTitle')" :description="t('risk.scanNeverDesc')" />
      </div>

      <!-- 扫描中骨架 -->
      <div v-else-if="scanning && spikes.length === 0" class="divide-y divide-border/60">
        <div v-for="i in 4" :key="i" class="px-4 py-3.5"><Skeleton :lines="1" /></div>
      </div>

      <!-- 空态 -->
      <div v-else-if="spikes.length === 0" class="p-8">
        <EmptyState :icon="ShieldCheck" :title="t('risk.scanEmptyTitle')" :description="t('risk.scanEmptyDesc')" />
      </div>

      <!-- 骤增行 -->
      <template v-else>
        <div class="hidden items-center gap-3 border-b border-border px-4 py-2.5 md:flex">
          <span class="rp-microlabel w-[120px] shrink-0">{{ t('risk.colSite') }}</span>
          <span class="rp-microlabel min-w-0 flex-1">{{ t('risk.colCustomer') }}</span>
          <span class="rp-microlabel w-[120px] shrink-0 text-right">{{ t('risk.colRecent') }}</span>
          <span class="rp-microlabel w-[140px] shrink-0 text-right">{{ t('risk.colBaseline') }}</span>
          <span class="rp-microlabel w-[72px] shrink-0 text-right">{{ t('risk.colRatio') }}</span>
          <span class="w-[92px] shrink-0" />
        </div>
        <ul class="divide-y divide-border/60">
          <li
            v-for="(row, idx) in spikes"
            :key="`${row.siteSlug}:${row.userId}:${idx}`"
            class="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-3"
          >
            <div class="w-[120px] shrink-0">
              <span class="truncate font-mono text-xs text-muted">{{ row.siteLabel || row.siteSlug }}</span>
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-medium text-text/90">{{ row.email || `#${row.userId}` }}</p>
            </div>
            <div class="w-[120px] shrink-0 md:text-right">
              <span class="tnum text-[13px] font-medium text-text/90">{{ fmtUsd(row.recentCost) }}</span>
            </div>
            <div class="w-[140px] shrink-0 md:text-right">
              <span class="tnum text-xs text-muted">{{ fmtUsd(row.baselineDaily) }}</span>
            </div>
            <div class="w-[72px] shrink-0 md:text-right">
              <Badge :tone="row.ratio === null ? 'amber' : 'red'" size="sm">{{ fmtRatio(row.ratio) }}</Badge>
            </div>
            <div class="w-[92px] shrink-0 md:text-right">
              <Button size="sm" variant="ghost" @click="openLimit(row)">
                <ShieldAlert :size="13" />
                {{ t('risk.setLimit') }}
              </Button>
            </div>
          </li>
        </ul>
      </template>
    </section>

    <!-- 将限额弹窗 -->
    <Modal v-model:open="limitOpen" :title="t('risk.limitTitle')" width="560px" :closable="!applying && !previewing">
      <div class="space-y-4">
        <p class="text-[13px] leading-relaxed text-muted">{{ t('risk.limitDesc') }}</p>

        <div v-if="activeRow" class="rounded-lg border border-border/70 bg-panel-2/40 px-3 py-2 text-xs text-muted">
          <span class="text-muted/70">{{ t('risk.customerField') }}:</span>
          <span class="ml-1 font-mono text-text/85">{{ activeRow.email || `#${activeRow.userId}` }}</span>
          <span class="ml-1 text-muted/50">/ {{ activeRow.siteLabel || activeRow.siteSlug }}</span>
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <Field :label="t('risk.platformLabel')">
            <Select v-model="platform" :options="platformOptions" :disabled="applying" />
          </Field>
          <Field :label="t('risk.windowLabel')">
            <Select v-model="quotaWindow" :options="windowOptions" :disabled="applying" />
          </Field>
          <Field :label="t('risk.limitLabel')" :hint="t('risk.limitHint')">
            <Input v-model="limitInput" type="number" placeholder="USD" :disabled="applying" />
          </Field>
        </div>

        <div class="flex justify-start">
          <Button size="sm" :loading="previewing" @click="doPreview">
            <RefreshCw :size="13" />
            {{ previewing ? t('risk.previewing') : t('risk.previewBtn') }}
          </Button>
        </div>

        <!-- 合并预览 -->
        <div v-if="preview" class="space-y-2">
          <div class="flex items-center gap-1.5">
            <TriangleAlert :size="13" class="text-amber" />
            <span class="text-xs font-medium text-text/85">{{ t('risk.previewTitle') }}</span>
          </div>
          <div class="overflow-x-auto rounded-lg border border-border/70">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-border/70 text-muted/80">
                  <th class="px-3 py-2 text-left font-medium">{{ t('risk.platformLabel') }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t('risk.windowDaily') }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t('risk.windowWeekly') }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t('risk.windowMonthly') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="mrow in preview.merged" :key="mrow.platform" class="border-b border-border/40 last:border-0">
                  <td class="px-3 py-2 font-mono text-text/85">{{ mrow.platform }}</td>
                  <td v-for="w in windowKeys" :key="w" class="px-3 py-2 text-right tnum">
                    <span
                      v-if="currentLimit(mrow.platform, w) !== mergedLimit(mrow, w)"
                      class="text-accent"
                    >
                      <span class="text-muted/60 line-through">{{ fmtLimit(currentLimit(mrow.platform, w)) }}</span>
                      {{ ' ' }}{{ fmtLimit(mergedLimit(mrow, w)) }}
                    </span>
                    <span v-else class="text-muted">{{ fmtLimit(mergedLimit(mrow, w)) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p v-if="!enforce" class="flex items-start gap-1.5 text-xs text-amber">
          <TriangleAlert :size="13" class="mt-0.5 shrink-0" />
          {{ t('risk.applyDisabledHint') }}
        </p>
      </div>

      <template #footer>
        <Button variant="ghost" :disabled="applying" @click="limitOpen = false">{{ t('common.cancel') }}</Button>
        <Button
          variant="primary"
          :loading="applying"
          :disabled="!enforce || !preview"
          :title="!enforce ? t('risk.applyDisabledHint') : ''"
          @click="doApply"
        >
          {{ t('risk.applyBtn') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>
