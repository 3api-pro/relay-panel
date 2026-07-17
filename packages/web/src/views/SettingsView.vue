<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowRight, KeyRound, ServerCog, UserRound } from 'lucide-vue-next';
import { post } from '../api/client';
import { session } from '../api/session';
import type { Me, OperatorRole } from '../api/types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton, toast } from '../components/ui';

/**
 * 设置：修改密码（所有角色，自助账号安全，不受 canWrite 限制）、
 * 账户信息只读、root 额外实例配置摘要（signupMode 等非敏感项 + 告警 webhook 指引）。
 */

const isRoot = session.isRoot;

const loading = ref(true);
const loadError = ref('');

onMounted(async () => {
  try {
    await session.ensureLoaded();
    if (!session.state.user) loadError.value = '无法获取账户信息，请重新登录。';
  } finally {
    loading.value = false;
  }
});

const me = computed<Me | null>(() => session.state.user);

// ---- 展示映射 ----
function roleText(role: OperatorRole | undefined): string {
  const map: Record<OperatorRole, string> = {
    root: '超级管理员',
    operator: '操作员',
    viewer: '只读访客',
  };
  return role ? map[role] : '—';
}
function roleTone(role: OperatorRole | undefined): 'accent' | 'default' | 'muted' {
  if (role === 'root') return 'accent';
  if (role === 'viewer') return 'muted';
  return 'default';
}
function signupModeText(mode: Me['signupMode'] | undefined): string {
  const map: Record<Me['signupMode'], string> = {
    closed: '关闭注册',
    invite: '仅邀请注册',
    open: '开放注册',
  };
  return mode ? map[mode] : '—';
}

// ---- 修改密码 ----
const current = ref('');
const next = ref('');
const confirm = ref('');
const submitting = ref(false);

const nextErr = computed(() => (next.value !== '' && next.value.length < 8 ? '密码至少 8 位' : ''));
const confirmErr = computed(() =>
  confirm.value !== '' && confirm.value !== next.value ? '两次输入不一致' : '',
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
    toast.success('密码已更新，其他设备需重新登录');
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
      <EmptyState title="加载失败" :description="loadError" />
    </div>

    <div v-else class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <!-- 修改密码 -->
      <Card>
        <template #title>
          <span class="flex items-center gap-2">
            <KeyRound :size="15" class="text-muted" /> 修改密码
          </span>
        </template>

        <form class="space-y-4" @submit.prevent="submitPassword">
          <Field label="当前密码" required>
            <Input v-model="current" type="password" placeholder="输入当前密码" autocomplete="current-password" />
          </Field>
          <Field label="新密码" required :error="nextErr" hint="至少 8 位">
            <Input v-model="next" type="password" placeholder="设置新密码" autocomplete="new-password" />
          </Field>
          <Field label="确认新密码" required :error="confirmErr">
            <Input v-model="confirm" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
          </Field>
          <div class="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p class="text-xs text-muted/80">修改后其他已登录设备将失效。</p>
            <Button type="submit" variant="primary" :disabled="!canSubmit" :loading="submitting">
              更新密码
            </Button>
          </div>
        </form>
      </Card>

      <div class="space-y-5">
        <!-- 账户信息 -->
        <Card>
          <template #title>
            <span class="flex items-center gap-2">
              <UserRound :size="15" class="text-muted" /> 账户信息
            </span>
          </template>

          <dl class="divide-y divide-border/60 text-[13px]">
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">邮箱</dt>
              <dd class="min-w-0 truncate font-mono text-xs">{{ me?.email ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">显示名</dt>
              <dd class="min-w-0 truncate">{{ me?.displayName || '未设置' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">角色</dt>
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
              <ServerCog :size="15" class="text-muted" /> 实例配置
            </span>
          </template>

          <dl class="divide-y divide-border/60 text-[13px]">
            <div class="flex items-center justify-between gap-3 py-2.5">
              <dt class="text-muted">注册模式</dt>
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
              告警通知 webhook 在「告警」页配置，站点异常时推送通知。
            </span>
            <ArrowRight :size="14" class="shrink-0 text-accent" />
          </RouterLink>
        </Card>
      </div>
    </div>
  </div>
</template>
