<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
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

type SignupMode = 'open' | 'invite' | 'closed';
const mode = ref<SignupMode>('open');
const modeLoaded = ref(false);

const email = ref('');
const password = ref('');
const displayName = ref('');
const inviteToken = ref('');
const loading = ref(false);
const error = ref('');

const inviteRequired = computed(() => mode.value === 'invite');
const closed = computed(() => mode.value === 'closed');

onMounted(async () => {
  try {
    const cfg = await get<{ signupMode: SignupMode }>('/api/auth/config', { silent: true, skipAuthRedirect: true });
    if (cfg?.signupMode) mode.value = cfg.signupMode;
    // 邀请码可从链接预填：/signup?invite=xxxx
    const q = route.query.invite;
    if (typeof q === 'string') inviteToken.value = q;
  } catch {
    /* 取不到配置时按 open 处理，后端会最终校验 */
  } finally {
    modeLoaded.value = true;
  }
});

async function submit(): Promise<void> {
  if (loading.value) return;
  error.value = '';
  if (!email.value || !password.value) {
    error.value = t('signup.errorEmpty');
    return;
  }
  if (password.value.length < 8) {
    error.value = t('signup.errorPasswordShort');
    return;
  }
  if (inviteRequired.value && !inviteToken.value.trim()) {
    error.value = t('signup.errorInviteRequired');
    return;
  }
  loading.value = true;
  try {
    const body: Record<string, string> = { email: email.value, password: password.value };
    if (displayName.value.trim()) body.displayName = displayName.value.trim();
    if (inviteToken.value.trim()) body.inviteToken = inviteToken.value.trim();
    await post<Me>('/api/auth/signup', body, { silent: true, skipAuthRedirect: true });
    // 注册成功后直接登录，进入面板
    const me = await post<Me>('/api/auth/login', { email: email.value, password: password.value }, { silent: true, skipAuthRedirect: true });
    session.setUser(me);
    await router.push('/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('signup.errorFail');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center p-4">
    <div class="absolute right-4 top-4 flex items-center gap-2">
      <LanguageSwitcher />
      <ThemeToggle />
    </div>

    <div class="rp-page w-full max-w-[360px]">
      <div class="mb-7 text-center">
        <div
          class="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[19px] font-bold text-accent shadow-[inset_0_1px_0_var(--glass-highlight),var(--glass-shadow)] backdrop-blur-xl"
        >
          r<span class="text-violet">/</span>p
        </div>
        <p class="text-[22px] font-semibold tracking-tight">
          relay<span class="text-accent">/</span>panel
        </p>
        <p class="mt-1 text-xs text-muted">{{ t('signup.tagline') }}</p>
      </div>

      <!-- 注册关闭 -->
      <div v-if="modeLoaded && closed" class="rp-glass space-y-3 p-6 text-center">
        <p class="text-[13px] text-muted">{{ t('signup.closed') }}</p>
        <Button variant="ghost" block @click="router.push('/login')">{{ t('signup.toLogin') }}</Button>
      </div>

      <form v-else class="rp-glass space-y-4 p-6" @submit.prevent="submit">
        <Field :label="t('signup.email')">
          <Input v-model="email" type="email" placeholder="you@example.com" autocomplete="username" autofocus />
        </Field>
        <Field :label="t('signup.displayName')">
          <Input v-model="displayName" type="text" :placeholder="t('signup.displayNamePlaceholder')" autocomplete="nickname" />
        </Field>
        <Field :label="t('signup.password')" :error="inviteRequired ? '' : error">
          <Input v-model="password" type="password" placeholder="········" autocomplete="new-password" />
        </Field>
        <Field v-if="inviteRequired" :label="t('signup.invite')" :error="error">
          <Input v-model="inviteToken" type="text" :placeholder="t('signup.invitePlaceholder')" />
        </Field>
        <Button variant="primary" type="submit" block :loading="loading">{{ t('signup.submit') }}</Button>
      </form>

      <p class="mt-4 text-center text-[11px] text-muted/80">
        {{ t('signup.haveAccount') }}
        <RouterLink to="/login" class="text-accent hover:underline">{{ t('signup.toLogin') }}</RouterLink>
      </p>
    </div>
  </div>
</template>
