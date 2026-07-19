<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import QRCode from 'qrcode';
import { AlertTriangle, Check, CreditCard, ExternalLink, Plus, QrCode, Wallet } from 'lucide-vue-next';
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
import { findRenewTarget } from './billing-renew';

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
type SubscriptionPhase = 'active' | 'grace' | 'expired' | 'none';
interface SubscriptionSummary {
  plan: { key: string; title: string; priceMonthly: number; siteQuota: number | null } | null;
  periodEnd: string | null;
  quota: number | null;
  usedSites: number;
  /** 订阅阶段（生命周期）：有效 / 宽限期 / 已过期 / 无 */
  phase?: SubscriptionPhase;
  currentPeriodEnd?: string | null;
  graceEndsAt?: string | null;
  daysRemaining?: number | null;
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
interface PaymentMethod {
  key: string;
  name: string;
  paymentMode: string;
}
interface OrderView {
  orderNo: string;
  planKey: string;
  months: number;
  amount: number;
  providerKey: string;
  status: string;
  payUrl: string | null;
  qrCode: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  operatorEmail?: string;
}
interface ProviderView {
  key: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  paymentMode: string;
  configKeys: string[];
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
    void loadMethods();
    void loadMyOrders();
    if (isRoot.value) {
      void loadSubscriptions();
      void loadProviders();
    }
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

// ---- 自助购买（operator）----
const methods = ref<PaymentMethod[]>([]);
const myOrders = ref<OrderView[]>([]);
const showBuy = ref(false);
const buyPlan = ref<BillingPlan | null>(null);
const buyMonths = ref<number | string>(1);
const buyMethod = ref<string | number>('');
const buySubmitting = ref(false);
const activeOrder = ref<OrderView | null>(null);
const qrDataUrl = ref('');
let pollTimer: number | null = null;

const buyMonthsNum = computed(() => Number(buyMonths.value));
const buyMonthsValid = computed(
  () => Number.isInteger(buyMonthsNum.value) && buyMonthsNum.value >= 1 && buyMonthsNum.value <= 120,
);
const buyTotal = computed(() => {
  if (!buyPlan.value || !buyMonthsValid.value) return null;
  return Math.round(buyPlan.value.priceMonthly * buyMonthsNum.value * 100) / 100;
});
const canSubmitBuy = computed(() => buyPlan.value !== null && buyMethod.value !== '' && buyMonthsValid.value);
const methodOptions = computed<SelectOption[]>(() => methods.value.map((m) => ({ value: m.key, label: m.name })));
/** 自助购买入口：operator（root/viewer 不限额，无购买语义） */
const selfServe = computed(() => canWrite?.value === true && !isRoot.value);

// ---- 订阅生命周期：阶段徽章 / 到期倒计时 / 立即续费引导 ----
const phase = computed<SubscriptionPhase>(() => sub.value?.phase ?? 'none');
const lifecycleDays = computed(() => sub.value?.daysRemaining ?? null);
const graceEndsAt = computed(() => sub.value?.graceEndsAt ?? null);
/** free/无订阅不显示阶段徽章（避免对免费用户造成「已过期」误读） */
const showPhaseBadge = computed(() => phase.value !== 'none');
const phaseTone = computed<'green' | 'amber' | 'red' | 'muted'>(() => {
  switch (phase.value) {
    case 'active':
      return 'green';
    case 'grace':
      return 'amber';
    case 'expired':
      return 'red';
    default:
      return 'muted';
  }
});
const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'active':
      return t('billing.statusActive');
    case 'grace':
      return t('billing.statusGrace');
    case 'expired':
      return t('billing.statusExpired');
    default:
      return t('billing.statusNone');
  }
});
/** 生命周期提示条文案：宽限/已过期/临近到期(<=7天) 各一句，其余为空 */
const lifecycleNote = computed(() => {
  const n = lifecycleDays.value;
  if (phase.value === 'grace') {
    return t('billing.graceBanner', { n: n ?? 0, date: fmtDate(graceEndsAt.value) });
  }
  if (phase.value === 'expired') return t('billing.expiredBanner');
  if (phase.value === 'active' && n !== null && n <= 7) return t('billing.expiringSoon', { n });
  return '';
});
/** 突出「立即续费」：宽限/已过期，或临近到期(<=7天)；仅自助购买的 operator 可见引导 */
const renewSuggested = computed(() => {
  if (!selfServe.value) return false;
  if (phase.value === 'grace' || phase.value === 'expired') return true;
  return phase.value === 'active' && lifecycleDays.value !== null && lifecycleDays.value <= 7;
});
/** 下方套餐区容器（过期态续费回退：无当前付费套餐时滚动至此引导选购） */
const plansSection = ref<HTMLElement | null>(null);
/**
 * 立即续费：定位当前付费套餐并打开购买弹窗。
 * expired 阶段后端把 plan 回落为 free（priceMonthly=0），定位不到付费套餐——
 * 此时滚动至下方套餐区引导选购，而非静默无反应（否则最需续费的用户点了没反应）。
 */
function renewNow(): void {
  const target = findRenewTarget(sub.value?.plan?.key, plans.value);
  if (target) {
    openBuy(target);
    return;
  }
  plansSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadMethods(): Promise<void> {
  try {
    const r = await get<{ methods: PaymentMethod[] }>('/api/billing/payment-methods', { silent: true });
    methods.value = Array.isArray(r?.methods) ? r.methods : [];
  } catch {
    methods.value = [];
  }
}

async function loadMyOrders(): Promise<void> {
  try {
    const r = await get<{ orders: OrderView[] }>('/api/billing/orders', { silent: true });
    myOrders.value = Array.isArray(r?.orders) ? r.orders : [];
  } catch {
    myOrders.value = [];
  }
}

function openBuy(p: BillingPlan): void {
  buyPlan.value = p;
  buyMonths.value = 1;
  buyMethod.value = methods.value[0]?.key ?? '';
  showBuy.value = true;
}

async function submitBuy(): Promise<void> {
  if (!canSubmitBuy.value || !buyPlan.value) return;
  buySubmitting.value = true;
  try {
    const r = await post<{ order: OrderView }>('/api/billing/checkout', {
      planKey: buyPlan.value.key,
      months: buyMonthsNum.value,
      providerKey: buyMethod.value,
    });
    showBuy.value = false;
    activeOrder.value = r.order;
  } catch {
    // client 已弹错误 toast
  } finally {
    buySubmitting.value = false;
  }
}

// 支付弹窗：二维码渲染 + 3s 轮询
watch(activeOrder, async (order) => {
  stopPolling();
  qrDataUrl.value = '';
  if (!order) return;
  if (order.qrCode) {
    try {
      qrDataUrl.value = await QRCode.toDataURL(order.qrCode, { width: 220, margin: 1 });
    } catch {
      qrDataUrl.value = '';
    }
  }
  if (order.status === 'pending') startPolling(order.orderNo);
});

function startPolling(orderNo: string): void {
  pollTimer = window.setInterval(() => void pollOrder(orderNo), 3000);
}
function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOrder(orderNo: string): Promise<void> {
  try {
    const r = await get<{ order: OrderView }>(`/api/billing/orders/${orderNo}`, { silent: true });
    if (activeOrder.value?.orderNo !== orderNo) return;
    const prevQr = activeOrder.value.qrCode;
    activeOrder.value = { ...r.order, qrCode: prevQr ?? r.order.qrCode };
    if (r.order.status !== 'pending') {
      stopPolling();
      if (r.order.status === 'completed') {
        toast.success(t('billing.paySuccess'));
        await Promise.all([loadCore(), loadMyOrders()]);
      }
    }
  } catch {
    // 轮询失败下轮重试
  }
}

async function cancelActiveOrder(): Promise<void> {
  const order = activeOrder.value;
  if (!order) return;
  try {
    await post(`/api/billing/orders/${order.orderNo}/cancel`);
  } catch {
    // client 已弹错误 toast
  }
  closePayModal();
  void loadMyOrders();
}

function closePayModal(): void {
  stopPolling();
  activeOrder.value = null;
}

onBeforeUnmount(stopPolling);

const orderColumns = computed<TableColumn[]>(() => [
  { key: 'orderNo', label: t('billing.colOrderNo'), mono: true },
  { key: 'planKey', label: t('billing.plan') },
  { key: 'months', label: t('billing.durationMonths'), align: 'right', width: '80px' },
  { key: 'amount', label: t('billing.colAmount'), align: 'right', width: '100px' },
  { key: 'providerKey', label: t('billing.colProvider'), width: '110px' },
  { key: 'status', label: t('billing.colStatus'), width: '110px' },
  { key: 'createdAt', label: t('billing.colCreated'), align: 'right', width: '120px' },
]);
const orderRows = computed<Record<string, unknown>[]>(() => myOrders.value as unknown as Record<string, unknown>[]);
function asOrder(r: Record<string, unknown>): OrderView {
  return r as unknown as OrderView;
}
function methodName(key: string): string {
  return methods.value.find((m) => m.key === key)?.name ?? key;
}
function orderStatusText(s: string): string {
  const known = ['pending', 'paid', 'completed', 'expired', 'failed', 'cancelled'];
  return known.includes(s) ? t(`billing.orderStatus.${s}`) : s;
}

// ---- root：收款渠道配置 ----
const providers = ref<ProviderView[]>([]);
const showProvider = ref(false);
const pKey = ref<string | number>('alipay');
const pName = ref('');
const pMode = ref<string | number>('');
const pEnabled = ref(true);
const pConfigText = ref('');
const pSubmitting = ref(false);

const PROVIDER_KEYS: Record<string, string[]> = {
  alipay: ['appId', 'privateKey', 'alipayPublicKey', 'notifyUrl'],
  wxpay: ['appId', 'mchId', 'privateKey', 'apiV3Key', 'certSerial', 'notifyUrl'],
  usdt: ['apiKey', 'appId', 'webhookSecret'],
};
const providerKeyOptions: SelectOption[] = [
  { value: 'alipay', label: 'Alipay' },
  { value: 'wxpay', label: 'WeChat Pay' },
  { value: 'usdt', label: 'USDT' },
];
const providerModeOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('billing.modeQr') },
  { value: 'redirect', label: t('billing.modeRedirect') },
]);
const pRequiredKeys = computed(() => PROVIDER_KEYS[String(pKey.value)] ?? []);
const existingProvider = computed(() => providers.value.find((p) => p.key === String(pKey.value)) ?? null);

async function loadProviders(): Promise<void> {
  try {
    const r = await get<{ providers: ProviderView[] }>('/api/billing/providers', { silent: true });
    providers.value = Array.isArray(r?.providers) ? r.providers : [];
  } catch {
    providers.value = [];
  }
}

function openProvider(key?: string): void {
  const existing = key !== undefined ? providers.value.find((p) => p.key === key) : undefined;
  pKey.value = existing?.key ?? 'alipay';
  pName.value = existing?.name ?? '';
  pMode.value = existing?.paymentMode ?? '';
  pEnabled.value = existing?.enabled ?? true;
  pConfigText.value = '';
  showProvider.value = true;
}

async function submitProvider(): Promise<void> {
  let config: Record<string, string> | undefined;
  if (pConfigText.value.trim() !== '') {
    try {
      const parsed = JSON.parse(pConfigText.value) as Record<string, unknown>;
      config = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      toast.error(t('billing.providerConfigInvalid'));
      return;
    }
  }
  pSubmitting.value = true;
  try {
    await post('/api/billing/providers', {
      key: pKey.value,
      name: pName.value.trim() || String(pKey.value),
      enabled: pEnabled.value,
      sortOrder: existingProvider.value?.sortOrder ?? providers.value.length,
      paymentMode: pMode.value,
      ...(config !== undefined ? { config } : {}),
    });
    toast.success(t('billing.providerSaved'));
    showProvider.value = false;
    await Promise.all([loadProviders(), loadMethods()]);
  } catch {
    // client 已弹错误 toast
  } finally {
    pSubmitting.value = false;
  }
}

async function removeProvider(key: string): Promise<void> {
  try {
    await del(`/api/billing/providers/${key}`);
    toast.success(t('billing.providerDeleted'));
    await Promise.all([loadProviders(), loadMethods()]);
  } catch {
    // client 已弹错误 toast
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
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-lg border border-accent/25 bg-accent/10 p-1.5 text-accent">
              <CreditCard :size="16" />
            </span>
            <h3 class="truncate text-lg font-semibold">{{ planTitleDisplay }}</h3>
            <Badge tone="accent" size="sm">{{ t('billing.current') }}</Badge>
            <Badge v-if="showPhaseBadge" :tone="phaseTone" size="sm">{{ phaseLabel }}</Badge>
          </div>
          <p class="mt-1.5 text-xs text-muted">{{ priceDisplay }} · {{ t('billing.expires') }} {{ expiryDisplay }}</p>
          <div
            v-if="lifecycleNote"
            class="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed"
            :class="
              phase === 'expired'
                ? 'border-red/30 bg-red/10 text-red'
                : phase === 'grace'
                  ? 'border-amber/30 bg-amber/10 text-amber'
                  : 'border-border bg-panel-2/50 text-muted'
            "
          >
            <AlertTriangle :size="14" class="shrink-0" />
            <span class="min-w-0">{{ lifecycleNote }}</span>
            <Button v-if="renewSuggested" size="sm" variant="primary" class="ml-auto shrink-0" @click="renewNow">
              <Wallet :size="13" /> {{ t('billing.renewNow') }}
            </Button>
          </div>
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
    <section ref="plansSection">
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

          <div v-if="selfServe && p.priceMonthly > 0" class="mt-auto pt-4">
            <Button
              block
              :variant="isCurrentPlan(p.key) ? 'outline' : 'primary'"
              :disabled="methods.length === 0"
              @click="openBuy(p)"
            >
              <Wallet :size="14" />
              {{ isCurrentPlan(p.key) ? t('billing.renew') : t('billing.buy') }}
            </Button>
            <p v-if="methods.length === 0" class="mt-1.5 text-center text-[11px] text-muted/80">
              {{ t('billing.noPayMethods') }}
            </p>
          </div>
        </article>
      </div>
    </section>

    <!-- 我的订单 -->
    <Card v-if="selfServe && myOrders.length > 0" :padded="false">
      <template #title>{{ t('billing.myOrders') }}</template>
      <Table :columns="orderColumns" :rows="orderRows" row-key="orderNo" :empty="t('billing.noOrders')">
        <template #cell-planKey="{ row }">{{ planTitle(String(row.planKey)) }}</template>
        <template #cell-amount="{ row }">
          <span class="tnum">¥{{ asOrder(row).amount.toFixed(2) }}</span>
        </template>
        <template #cell-providerKey="{ row }">{{ methodName(String(row.providerKey)) }}</template>
        <template #cell-status="{ row }">
          <Badge
            :tone="
              asOrder(row).status === 'completed'
                ? 'green'
                : asOrder(row).status === 'pending'
                  ? 'amber'
                  : 'muted'
            "
            size="sm"
          >
            {{ orderStatusText(asOrder(row).status) }}
          </Badge>
        </template>
        <template #cell-createdAt="{ row }">{{ fmtDate(asOrder(row).createdAt) }}</template>
      </Table>
    </Card>

    <!-- root：收款渠道 -->
    <Card v-if="isRoot" :padded="false">
      <template #title>{{ t('billing.providersSection') }}</template>
      <template #actions>
        <Button v-if="canWrite" size="sm" variant="primary" @click="openProvider()">
          <Plus :size="14" /> {{ t('billing.addProvider') }}
        </Button>
      </template>
      <div v-if="providers.length === 0" class="p-8">
        <EmptyState :title="t('billing.noProviders')" :description="t('billing.noProvidersDesc')" />
      </div>
      <div v-else class="divide-y divide-border/60">
        <div v-for="p in providers" :key="p.key" class="flex items-center justify-between gap-3 px-4 py-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-medium">{{ p.name }}</span>
              <Badge tone="muted" size="sm" mono>{{ p.key }}</Badge>
              <Badge :tone="p.enabled ? 'green' : 'muted'" size="sm">
                {{ p.enabled ? t('billing.providerEnabled') : t('billing.providerDisabled') }}
              </Badge>
            </div>
            <p class="mt-1 truncate text-[11px] text-muted/80">
              {{ t('billing.configuredKeys') }}: {{ p.configKeys.length > 0 ? p.configKeys.join(', ') : '—' }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button v-if="canWrite" size="sm" variant="ghost" @click="openProvider(p.key)">
              {{ t('common.edit') }}
            </Button>
            <Button v-if="canWrite" size="sm" variant="ghost" @click="removeProvider(p.key)">
              {{ t('common.delete') }}
            </Button>
          </div>
        </div>
      </div>
    </Card>

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

    <!-- 购买 Modal -->
    <Modal v-model:open="showBuy" :title="t('billing.buyModalTitle', { plan: buyPlan?.title ?? '' })" width="460px">
      <div class="space-y-4">
        <Field :label="t('billing.durationMonths')" required :hint="t('billing.durationHint')">
          <Input v-model="buyMonths" type="number" placeholder="1" autofocus />
        </Field>
        <Field :label="t('billing.payMethod')" required>
          <Select v-model="buyMethod" :options="methodOptions" :placeholder="t('billing.selectPayMethod')" />
        </Field>
        <div class="flex items-baseline justify-between rounded-lg border border-border bg-panel-2/50 px-3 py-2.5">
          <span class="text-xs text-muted">{{ t('billing.totalAmount') }}</span>
          <span class="tnum text-lg font-semibold">{{ buyTotal !== null ? `¥${buyTotal.toFixed(2)}` : '—' }}</span>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="buySubmitting" @click="showBuy = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!canSubmitBuy" :loading="buySubmitting" @click="submitBuy">
          {{ t('billing.createOrder') }}
        </Button>
      </template>
    </Modal>

    <!-- 支付 Modal（二维码 / 跳转 + 轮询） -->
    <Modal
      :open="activeOrder !== null"
      :title="t('billing.payModalTitle')"
      width="400px"
      @update:open="(v: boolean) => { if (!v) closePayModal(); }"
    >
      <div v-if="activeOrder" class="space-y-4 text-center">
        <p class="text-xs text-muted">
          <span class="font-mono">{{ activeOrder.orderNo }}</span>
          · {{ planTitle(activeOrder.planKey) }} × {{ activeOrder.months }}
        </p>
        <p class="tnum text-2xl font-semibold">¥{{ activeOrder.amount.toFixed(2) }}</p>

        <template v-if="activeOrder.status === 'pending'">
          <div v-if="qrDataUrl" class="flex flex-col items-center gap-2">
            <img :src="qrDataUrl" alt="QR" class="rounded-xl border border-border bg-white p-2" width="220" height="220" />
            <p class="flex items-center gap-1.5 text-xs text-muted">
              <QrCode :size="13" /> {{ t('billing.scanToPay', { method: methodName(activeOrder.providerKey) }) }}
            </p>
          </div>
          <div v-else-if="activeOrder.payUrl" class="py-2">
            <a :href="activeOrder.payUrl" target="_blank" rel="noopener">
              <Button variant="primary" block>
                <ExternalLink :size="14" /> {{ t('billing.openPayPage') }}
              </Button>
            </a>
            <p class="mt-2 text-xs text-muted">{{ t('billing.payPageNote') }}</p>
          </div>
          <p class="text-[11px] text-muted/80">{{ t('billing.waitingPayment') }}</p>
        </template>

        <div v-else-if="activeOrder.status === 'completed'" class="py-3">
          <p class="flex items-center justify-center gap-1.5 text-sm font-medium text-green">
            <Check :size="16" /> {{ t('billing.paySuccess') }}
          </p>
        </div>

        <div v-else class="py-3">
          <p class="text-sm text-muted">{{ orderStatusText(activeOrder.status) }}</p>
        </div>
      </div>
      <template #footer>
        <Button
          v-if="activeOrder?.status === 'pending'"
          variant="ghost"
          @click="cancelActiveOrder"
        >
          {{ t('billing.cancelOrder') }}
        </Button>
        <Button variant="outline" @click="closePayModal">{{ t('common.close') }}</Button>
      </template>
    </Modal>

    <!-- 收款渠道 Modal（root） -->
    <Modal v-model:open="showProvider" :title="t('billing.providerModalTitle')" width="520px">
      <div class="space-y-4">
        <Field :label="t('billing.providerKey')" required>
          <Select v-model="pKey" :options="providerKeyOptions" />
        </Field>
        <Field :label="t('billing.providerName')" required>
          <Input v-model="pName" :placeholder="String(pKey)" />
        </Field>
        <Field :label="t('billing.providerMode')">
          <Select v-model="pMode" :options="providerModeOptions" />
        </Field>
        <Field
          :label="t('billing.providerConfig')"
          :hint="t('billing.providerConfigHint', { keys: pRequiredKeys.join(', ') })"
          :required="existingProvider === null"
        >
          <textarea
            v-model="pConfigText"
            rows="6"
            class="w-full rounded-lg border border-border bg-panel-2/50 px-3 py-2 font-mono text-xs outline-none focus:border-accent/60"
            :placeholder="existingProvider !== null ? t('billing.providerConfigKeep') : `{\n  &quot;${pRequiredKeys[0] ?? 'key'}&quot;: &quot;...&quot;\n}`"
          ></textarea>
        </Field>
        <label class="flex items-center gap-2 text-xs text-muted">
          <input v-model="pEnabled" type="checkbox" class="accent-[var(--color-accent)]" />
          {{ t('billing.providerEnabled') }}
        </label>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="pSubmitting" @click="showProvider = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="pSubmitting" @click="submitProvider">{{ t('common.save') }}</Button>
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
