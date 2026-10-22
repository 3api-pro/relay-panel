<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, put, post } from '../api/client';
import { Button, Card, EmptyState } from '../components/ui';
const { t } = useI18n();
const prefs = ref({ alerts: true, billing: true, support: true }), emailAvailable = ref(false), busy = ref(false), error = ref('');
const items = ref<{ id: number; subject: string; body: string; category: string; readAt: string | null; status: string }[]>([]);
async function load(): Promise<void> {
  try { const [p, n] = await Promise.all([get<{ preferences: typeof prefs.value; emailAvailable: boolean }>('/api/notifications/preferences'), get<{ notifications: typeof items.value }>('/api/notifications')]); prefs.value = p.preferences; emailAvailable.value = p.emailAvailable; items.value = n.notifications; }
  catch (e) { error.value = String(e); }
}
onMounted(load);
async function save(): Promise<void> { busy.value = true; try { await put('/api/notifications/preferences', prefs.value); } catch (e) { error.value = String(e); } finally { busy.value = false; } }
async function read(id: number): Promise<void> { await post(`/api/notifications/${id}/read`); await load(); }
</script>
<template><div class="rp-page space-y-5">
  <h1 class="text-lg font-semibold">{{ t('ops.notifications') }}</h1><p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
  <Card><template #title>{{ t('ops.preferences') }}</template>
    <form class="space-y-3 text-sm" @submit.prevent="save">
      <label v-for="key in (['alerts','billing','support'] as const)" :key="key" class="block"><input v-model="prefs[key]" type="checkbox" class="mr-2" />{{ t(`ops.notify_${key}`) }}</label>
      <p class="text-xs text-muted">{{ t('ops.securityAlways') }}</p><p v-if="!emailAvailable" class="text-xs text-amber">{{ t('ops.emailUnavailable') }}</p><Button type="submit" :loading="busy">{{ t('ops.save') }}</Button>
    </form>
  </Card>
  <EmptyState v-if="!items.length" :title="t('ops.noNotifications')" />
  <Card v-for="n in items" :key="n.id"><template #title>{{ n.subject }}</template><p class="whitespace-pre-wrap break-words text-sm">{{ n.body }}</p><Button v-if="!n.readAt" class="mt-3" variant="ghost" @click="read(n.id)">{{ t('ops.markRead') }}</Button></Card>
</div></template>
