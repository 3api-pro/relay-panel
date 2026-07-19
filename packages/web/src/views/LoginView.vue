<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, post, ApiError } from '../api/client';
import { session } from '../api/session';
import type { Me } from '../api/types';
import Button from '../components/ui/Button.vue';
import Field from '../components/ui/Field.vue';
import Input from '../components/ui/Input.vue';
import ThemeToggle from '../components/ThemeToggle.vue';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

// 演示模式：后端在 demo 模式下暴露 GET /api/demo（一键账号），据此展示"进入演示"入口
interface DemoInfo { demo: boolean; email: string; password: string; note?: string }
const demo = ref<DemoInfo | null>(null);
// 注册模式：open/invite 时展示注册入口，closed 时保留原提示
const signupMode = ref<'open' | 'invite' | 'closed'>('closed');
onMounted(async () => {
  try {
    const info = await get<DemoInfo>('/api/demo', { silent: true, skipAuthRedirect: true });
    if (info?.demo) demo.value = info;
  } catch {
    /* 非演示环境：无此端点，忽略 */
  }
  try {
    const cfg = await get<{ signupMode: 'open' | 'invite' | 'closed' }>('/api/auth/config', { silent: true, skipAuthRedirect: true });
    if (cfg?.signupMode) signupMode.value = cfg.signupMode;
  } catch {
    /* 取不到时按 closed 处理，保留原提示 */
  }
});

async function doLogin(em: string, pw: string): Promise<void> {
  if (loading.value) return;
  error.value = '';
  loading.value = true;
  try {
    const me = await post<Me>('/api/auth/login', { email: em, password: pw }, { silent: true, skipAuthRedirect: true });
    session.setUser(me);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect.startsWith('/') ? redirect : '/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('login.errorFail');
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!email.value || !password.value) {
    error.value = t('login.errorEmpty');
    return;
  }
  await doLogin(email.value, password.value);
}

async function enterDemo(): Promise<void> {
  if (demo.value) await doLogin(demo.value.email, demo.value.password);
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center p-4">
    <!-- 右上角：语言 + 主题切换 -->
    <div class="absolute right-4 top-4 flex items-center gap-2">
      <LanguageSwitcher />
      <ThemeToggle />
    </div>

    <div class="rp-page w-full max-w-[360px]">
      <!-- 品牌字标 -->
      <div class="mb-7 text-center">
        <div
          class="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[19px] font-bold text-accent shadow-[inset_0_1px_0_var(--glass-highlight),var(--glass-shadow)] backdrop-blur-xl"
        >
          r<span class="text-violet">/</span>p
        </div>
        <p class="text-[22px] font-semibold tracking-tight">
          relay<span class="text-accent">/</span>panel
        </p>
        <p class="mt-1 text-xs text-muted">{{ t('login.tagline') }}</p>
      </div>

      <!-- 演示入口：仅演示环境显示 -->
      <div v-if="demo" class="rp-glass mb-4 space-y-3 p-5 text-center">
        <p class="text-[13px] text-muted">{{ demo.note || t('login.demoNote') }}</p>
        <Button variant="primary" block :loading="loading" @click="enterDemo">{{ t('login.demoEnter') }}</Button>
        <p class="text-[11px] text-muted/70">
          {{ t('login.demoCreds') }}
          <code class="text-muted">{{ demo.email }}</code> · <code class="text-muted">{{ demo.password }}</code>
        </p>
      </div>

      <form class="rp-glass space-y-4 p-6" @submit.prevent="submit">
        <Field :label="t('login.email')">
          <Input v-model="email" type="email" placeholder="you@example.com" autocomplete="username" autofocus />
        </Field>
        <Field :label="t('login.password')" :error="error">
          <Input v-model="password" type="password" placeholder="········" autocomplete="current-password" />
        </Field>
        <Button variant="primary" type="submit" block :loading="loading">{{ t('login.submit') }}</Button>
      </form>

      <p v-if="signupMode === 'closed'" class="mt-4 text-center text-[11px] text-muted/80">{{ t('login.noRegister') }}</p>
      <p v-else class="mt-4 text-center text-[11px] text-muted/80">
        {{ t('login.newHere') }}
        <RouterLink to="/signup" class="text-accent hover:underline">{{ t('login.toSignup') }}</RouterLink>
      </p>
    </div>
  </div>
</template>
