<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CreditCard, Plus } from 'lucide-vue-next';
import { del, get, post } from '../api/client';
import { session } from '../api/session';
import {
  Badge,
  Button,
  Card,
  ConfirmDanger,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  StatusDot,
  Table,
  toast,
} from '../components/ui';
import type { SelectOption, TableColumn } from '../components/ui';

/**
 * 计费：我的套餐（当前档 + 到期 + 站点配额进度）、套餐档位卡片网格，
 * root 额外「订阅管理」表（开通/续费 Modal、取消 ConfirmDanger）。
 * 数据源 GET /api/billing/subscription、/plans；root 追加 /subscriptions。
 */

// ---- 视图专属类型（仅本视图使用，就地定义，不改共享 types.ts）----
interface BillingPlan {
  key: string;
  title: string;
  priceMonthly: number;
  siteQuota: number | null;
  features?: string[];
}
interface PlansResponse {
  plans: BillingPlan[];
}
interface SubscriptionSummary {
  plan: { key: string; title: string; priceMonthly: number; siteQuota: number | null } | null;
  periodEnd: string | null;
  quota: number | null;
  usedSites: number;
}
interface SubscriptionRow {
  id: number;
  operatorId: number;
  operatorEmail: string;
  planKey: string;
  status: string;
  currentPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}
interface SubscriptionsResponse {
  subscriptions: SubscriptionRow[];
}

const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite');
const isRoot = session.isRoot;

const sub = ref<SubscriptionSummary | null>(null);
const plans = ref<BillingPlan[]>([]);
const subscriptions = ref<SubscriptionRow[]>([]);

const loading = ref(true);
const loadError = ref('');
const subsLoading = ref(false);
const subsError = ref('');

// ---- 数据加载 ----
async function loadCore(): Promise<void> {
  const [s, p] = await Promise.all([
    get<SubscriptionSummary>('/api/billing/subscription', { silent: true }),
    get<PlansResponse>('/api/billing/plans', { silent: true }),
  ]);
  sub.value = s;
  plans.value = Array.isArray(p?.plans) ? p.plans : [];
}

async function loadSubscriptions(): Promise<void> {
  subsLoading.value = true;
  subsError.value = '';
  try {
    const r = await get<SubscriptionsResponse>('/api/billing/subscriptions', { silent: true });
    subscriptions.value = Array.isArray(r?.subscriptions) ? r.subscriptions : [];
  } catch (err) {
    subsError.value = err instanceof Error ? err.message : t('billing.loadFailed');
  } finally {
    subsLoading.value = false;
  }
}

async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true;
  loadError.value = '';
  try {
    await loadCore();
    if (isRoot.value) void loadSubscriptions();
  } catch (err) {
    if (initial) loadError.value = err instanceof Error ? err.message : t('billing.loadFailed');
  } finally {
    loading.value = false;
  }
}

onMounted(() => void refresh(true));

// ---- 格式化 ----
function toMs(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = toMs(iso);
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function daysLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = toMs(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}
function priceText(p: number | null | undefined): string {
  if (p === null || p === undefined || p <= 0) return t('billing.free');
  return t('billing.pricePerMonth', { price: p.toLocaleString('en-US') });
}
function quotaText(q: number | null | undefined): string {
  return q === null || q === undefined ? t('billing.unlimited') : String(q);
}
function planTitle(key: string): string {
  return plans.value.find((p) => p.key === key)?.title ?? key;
}

// ---- 我的套餐派生 ----
const planTitleDisplay = computed(() => sub.value?.plan?.title ?? t('billing.freePlan'));
const priceDisplay = computed(() => priceText(sub.value?.plan?.priceMonthly ?? 0));
const expiryDisplay = computed(() => {
  const end = sub.value?.periodEnd ?? null;
  if (!end) return t('billing.permanent');
  const left = daysLeft(end);
  if (left === null) return fmtDate(end);
  if (left < 0) return t('billing.expiredOn', { date: fmtDate(end) });
  return t('billing.expiresIn', { date: fmtDate(end), n: left });
});
const usedSites = computed(() => sub.value?.usedSites ?? 0);
const quota = computed(() => sub.value?.quota ?? null);
const quotaRatio = computed(() => {
  const q = quota.value;
  if (q === null || q <= 0) return 0;
  return Math.min(1, usedSites.value / q);
});
const barWidth = computed(() => (quota.value === null ? '100%' : `${Math.round(quotaRatio.value * 100)}%`));
const barColor = computed(() => {
  if (quota.value === null) return 'bg-accent/35';
  if (quotaRatio.value >= 1) return 'bg-red';
  if (quotaRatio.value >= 0.8) return 'bg-amber';
  return 'bg-accent';
});

// ---- 套餐档位 ----
function isCurrentPlan(key: string): boolean {
  return sub.value?.plan?.key === key;
}

// ---- root：订阅管理 ----
const subColumns = computed<TableColumn[]>(() => [
  { key: 'operatorEmail', label: t('billing.colOperatorEmail') },
  { key: 'planKey', label: t('billing.plan') },
  { key: 'status', label: t('billing.colStatus'), width: '110px' },
  { key: 'currentPeriodEnd', label: t('billing.expires'), align: 'right', width: '190px' },
  { key: 'createdAt', label: t('billing.colCreated'), align: 'right', width: '120px' },
  { key: 'actions', label: '', align: 'right', width: '80px' },
]);
const subRows = computed<Record<string, unknown>[]>(
  () => subscriptions.value as unknown as Record<string, unknown>[],
);
function asRow(r: Record<string, unknown>): SubscriptionRow {
  return r as unknown as SubscriptionRow;
}

// 开通/续费 Modal
const showGrant = ref(false);
const grantEmail = ref('');
const grantPlanKey = ref<string | number>('');
const grantMonths = ref<number | string>(1);
const submitting = ref(false);

const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((p) => ({ value: p.key, label: `${p.title} · ${priceText(p.priceMonthly)}` })),
);
const monthsNum = computed(() => Number(grantMonths.value));
const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(grantEmail.value.trim()));
const monthsValid = computed(
  () => Number.isInteger(monthsNum.value) && monthsNum.value >= 1 && monthsNum.value <= 120,
);
const canSubmitGrant = computed(
  () => emailValid.value && grantPlanKey.value !== '' && monthsValid.value,
);

function openGrant(): void {
  grantEmail.value = '';
  grantPlanKey.value = plans.value[0]?.key ?? '';
  grantMonths.value = 1;
  showGrant.value = true;
}

async function submitGrant(): Promise<void> {
  if (!canSubmitGrant.value) return;
  submitting.value = true;
  try {
    await post('/api/billing/subscriptions', {
      operatorEmail: grantEmail.value.trim(),
      planKey: grantPlanKey.value,
      months: monthsNum.value,
    });
    toast.success(t('billing.grantSuccess'));
    showGrant.value = false;
    await Promise.all([loadCore(), loadSubscriptions()]);
  } catch {
    // client 已弹错误 toast
  } finally {
    submitting.value = false;
  }
}

// 取消订阅
const cancelTarget = ref<SubscriptionRow | null>(null);
const cancelling = ref(false);

function askCancel(row: SubscriptionRow): void {
  cancelTarget.value = row;
}
function closeCancel(v: boolean): void {
  if (!v) cancelTarget.value = null;
}
async function doCancel(): Promise<void> {
  const target = cancelTarget.value;
  if (!target) return;
  cancelling.value = true;
  try {
    await del(`/api/billing/subscriptions/${target.id}`);
    toast.success(t('billing.cancelSuccess'));
    cancelTarget.value = null;
    await Promise.all([loadCore(), loadSubscriptions()]);
  } catch {
    // client 已弹错误 toast
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 我的套餐 -->
    <section class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 class="text-[13px] font-semibold">{{ t('billing.myPlan') }}</h2>
      </header>

      <div v-if="loading" class="p-4">
        <Skeleton :lines="2" />
      </div>

      <div v-else-if="loadError" class="p-8">
        <EmptyState :title="t('billing.loadFailed')" :description="loadError" />
      </div>

      <div v-else class="flex flex-col gap-5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="rounded-lg border border-accent/25 bg-accent/10 p-1.5 text-accent">
              <CreditCard :size="16" />
            </span>
            <h3 class="truncate text-lg font-semibold">{{ planTitleDisplay }}</h3>
            <Badge tone="accent" size="sm">{{ t('billing.current') }}</Badge>
          </div>
          <p class="mt-1.5 text-xs text-muted">{{ priceDisplay }} · {{ t('billing.expires') }} {{ expiryDisplay }}</p>
        </div>

        <div class="w-full sm:w-64">
          <div class="flex items-baseline justify-between">
            <span class="rp-microlabel">{{ t('billing.siteQuota') }}</span>
            <span class="tnum text-[13px] font-medium">{{ usedSites }} / {{ quotaText(quota) }}</span>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-panel-2">
            <div class="h-full rounded-full transition-all duration-300" :class="barColor" :style="{ width: barWidth }" />
          </div>
          <p class="mt-1.5 text-[11px] text-muted/80">
            {{ quota === null ? t('billing.unlimitedSitesNote') : t('billing.usedOfQuota', { used: usedSites, quota }) }}
          </p>
        </div>
      </div>
    </section>

    <!-- 套餐档位 -->
    <section>
      <p class="rp-microlabel mb-3">{{ t('billing.plansSection') }}</p>

      <div v-if="loading" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div v-for="i in 3" :key="i" class="rp-panel p-4">
          <Skeleton :lines="4" />
        </div>
      </div>

      <div v-else-if="loadError" class="rp-panel p-8">
        <EmptyState :title="t('billing.loadFailed')" :description="loadError" />
      </div>

      <div v-else-if="plans.length === 0" class="rp-panel p-8">
        <EmptyState :title="t('billing.noPlans')" :description="t('billing.noPlansDesc')" />
      </div>

      <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="p in plans"
          :key="p.key"
          class="rp-panel flex flex-col p-4"
          :class="isCurrentPlan(p.key) ? 'border-accent/50 shadow-[0_0_0_1px_rgb(109_139_255/0.25)]' : ''"
        >
          <div class="flex items-start justify-between gap-2">
            <h3 class="truncate text-sm font-semibold">{{ p.title }}</h3>
            <Badge v-if="isCurrentPlan(p.key)" tone="accent" size="sm">{{ t('billing.current') }}</Badge>
          </div>

          <p class="mt-2 flex items-baseline gap-1">
            <span class="tnum text-2xl font-semibold tracking-tight">{{ priceText(p.priceMonthly) }}</span>
          </p>

          <p class="mt-1 text-xs text-muted">
            {{ t('billing.siteQuota') }} · <span class="text-text/80">{{ quotaText(p.siteQuota) }}</span>
          </p>

          <ul v-if="p.features && p.features.length > 0" class="mt-3 space-y-1.5 border-t border-border/60 pt-3">
            <li v-for="(f, i) in p.features" :key="i" class="flex items-start gap-1.5 text-xs text-muted">
              <Check :size="13" class="mt-0.5 shrink-0 text-green" />
              <span class="min-w-0">{{ f }}</span>
            </li>
          </ul>
        </article>
      </div>
    </section>

    <!-- root：订阅管理 -->
    <Card v-if="isRoot" :padded="false">
      <template #title>{{ t('billing.subscriptions') }}</template>
      <template #actions>
        <Button v-if="canWrite" size="sm" variant="primary" @click="openGrant">
          <Plus :size="14" /> {{ t('billing.grantRenew') }}
        </Button>
      </template>

      <div v-if="subsError" class="p-8">
        <EmptyState :title="t('billing.loadFailed')" :description="subsError" />
      </div>
      <Table
        v-else
        :columns="subColumns"
        :rows="subRows"
        row-key="id"
        :loading="subsLoading"
        :empty="t('billing.noSubscriptions')"
      >
        <template #cell-planKey="{ row }">
          {{ planTitle(String(row.planKey)) }}
        </template>
        <template #cell-status="{ row }">
          <StatusDot :status="String(row.status)" />
        </template>
        <template #cell-currentPeriodEnd="{ row }">
          {{ fmtDate(asRow(row).currentPeriodEnd) }}
        </template>
        <template #cell-createdAt="{ row }">
          {{ fmtDate(asRow(row).createdAt) }}
        </template>
        <template #cell-actions="{ row }">
          <Button
            v-if="canWrite && asRow(row).status === 'active'"
            size="sm"
            variant="ghost"
            @click="askCancel(asRow(row))"
          >
            {{ t('common.cancel') }}
          </Button>
        </template>
      </Table>
    </Card>

    <!-- 开通/续费 Modal -->
    <Modal v-model:open="showGrant" :title="t('billing.grantModalTitle')" width="460px">
      <div class="space-y-4">
        <Field :label="t('billing.colOperatorEmail')" required :hint="t('billing.operatorEmailHint')">
          <Input v-model="grantEmail" type="email" placeholder="operator@example.com" autofocus />
        </Field>
        <Field :label="t('billing.plan')" required>
          <Select v-model="grantPlanKey" :options="planOptions" :placeholder="t('billing.selectPlan')" />
        </Field>
        <Field :label="t('billing.durationMonths')" required :hint="t('billing.durationHint')">
          <Input v-model="grantMonths" type="number" placeholder="1" />
        </Field>
        <p class="rounded-lg border border-border bg-panel-2/50 px-3 py-2 text-xs leading-relaxed text-muted">
          {{ t('billing.grantNote') }}
        </p>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="submitting" @click="showGrant = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!canSubmitGrant" :loading="submitting" @click="submitGrant">
          {{ t('billing.confirmGrant') }}
        </Button>
      </template>
    </Modal>

    <!-- 取消订阅确认 -->
    <ConfirmDanger
      :open="cancelTarget !== null"
      :title="t('billing.cancelTitle')"
      :confirm-text="cancelTarget?.operatorEmail ?? ''"
      :message="t('billing.cancelMessage', { email: cancelTarget?.operatorEmail ?? '', plan: planTitle(cancelTarget?.planKey ?? '') })"
      :action-label="t('billing.cancelAction')"
      :loading="cancelling"
      @update:open="closeCancel"
      @confirm="doCancel"
    />
  </div>
</template>
