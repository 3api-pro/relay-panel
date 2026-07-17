<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, KeyRound, ServerCog, UserRound } from 'lucide-vue-next';
import { post } from '../api/client';
import { session } from '../api/session';
import type { Me, OperatorRole } from '../api/types';
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
      </div>
    </div>
  </div>
</template>
