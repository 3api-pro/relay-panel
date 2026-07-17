<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { post, ApiError } from '../api/client';
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

async function submit(): Promise<void> {
  if (loading.value) return;
  error.value = '';
  if (!email.value || !password.value) {
    error.value = t('login.errorEmpty');
    return;
  }
  loading.value = true;
  try {
    const me = await post<Me>(
      '/api/auth/login',
      { email: email.value, password: password.value },
      { silent: true, skipAuthRedirect: true },
    );
    session.setUser(me);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect.startsWith('/') ? redirect : '/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('login.errorFail');
  } finally {
    loading.value = false;
  }
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

      <form class="rp-glass space-y-4 p-6" @submit.prevent="submit">
        <Field :label="t('login.email')">
          <Input v-model="email" type="email" placeholder="you@example.com" autocomplete="username" autofocus />
        </Field>
        <Field :label="t('login.password')" :error="error">
          <Input v-model="password" type="password" placeholder="········" autocomplete="current-password" />
        </Field>
        <Button variant="primary" type="submit" block :loading="loading">{{ t('login.submit') }}</Button>
      </form>

      <p class="mt-4 text-center text-[11px] text-muted/80">{{ t('login.noRegister') }}</p>
    </div>
  </div>
</template>
