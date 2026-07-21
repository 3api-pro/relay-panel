<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, KeyRound, LineChart, ServerCog, UserRound } from 'lucide-vue-next';
import { get, post, put } from '../api/client';
import { session } from '../api/session';
import type { FinanceReportConfig, FinanceReportTestResponse, Me, OperatorRole } from '../api/types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton, toast } from '../components/ui';

/**
 * 设置：修改密码（所有角色，自助账号安全，不受 canWrite 限制）、
 * 账户信息只读、root 额外实例配置摘要（signupMode 等非敏感项 + 告警 webhook 指引）。
 */

const { t } = useI18n();

const isRoot = session.isRoot;

const loading = ref(true);
const loadError = ref('');

onMounted(async () => {
  try {
    await session.ensureLoaded();
    if (!session.state.user) loadError.value = t('settings.loadErrorNoAccount');
  } finally {
    loading.value = false;
  }
  if (isRoot.value) await loadReportConfig();
});

const me = computed<Me | null>(() => session.state.user);

// ---- 展示映射 ----
function roleText(role: OperatorRole | undefined): string {
  return role ? t(`settings.role.${role}`) : '—';
}
function roleTone(role: OperatorRole | undefined): 'accent' | 'default' | 'muted' {
  if (role === 'root') return 'accent';
  if (role === 'viewer') return 'muted';
  return 'default';
}
function signupModeText(mode: Me['signupMode'] | undefined): string {
  return mode ? t(`settings.signupMode.${mode}`) : '—';
}

// ---- 修改密码 ----
const current = ref('');
const next = ref('');
const confirm = ref('');
const submitting = ref(false);

const nextErr = computed(() =>
  next.value !== '' && next.value.length < 8 ? t('settings.pwMinLength') : '',
);
const confirmErr = computed(() =>
  confirm.value !== '' && confirm.value !== next.value ? t('settings.pwMismatch') : '',
);
const canSubmit = computed(
  () =>
    current.value !== '' &&
    next.value.length >= 8 &&
    confirm.value === next.value &&
    !submitting.value,
);

async function submitPassword(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    await post('/api/auth/password', { current: current.value, next: next.value });
    toast.success(t('settings.pwUpdated'));
    current.value = '';
    next.value = '';
    confirm.value = '';
  } catch {
    // client 已弹错误 toast（如原密码不正确）
  } finally {
    submitting.value = false;
  }
}

// ---- 经营报告配置（root · F2）----
const reportLoading = ref(false);
const reportSaving = ref(false);
const reportTesting = ref(false);
const reportPreview = ref('');
const recipients = ref('');
const marginLowPctInput = ref<number | string>(20); // 展示为百分比（0..100），提交转 0..1
const costSpikeFactor = ref<number | string>(1.5);
const reportDaily = ref(true);
const reportWeekly = ref(true);
const recipientsError = ref('');
const thresholdError = ref('');

const REPORT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(): string[] {
  return recipients.value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function loadReportConfig(): Promise<void> {
  reportLoading.value = true;
  try {
    const cfg = await get<FinanceReportConfig>('/api/settings/finance-report', { silent: true });
    recipients.value = (cfg.recipients ?? []).join(', ');
    marginLowPctInput.value = Math.round((cfg.marginLowPct ?? 0.2) * 100);
    costSpikeFactor.value = cfg.costSpikeFactor ?? 1.5;
    reportDaily.value = cfg.daily ?? true;
    reportWeekly.value = cfg.weekly ?? true;
  } catch {
    toast.error(t('settings.report.loadFailed'));
  } finally {
    reportLoading.value = false;
  }
}

async function saveReportConfig(): Promise<void> {
  recipientsError.value = '';
  thresholdError.value = '';
  const list = parseRecipients();
  if (list.some((e) => !REPORT_EMAIL_RE.test(e))) {
    recipientsError.value = t('settings.report.recipientsInvalid');
    return;
  }
  const pct = Number(marginLowPctInput.value);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    thresholdError.value = t('settings.report.marginLowInvalid');
    return;
  }
  const factor = Number(costSpikeFactor.value);
  if (!Number.isFinite(factor) || factor < 1) {
    thresholdError.value = t('settings.report.costSpikeInvalid');
    return;
  }
  reportSaving.value = true;
  try {
    const saved = await put<FinanceReportConfig>('/api/settings/finance-report', {
      recipients: list,
      marginLowPct: pct / 100,
      costSpikeFactor: factor,
      daily: reportDaily.value,
      weekly: reportWeekly.value,
    });
    recipients.value = (saved.recipients ?? []).join(', ');
    toast.success(t('settings.report.saved'));
  } catch {
    // client 已弹错误 toast
  } finally {
    reportSaving.value = false;
  }
}

// 立即发送测试报告：用当前配置渲染日报并直投收件人，验证「能生成 + 能送达」。
// 后端 400（未配置收件人/SMTP）由 client 自动弹出后端中文原因；送达失败(sent=false)在此弹失败 toast。
async function sendTestReport(): Promise<void> {
  reportTesting.value = true;
  try {
    const res = await post<FinanceReportTestResponse>('/api/finance/report/test', {});
    reportPreview.value = res.preview ?? '';
    if (res.sent && res.sentCount >= res.recipients) {
      toast.success(t('settings.report.testSent', { count: res.sentCount }));
    } else if (res.sent) {
      // 部分投递失败：如实提示实际送达/总数，别掩盖 SMTP 送达故障
      toast.error(t('settings.report.testPartial', { sent: res.sentCount, total: res.recipients }));
    } else {
      toast.error(t('settings.report.testFailed'));
    }
  } catch {
    // client 已弹后端 400 原因（未配置收件人/SMTP）
  } finally {
    reportTesting.value = false;
  }
}
</script>

<template>
  <div class="rp-page space-y-5">
    <div v-if="loading" class="rp-panel p-4">
      <Skeleton :lines="3" />
    </div>

    <div v-else-if="loadError" class="rp-panel p-8">
      <EmptyState :title="t('settings.loadFailed')" :description="loadError" />
    </div>

    <div v-else class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <!-- 修改密码 -->
      <Card>
        <template #title>
          <span class="flex items-center gap-2">
            <KeyRound :size="15" class="text-muted" /> {{ t('settings.changePassword') }}
          </span>
        </template>

        <form class="space-y-4" @submit.prevent="submitPassword">
          <Field :label="t('settings.currentPassword')" required>
            <Input v-model="current" type="password" :placeholder="t('settings.currentPasswordPlaceholder')" autocomplete="current-password" />
          </Field>
          <Field :label="t('settings.newPassword')" required :error="nextErr" :hint="t('settings.pwHint')">
            <Input v-model="next" type="password" :placeholder="t('settings.newPasswordPlaceholder')" autocomplete="new-password" />
          </Field>
          <Field :label="t('settings.confirmPassword')" required :error="confirmErr">
            <Input v-model="confirm" type="password" :placeholder="t('settings.confirmPasswordPlaceholder')" autocomplete="new-password" />
          </Field>
          <div class="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p class="text-xs text-muted/80">{{ t('settings.pwNote') }}</p>
            <Button type="submit" variant="primary" :disabled="!canSubmit" :loading="submitting">
              {{ t('settings.updatePassword') }}
            </Button>
          </div>
        </form>
      </Card>

      <div class="space-y-5">
        <!-- 账户信息 -->
        <Card>
          <template #title>
            <span class="flex items-center gap-2">
              <UserRound :size="15" class="text-muted" /> {{ t('settings.accountInfo') }}
            </span>
          </template>

          <dl class="divide-y divide-border/60 text-[13px]">
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">{{ t('settings.email') }}</dt>
              <dd class="min-w-0 truncate font-mono text-xs">{{ me?.email ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">{{ t('settings.displayName') }}</dt>
              <dd class="min-w-0 truncate">{{ me?.displayName || t('settings.notSet') }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">{{ t('settings.roleLabel') }}</dt>
              <dd>
                <Badge :tone="roleTone(me?.role)" size="sm">{{ roleText(me?.role) }}</Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <!-- root：实例配置摘要 -->
        <Card v-if="isRoot">
          <template #title>
            <span class="flex items-center gap-2">
              <ServerCog :size="15" class="text-muted" /> {{ t('settings.instanceConfig') }}
            </span>
          </template>

          <dl class="divide-y divide-border/60 text-[13px]">
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">{{ t('settings.signupModeLabel') }}</dt>
              <dd>
                <Badge tone="default" size="sm">{{ signupModeText(me?.signupMode) }}</Badge>
              </dd>
            </div>
          </dl>

          <RouterLink
            to="/alerts"
            class="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-panel-2/40 px-3 py-2.5 text-xs transition-colors hover:border-border-2 hover:bg-panel-2/70"
          >
            <span class="min-w-0 text-muted">
              {{ t('settings.alertsHint') }}
            </span>
            <ArrowRight :size="14" class="shrink-0 text-accent" />
          </RouterLink>
        </Card>

        <!-- root：经营报告配置（F2） -->
        <Card v-if="isRoot">
          <template #title>
            <span class="flex items-center gap-2">
              <LineChart :size="15" class="text-muted" /> {{ t('settings.report.title') }}
            </span>
          </template>

          <div v-if="reportLoading" class="py-2">
            <Skeleton :lines="3" />
          </div>
          <div v-else class="space-y-4">
            <p class="text-[13px] leading-relaxed text-muted">{{ t('settings.report.desc') }}</p>

            <Field
              :label="t('settings.report.recipientsLabel')"
              :error="recipientsError"
              :hint="t('settings.report.recipientsHint')"
            >
              <Input
                v-model="recipients"
                mono
                placeholder="ops@example.com, finance@example.com"
                :disabled="reportSaving"
                autocomplete="off"
              />
            </Field>

            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                :label="t('settings.report.marginLowLabel')"
                :error="thresholdError"
                :hint="t('settings.report.marginLowHint')"
              >
                <div class="flex items-center gap-1.5">
                  <Input v-model="marginLowPctInput" type="number" :disabled="reportSaving" />
                  <span class="text-xs text-muted">%</span>
                </div>
              </Field>
              <Field :label="t('settings.report.costSpikeLabel')" :hint="t('settings.report.costSpikeHint')">
                <div class="flex items-center gap-1.5">
                  <Input v-model="costSpikeFactor" type="number" :disabled="reportSaving" />
                  <span class="text-xs text-muted">×</span>
                </div>
              </Field>
            </div>

            <div class="flex items-center gap-5 border-t border-border/60 pt-3">
              <label class="flex items-center gap-2 text-[13px] text-text/90">
                <input v-model="reportDaily" type="checkbox" class="accent-accent" :disabled="reportSaving" />
                {{ t('settings.report.dailyLabel') }}
              </label>
              <label class="flex items-center gap-2 text-[13px] text-text/90">
                <input v-model="reportWeekly" type="checkbox" class="accent-accent" :disabled="reportSaving" />
                {{ t('settings.report.weeklyLabel') }}
              </label>
            </div>

            <p class="text-xs text-muted/80">
              {{ t('settings.report.usdNote') }} · {{ t('settings.report.noResolveNote') }}
            </p>

            <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
              <Button
                variant="outline"
                :loading="reportTesting"
                :disabled="reportSaving"
                :title="t('settings.report.sendTestHint')"
                @click="sendTestReport"
              >
                {{ t('settings.report.sendTest') }}
              </Button>
              <Button variant="primary" :loading="reportSaving" :disabled="reportTesting" @click="saveReportConfig">
                {{ t('settings.report.save') }}
              </Button>
            </div>

            <div v-if="reportPreview" class="space-y-1.5">
              <p class="text-xs font-medium text-muted">{{ t('settings.report.previewTitle') }}</p>
              <pre class="max-h-64 overflow-auto rounded-lg border border-border bg-panel-2/40 p-3 text-[11px] leading-relaxed text-text/90 whitespace-pre-wrap">{{ reportPreview }}</pre>
            </div>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>
