<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { post, ApiError } from '../api/client';
import { session } from '../api/session';
import type { Me } from '../api/types';
import Button from '../components/ui/Button.vue';
import Field from '../components/ui/Field.vue';
import Input from '../components/ui/Input.vue';

const route = useRoute();
const router = useRouter();

const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  if (loading.value) return;
  error.value = '';
  if (!email.value || !password.value) {
    error.value = '请输入邮箱和密码';
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
    error.value = err instanceof ApiError ? err.message : '登录失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center p-4">
    <!-- 登录页专属辉光 -->
    <div
      class="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.06] blur-[120px]"
    />

    <div class="rp-page w-full max-w-[360px]">
      <!-- 品牌字标 -->
      <div class="mb-7 text-center">
        <p class="text-[22px] font-semibold tracking-tight">
          relay<span class="text-accent">/</span>panel
        </p>
        <p class="mt-1 text-xs text-muted">多站中转编排控制台</p>
      </div>

      <form class="rp-panel space-y-4 p-6" @submit.prevent="submit">
        <Field label="邮箱">
          <Input v-model="email" type="email" placeholder="you@example.com" autocomplete="username" autofocus />
        </Field>
        <Field label="密码" :error="error">
          <Input v-model="password" type="password" placeholder="········" autocomplete="current-password" />
        </Field>
        <Button variant="primary" type="submit" block :loading="loading">登录</Button>
      </form>

      <p class="mt-4 text-center text-[11px] text-muted/70">未开放注册？请联系实例管理员获取邀请。</p>
    </div>
  </div>
</template>
