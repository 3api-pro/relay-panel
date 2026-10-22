<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import { Button, Card } from '../components/ui';
const { t } = useI18n();
const state = ref<{ deploymentMode: string; accountEmailReady: boolean; emailVerificationRequired: boolean; adminMfaRequired: boolean; adminsWithoutMfa: number;
  backupExcludedTables: string[]; automaticBackupEnabled: boolean; backupOverdue: boolean; backup: { status: string; completedAt?: string; sha256?: string; bytes?: number; error?: string } | null;
  paidUnfulfilled: number; failedNotifications: number; migrations: string[] } | null>(null);
const busy = ref(false), error = ref('');
async function load(): Promise<void> { try { state.value = await get('/api/admin/operations'); } catch (e) { error.value = String(e); } }
onMounted(load);
async function backup(): Promise<void> { busy.value = true; error.value = ''; try { await post('/api/admin/operations/backup'); } catch (e) { error.value = String(e); } finally { busy.value = false; await load(); } }
</script>
<template><div class="rp-page space-y-5">
  <div class="flex justify-between gap-3"><h1 class="text-lg font-semibold">{{ t('operations.title') }}</h1><Button variant="ghost" @click="load">{{ t('operations.refresh') }}</Button></div>
  <p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
  <template v-if="state">
    <div class="grid gap-4 md:grid-cols-2">
      <Card><template #title>{{ t('operations.account') }}</template><div class="space-y-3 text-sm"><p>{{ t('operations.mail') }}：{{ t(state.accountEmailReady ? 'operations.ready' : 'operations.missing') }}</p><p>{{ t('operations.verify') }}：{{ t(state.emailVerificationRequired ? 'security.enabled' : 'security.disabled') }}</p><p>{{ t('operations.mfa') }}：{{ state.adminsWithoutMfa }}</p><RouterLink to="/settings" class="text-accent">{{ t('security.title') }} →</RouterLink></div></Card>
      <Card><template #title>{{ t('operations.attention') }}</template><div class="space-y-3 text-sm"><p>{{ t('operations.pendingPayment') }}：{{ state.paidUnfulfilled }}</p><p>{{ t('operations.failedMail') }}：{{ state.failedNotifications }}</p><RouterLink to="/admin/billing" class="text-accent">{{ t('nav.platformBilling') }} →</RouterLink></div></Card>
      <Card><template #title>{{ t('operations.backup') }}</template><div class="space-y-3 text-sm"><p>{{ t('operations.automatic') }}：{{ t(state.automaticBackupEnabled ? 'security.enabled' : 'security.disabled') }}</p><p :class="state.backupOverdue ? 'text-amber' : 'text-muted'">{{ t(state.backupOverdue ? 'operations.overdue' : 'operations.recent') }}</p><p>{{ state.backup?.completedAt }}</p><p v-if="state.backup?.error" class="text-red">{{ state.backup.error }}</p><p class="text-xs text-muted">{{ t('operations.backupScope') }}</p><p v-if="state.backupExcludedTables.length" class="break-all text-xs text-muted">{{ t('operations.excludedArchives') }}: {{ state.backupExcludedTables.join(', ') }}</p><Button :loading="busy" @click="backup">{{ t('operations.runBackup') }}</Button></div></Card>
      <Card><template #title>{{ t('operations.audit') }}</template><p class="mb-3 text-sm text-muted">{{ t('operations.auditHint') }}</p><a href="/api/audit/export.csv" class="text-accent">{{ t('operations.export') }} ↓</a></Card>
    </div>
    <Card><template #title>{{ t('operations.recovery') }}</template><p class="mb-3 text-sm leading-6 text-muted">{{ t('operations.recoveryHint') }}</p><a href="https://github.com/3api-pro/relay-panel/blob/main/docs/OPERATIONS.md" target="_blank" rel="noopener noreferrer" class="text-accent">{{ t('security.guide') }} ↗</a></Card>
  </template>
</div></template>
