<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post, patch } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, Select, EmptyState } from '../components/ui';
const { t } = useI18n();
interface Refund { id: number; orderNo: string; amount: number; reason: string; status: string; version: number; note: string | null; receipt: string | null }
interface Order { orderNo: string; amount: number; status: string }
const refunds = ref<Refund[]>([]), orders = ref<Order[]>([]);
const selectedOrder = ref<string | number | null>(''), amount = ref<string | number>(''), reason = ref('');
const active = ref<Refund | null>(null), note = ref(''), receipt = ref(''), entitlement = ref<string | number | null>('keep');
const subscriptions = ref<{ id: number; planKey: string; currentPeriodEnd: string; version: string; pendingChange: unknown }[]>([]);
const busy = ref(false), error = ref('');
async function load(): Promise<void> {
  try {
    const results = await Promise.all([get<{ refunds: Refund[] }>('/api/billing/refunds'), get<{ orders: Order[] }>('/api/billing/orders')]);
    refunds.value = results[0].refunds; orders.value = results[1].orders.filter(o => ['completed', 'paid'].includes(o.status));
  } catch (e) { error.value = e instanceof Error ? e.message : t('ops.failed'); }
}
onMounted(load);
async function request(): Promise<void> {
  busy.value = true; error.value = '';
  try { await post(`/api/billing/orders/${encodeURIComponent(String(selectedOrder.value))}/refunds`, { amount: Number(amount.value), reason: reason.value }); reason.value = ''; await load(); }
  catch (e) { error.value = e instanceof Error ? e.message : t('ops.failed'); }
  finally { busy.value = false; }
}
async function select(row: Refund): Promise<void> {
  active.value = row; note.value = ''; receipt.value = ''; entitlement.value = 'keep'; subscriptions.value = [];
  if (session.isRoot.value && row.status === 'approved') {
    try { subscriptions.value = (await get<{ subscriptions: typeof subscriptions.value }>(`/api/billing/refunds/${row.id}/preview`)).subscriptions; }
    catch (e) { error.value = e instanceof Error ? e.message : t('ops.failed'); }
  }
}
async function act(action: string): Promise<void> {
  if (!active.value) return;
  busy.value = true; error.value = '';
  try {
    await patch(`/api/billing/refunds/${active.value.id}`, { action, version: active.value.version, note: note.value,
      ...(action === 'complete' ? { receipt: receipt.value, entitlement: entitlement.value, subscriptionVersion: subscriptions.value[0]?.version } : {}),
    });
    active.value = null; await load();
  } catch (e) { error.value = e instanceof Error ? e.message : t('ops.failed'); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="rp-page space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3"><h1 class="text-lg font-semibold">{{ t('ops.aftercare') }}</h1><a href="/api/billing/statement.csv" class="text-sm text-accent">{{ t('ops.downloadStatement') }} ↓</a></div>
    <p class="text-xs text-muted">{{ t('ops.statementNote') }}</p>
    <p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
    <Card><template #title>{{ t('ops.requestRefund') }}</template>
      <form class="grid gap-4 md:grid-cols-2" @submit.prevent="request">
        <Field :label="t('ops.order')"><Select v-model="selectedOrder" :options="orders.map(o => ({ value: o.orderNo, label: `${o.orderNo} · CNY ${o.amount}` }))" /></Field>
        <Field :label="t('ops.amount')"><Input v-model="amount" type="number" min="0.01" step="0.01" required /></Field>
        <Field :label="t('ops.reason')" class="md:col-span-2"><Input v-model="reason" required maxlength="1000" /></Field>
        <Button type="submit" :loading="busy" :disabled="!selectedOrder">{{ t('ops.submit') }}</Button>
      </form>
    </Card>
    <div class="rp-panel overflow-x-auto">
      <EmptyState v-if="!refunds.length" :title="t('ops.noRefunds')" />
      <table v-else class="w-full text-left text-sm"><thead><tr class="border-b border-border"><th class="p-3">{{ t('ops.order') }}</th><th class="p-3">CNY</th><th class="p-3">{{ t('ops.status') }}</th><th class="p-3">{{ t('ops.reason') }}</th><th></th></tr></thead>
        <tbody><tr v-for="r in refunds" :key="r.id" class="border-b border-border/50"><td class="p-3 font-mono text-xs">{{ r.orderNo }}</td><td class="p-3">{{ r.amount.toFixed(2) }}</td><td class="p-3">{{ t(`ops.${r.status}`) }}</td><td class="max-w-xs break-words p-3">{{ r.reason }}</td><td class="p-3"><Button variant="ghost" @click="select(r)">{{ t('ops.view') }}</Button></td></tr></tbody>
      </table>
    </div>
    <Card v-if="active"><template #title>#{{ active.id }} · {{ t(`ops.${active.status}`) }}</template>
      <div class="space-y-4 text-sm">
        <p>{{ active.note }}</p><p v-if="active.receipt">{{ t('ops.receipt') }}：{{ active.receipt }}</p>
        <template v-if="['requested','approved'].includes(active.status)">
          <Field :label="t('ops.note')"><Input v-model="note" required maxlength="2000" /></Field>
          <template v-if="session.isRoot.value && active.status === 'approved'">
            <p class="rounded border border-border p-3 text-muted">{{ t('ops.manualRefundNote') }}</p>
            <Field :label="t('ops.receipt')"><Input v-model="receipt" required maxlength="200" /></Field>
            <Field :label="t('ops.entitlement')"><Select v-model="entitlement" :options="['keep','cancel_pending','end_subscription'].map(x => ({ value: x, label: t(`ops.${x}`) }))" /></Field>
            <p v-for="s in subscriptions" :key="s.id" class="text-xs text-muted">{{ s.planKey }} · {{ s.currentPeriodEnd }} UTC <span v-if="s.pendingChange"> · {{ t('ops.hasPending') }}</span></p>
            <p v-if="entitlement === 'end_subscription'" class="text-red">{{ t('ops.endWarning') }}</p>
            <Button :loading="busy" @click="act('complete')">{{ t('ops.confirmRefund') }}</Button>
          </template>
          <div v-else-if="active.status === 'requested'" class="flex gap-3">
            <template v-if="session.isRoot.value"><Button :loading="busy" @click="act('approve')">{{ t('ops.approve') }}</Button><Button variant="outline" :loading="busy" @click="act('reject')">{{ t('ops.reject') }}</Button></template>
            <Button v-else variant="outline" :loading="busy" @click="act('cancel')">{{ t('ops.cancel') }}</Button>
          </div>
        </template>
      </div>
    </Card>
  </div>
</template>
