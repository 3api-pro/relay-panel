<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, Select, EmptyState } from '../components/ui';
const { t } = useI18n();
interface Ticket { id: number; subject: string; status: string; version: number }
const tickets = ref<Ticket[]>([]), selected = ref<Ticket | null>(null);
const messages = ref<{ id: number; body: string; staff: boolean; createdAt: string }[]>([]);
const subject = ref(''), body = ref(''), replyText = ref(''), error = ref(''), busy = ref(false);
const status = ref<string | number | null>('open');
async function load(): Promise<void> { try { tickets.value = (await get<{ tickets: Ticket[] }>('/api/support/tickets')).tickets; } catch (e) { error.value = String(e); } }
onMounted(load);
async function open(ticket: Ticket): Promise<void> {
  try { const result = await get<{ ticket: Ticket; messages: typeof messages.value }>(`/api/support/tickets/${ticket.id}`); selected.value = result.ticket; messages.value = result.messages; status.value = session.isRoot.value ? 'waiting_customer' : 'open'; }
  catch (e) { error.value = String(e); }
}
async function create(): Promise<void> {
  busy.value = true; error.value = '';
  try { const result = await post<{ ticket: Ticket }>('/api/support/tickets', { subject: subject.value, body: body.value }); subject.value = ''; body.value = ''; await load(); await open(result.ticket); }
  catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function reply(): Promise<void> {
  if (!selected.value) return; busy.value = true; error.value = '';
  try { const result = await post<{ ticket: Ticket }>(`/api/support/tickets/${selected.value.id}/messages`, { version: selected.value.version, body: replyText.value, status: status.value }); replyText.value = ''; await load(); await open(result.ticket); }
  catch (e) { error.value = String(e); } finally { busy.value = false; }
}
</script>
<template>
  <div class="rp-page space-y-5">
    <h1 class="text-lg font-semibold">{{ t('ops.support') }}</h1><p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
    <Card><template #title>{{ t('ops.newTicket') }}</template><form class="space-y-3" @submit.prevent="create">
      <Field :label="t('ops.subject')"><Input v-model="subject" required maxlength="120" /></Field>
      <Field :label="t('ops.description')"><textarea v-model="body" required maxlength="5000" rows="4" class="w-full rounded border border-border bg-panel-2 p-3 text-sm" /></Field>
      <p class="text-xs text-muted">{{ t('ops.noSecrets') }}</p><Button type="submit" :loading="busy">{{ t('ops.submit') }}</Button>
    </form></Card>
    <div class="grid gap-4 md:grid-cols-2">
      <Card><template #title>{{ t('ops.ticketList') }}</template>
        <EmptyState v-if="!tickets.length" :title="t('ops.noTickets')" />
        <button v-for="ticket in tickets" :key="ticket.id" class="block w-full border-b border-border p-3 text-left text-sm hover:bg-panel-2" @click="open(ticket)">#{{ ticket.id }} {{ ticket.subject }} <span class="text-muted">· {{ t(`ops.${ticket.status}`) }}</span></button>
      </Card>
      <Card v-if="selected"><template #title>#{{ selected.id }} {{ selected.subject }}</template>
        <div class="space-y-4"><div v-for="m in messages" :key="m.id" class="rounded bg-panel-2 p-3 text-sm"><p class="mb-2 text-xs text-muted">{{ m.staff ? t('ops.staff') : t('ops.customer') }} · {{ m.createdAt }} UTC</p><p class="whitespace-pre-wrap break-words">{{ m.body }}</p></div>
          <form class="space-y-3" @submit.prevent="reply"><Field :label="t('ops.reply')"><textarea v-model="replyText" required rows="3" maxlength="5000" class="w-full rounded border border-border bg-panel-2 p-3 text-sm" /></Field>
            <Select v-model="status" :options="(session.isRoot.value ? ['waiting_customer','open','resolved'] : ['open','resolved']).map(x => ({ value: x, label: t(`ops.${x}`) }))" />
            <Button type="submit" :loading="busy">{{ t('ops.sendReply') }}</Button>
          </form>
        </div>
      </Card>
    </div>
  </div>
</template>
