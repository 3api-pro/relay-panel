<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { post } from '../api/client';
import { Button, Field, Input } from '../components/ui';
const { t } = useI18n();
const route = useRoute();
const fragment = new URLSearchParams(location.hash.slice(1));
const token = ref(fragment.get('reset') ?? fragment.get('verify') ?? '');
const purpose = ref(fragment.has('verify') ? 'verify' : 'reset');
// Remove token from history once captured; never put it into a query parameter.
if (token.value) history.replaceState(history.state, '', location.pathname);
const email = ref(''), password = ref(''), confirm = ref(''), code = ref('');
const busy = ref(false), error = ref(''), done = ref(false);
const sent = ref(route.query.sent === '1');
async function submit(): Promise<void> {
  error.value = ''; busy.value = true;
  try {
    if (token.value) {
      if (purpose.value === 'reset' && (password.value.length < 8 || password.value !== confirm.value)) throw new Error(t('security.passwordMismatch'));
      await post('/api/auth/recovery/complete', { token: token.value, purpose: purpose.value,
        ...(purpose.value === 'reset' ? { password: password.value, code: code.value } : {}),
      }, { silent: true, skipAuthRedirect: true });
      token.value = ''; done.value = true;
    } else {
      await post('/api/auth/recovery/request', { email: email.value, purpose: purpose.value }, { silent: true, skipAuthRedirect: true });
      sent.value = true;
    }
  } catch (e) { error.value = e instanceof Error ? e.message : t('security.failed'); }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
    <h1 class="text-xl font-semibold">{{ t('security.recoveryTitle') }}</h1>
    <p v-if="done" role="status" class="rp-panel p-5">{{ t('security.recoveryDone') }}</p>
    <form v-else class="rp-panel space-y-4 p-5" @submit.prevent="submit">
      <p v-if="sent" role="status" class="text-sm text-accent">{{ t('security.emailSent') }}</p>
      <template v-if="!token">
        <Field :label="t('security.email')"><Input v-model="email" type="email" required autocomplete="email" /></Field>
        <label class="block text-sm"><input v-model="purpose" type="radio" value="reset" /> {{ t('security.reset') }}</label>
        <label class="block text-sm"><input v-model="purpose" type="radio" value="verify" /> {{ t('security.resend') }}</label>
      </template>
      <template v-else-if="purpose === 'reset'">
        <Field :label="t('security.newPassword')"><Input v-model="password" type="password" required autocomplete="new-password" /></Field>
        <Field :label="t('security.confirmPassword')"><Input v-model="confirm" type="password" required autocomplete="new-password" /></Field>
        <Field :label="t('security.codeOptional')"><Input v-model="code" autocomplete="one-time-code" /></Field>
      </template>
      <p v-else class="text-sm">{{ t('security.verifyConfirm') }}</p>
      <p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
      <Button type="submit" :loading="busy" variant="primary">{{ token ? t('security.confirm') : t('security.send') }}</Button>
    </form>
    <RouterLink to="/login" class="text-sm text-accent">{{ t('security.backLogin') }}</RouterLink>
  </main>
</template>
