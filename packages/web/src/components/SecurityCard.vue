<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post, del } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input } from './ui';
const { t } = useI18n();
const state = ref<{ mfaEnabled: boolean; emailVerified: boolean; recoveryCodesRemaining: number; mfaRequired: boolean; mfaAvailable: boolean } | null>(null);
const activeSessions = ref<{ id: string; current: boolean; ip: string | null; userAgent: string | null; createdAt: string }[]>([]);
const password = ref(''), code = ref(''), secret = ref(''), uri = ref(''), error = ref('');
const codes = ref<string[]>([]), busy = ref(false), ended = ref(false);
async function load(): Promise<void> {
  try {
    state.value = await get('/api/auth/security');
    activeSessions.value = (await get<{ sessions: typeof activeSessions.value }>('/api/auth/sessions')).sessions;
  } catch (e) { error.value = e instanceof Error ? e.message : t('security.failed'); }
}
onMounted(load);
async function action(kind: 'setup' | 'enable' | 'disable'): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const result = await post<{ secret?: string; uri?: string; recoveryCodes?: string[]; loginRequired?: boolean }>(`/api/auth/mfa/${kind}`, { password: password.value, code: code.value }, { silent: true });
    if (result.secret) { secret.value = result.secret; uri.value = result.uri ?? ''; }
    if (result.recoveryCodes) codes.value = result.recoveryCodes;
    if (result.loginRequired) { session.clear(); ended.value = true; password.value = ''; code.value = ''; secret.value = ''; }
  } catch (e) { error.value = e instanceof Error ? e.message : t('security.failed'); }
  finally { busy.value = false; }
}
async function revoke(id: string): Promise<void> { await del(`/api/auth/sessions/${id}`); await load(); }
</script>
<template>
  <Card>
    <template #title>{{ t('security.title') }}</template>
    <div class="space-y-4 text-sm">
      <p v-if="error" role="alert" class="text-red">{{ error }}</p>
      <template v-if="ended">
        <p>{{ t('security.saveCodes') }}</p>
        <pre v-if="codes.length" class="whitespace-pre-wrap rounded border border-border p-3 font-mono text-xs">{{ codes.join('\n') }}</pre>
        <a href="/login" class="text-accent">{{ t('security.backLogin') }}</a>
      </template>
      <template v-else-if="state">
        <p>{{ t('security.mfa') }}：{{ state.mfaEnabled ? t('security.enabled') : t('security.disabled') }}</p>
        <p v-if="state.mfaRequired && !state.mfaEnabled" class="text-amber">{{ t('security.required') }}</p>
        <p v-if="state.mfaEnabled" class="text-muted">{{ t('security.remainingCodes', { n: state.recoveryCodesRemaining }) }}</p>
        <template v-if="state.mfaAvailable">
          <Field :label="t('security.password')"><Input v-model="password" type="password" autocomplete="current-password" /></Field>
          <template v-if="secret">
            <p class="text-muted">{{ t('security.setupHint') }}</p>
            <code class="block break-all rounded bg-panel-2 p-3">{{ secret }}</code>
            <a :href="uri" class="text-accent">{{ t('security.openAuthenticator') }}</a>
          </template>
          <Field v-if="secret || state.mfaEnabled" :label="t('security.code')"><Input v-model="code" autocomplete="one-time-code" /></Field>
          <Button v-if="!state.mfaEnabled" :loading="busy" @click="action(secret ? 'enable' : 'setup')">{{ secret ? t('security.confirmEnable') : t('security.setup') }}</Button>
          <Button v-else-if="!state.mfaRequired" :loading="busy" variant="outline" @click="action('disable')">{{ t('security.disable') }}</Button>
        </template>
        <p v-else class="text-muted">{{ t('security.missingKey') }}</p>
        <div class="space-y-2 border-t border-border pt-3">
          <p class="font-medium">{{ t('security.sessions') }}</p>
          <div v-for="s in activeSessions" :key="s.id" class="flex items-center justify-between gap-3 text-xs">
            <span class="min-w-0 break-all">{{ s.ip }} · {{ s.userAgent || '—' }} <span v-if="s.current">({{ t('security.current') }})</span></span>
            <Button v-if="!s.current" variant="ghost" @click="revoke(s.id)">{{ t('security.revoke') }}</Button>
          </div>
        </div>
      </template>
    </div>
  </Card>
</template>
