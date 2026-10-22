<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get } from '../api/client';
import { Card } from './ui';
const { t } = useI18n();
const state = ref<{ connectedSites: number; emailVerified: boolean; mfaEnabled: boolean } | null>(null);
onMounted(async () => { try { state.value = await get('/api/onboarding', { silent: true }); } catch { /* Existing dashboard retains its own error handling. */ } });
</script>
<template><Card v-if="state && state.connectedSites === 0">
  <template #title>{{ t('operations.onboarding') }}</template><p class="mb-4 text-sm text-muted">{{ t('security.deployIntro') }}</p>
  <div class="grid gap-3 text-sm sm:grid-cols-3"><RouterLink to="/self-deploy" class="rounded border border-border p-3 text-accent">1. {{ t('security.selfDeploy') }}</RouterLink><RouterLink to="/sites?adopt=1" class="rounded border border-border p-3 text-accent">2. {{ t('security.connect') }}</RouterLink><RouterLink to="/notifications" class="rounded border border-border p-3 text-accent">3. {{ t('ops.preferences') }}</RouterLink></div>
  <RouterLink to="/support" class="mt-4 block text-xs text-muted">{{ t('ops.support') }} →</RouterLink>
</Card></template>
