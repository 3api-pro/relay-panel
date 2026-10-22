<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UsageRecord } from '@relay-panel/adapter-core';
import { get, post } from '../api/client';
import type { SiteView, SitesResponse } from '../api/types';
import Button from '../components/ui/Button.vue';
import { toast } from '../components/ui/toast';

interface ReviewCase {
  id: number; version: number; slug: string; label: string; state: string; verification: string;
  reasons: string[]; evidence: UsageRecord;
  events?: { id: number; actor: string; kind: string; state: string; note: string; createdAt: string }[];
  historyTruncated?: boolean;
}
interface ScanResult { page: number; pages: number; scanned: number; total: number; flagged: number; created: number; updated: number }
const { t } = useI18n();
const tr = (key: string) => t(`financeReview.${key}`);
const base = '/api/admin/finance-review';
const sites = ref<SiteView[]>([]);
const slug = ref('');
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const from = ref(today); const to = ref(today); const requestId = ref(''); const scanPage = ref(1);
const scanResult = ref<ScanResult | null>(null);
const busy = ref(false); const loading = ref(false); const error = ref('');
const stateFilter = ref(''); const listPage = ref(1); const hasMore = ref(false);
const items = ref<ReviewCase[]>([]); const selected = ref<ReviewCase | null>(null);
const decision = ref('reviewing'); const note = ref(''); const detailHeading = ref<HTMLElement | null>(null);
const states = ['pending', 'reviewing', 'confirmed', 'explained', 'resolved'];
const fields: (keyof UsageRecord)[] = ['id', 'model', 'createdAt', 'userId', 'accountId', 'subscriptionId', 'billingType',
  'actualCost', 'totalCost', 'rateMultiplier', 'accountStatsCost', 'accountRateMultiplier', 'accountCost'];
const canResolve = computed(() => selected.value?.verification === 'clear');
const money = (v: number | null) => v === null ? tr('unknown') : `${v.toLocaleString(undefined, { maximumFractionDigits: 8 })} USD`;
let loadId = 0;
async function load() {
  const id = ++loadId;
  loading.value = true;
  try {
    const result = await get<{ items: ReviewCase[]; hasMore: boolean }>(base, {
      query: { state: stateFilter.value || undefined, page: listPage.value }, silent: true });
    if (id === loadId) { items.value = result.items; hasMore.value = result.hasMore; }
  } catch (e) { if (id === loadId) { items.value = []; error.value = e instanceof Error ? e.message : tr('loadFailed'); } }
  finally { if (id === loadId) loading.value = false; }
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await action(); } catch (e) { error.value = e instanceof Error ? e.message : tr('loadFailed'); }
  finally { busy.value = false; }
}
async function scan(next = false) {
  await run(async () => {
    const page = next ? (scanResult.value?.page ?? 0) + 1 : scanPage.value;
    scanResult.value = null;
    const result = await post<ScanResult>(`${base}/scan`, { slug: slug.value, from: from.value, to: to.value,
      page, ...(requestId.value.trim() ? { requestId: requestId.value.trim() } : {}) }, { silent: true });
    scanPage.value = page; scanResult.value = result;
    await load();
    if (selected.value) await open(selected.value.id, false);
  });
}
async function open(id: number, focus = true) {
  selected.value = await get<ReviewCase>(`${base}/${id}`, { silent: true });
  decision.value = selected.value.state; note.value = '';
  if (focus) { await nextTick(); detailHeading.value?.focus(); detailHeading.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
}
async function recheck() {
  if (!selected.value) return;
  await run(async () => {
    const row = selected.value!;
    await post(`${base}/${row.id}/recheck`, { version: row.version }, { silent: true });
    await open(row.id, false); await load();
  });
}
async function save() {
  if (!selected.value) return;
  await run(async () => {
    const row = selected.value!;
    await post(`${base}/${row.id}/review`, { version: row.version, state: decision.value, note: note.value }, { silent: true });
    await open(row.id, false); await load(); toast.success(tr('saved'));
  });
}
watch([slug, from, to, requestId], () => { scanResult.value = null; scanPage.value = 1; });
watch(stateFilter, () => { listPage.value = 1; void load(); });
watch(listPage, () => void load());
onMounted(async () => {
  await run(async () => {
    sites.value = (await get<SitesResponse>('/api/sites', { silent: true })).sites.filter(s => s.status !== 'destroyed');
    slug.value = sites.value.find(s => s.engine === 'sub2api')?.slug ?? '';
    await load();
  });
});
</script>

<template>
  <div class="rp-page space-y-5">
    <div><h1 class="text-lg font-semibold">{{ tr('title') }}</h1><p class="mt-1 text-sm text-muted">{{ tr('intro') }}</p></div>
    <p class="rounded-xl border border-border bg-panel p-4 text-sm text-muted">{{ tr('boundary') }}</p>
    <p v-if="error" role="alert" class="rounded-lg border border-red/30 p-3 text-sm text-red">{{ error }}</p>

    <section class="rounded-xl border border-border bg-panel p-4 space-y-3" :aria-label="tr('scanTitle')">
      <h2 class="font-medium">{{ tr('scanTitle') }}</h2>
      <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" @submit.prevent="scan()">
        <label>{{ tr('site') }}<select v-model="slug" :disabled="busy" required>
          <option v-for="s in sites" :key="s.slug" :value="s.slug" :disabled="s.engine !== 'sub2api'">{{ s.label }} ({{ s.slug }}){{ s.engine !== 'sub2api' ? ` · ${tr('unsupported')}` : '' }}</option>
        </select></label>
        <label>{{ tr('from') }}<input v-model="from" type="date" :max="today" :disabled="busy" required></label>
        <label>{{ tr('to') }}<input v-model="to" type="date" :min="from" :max="today" :disabled="busy" required></label>
        <label>{{ tr('requestId') }}<input v-model="requestId" maxlength="256" :disabled="busy"></label>
        <label>{{ tr('page') }}<input v-model.number="scanPage" type="number" min="1" max="100000" :disabled="busy" required></label>
        <div class="flex items-end gap-2"><Button type="submit" :disabled="busy || !slug">{{ tr('scan') }}</Button>
          <Button v-if="scanResult && scanResult.page < scanResult.pages" :disabled="busy" @click="scan(true)">{{ tr('nextScan') }}</Button></div>
      </form>
      <p class="text-xs text-muted">{{ tr('scope') }}</p>
      <p v-if="scanResult" role="status" class="text-sm text-accent">{{ t('financeReview.scanResult', { ...scanResult }) }}</p>
    </section>

    <section class="rounded-xl border border-border bg-panel p-4 space-y-3" :aria-label="tr('cases')">
      <div class="flex flex-wrap items-center gap-3"><h2 class="mr-auto font-medium">{{ tr('cases') }}</h2>
        <select v-model="stateFilter" class="!w-auto" :aria-label="tr('state')" :disabled="busy"><option value="">{{ tr('all') }}</option><option v-for="s in states" :key="s" :value="s">{{ tr(`states.${s}`) }}</option></select>
        <Button :disabled="busy || loading" @click="run(load)">{{ tr('refresh') }}</Button></div>
      <div class="overflow-x-auto" :aria-busy="loading"><table class="w-full min-w-[760px] text-left text-xs">
        <thead class="text-muted"><tr><th>{{ tr('record') }}</th><th>{{ tr('signals') }}</th><th>{{ tr('charge') }}</th><th>{{ tr('cost') }}</th><th>{{ tr('state') }}</th><th>{{ tr('verification') }}</th><th></th></tr></thead>
        <tbody><tr v-for="row in items" :key="row.id" class="border-t border-border">
          <td><div>{{ row.label }} · #{{ row.evidence.id }}</div><div class="max-w-56 truncate text-muted" :title="row.evidence.requestId ?? ''">{{ row.evidence.requestId ?? tr('unknown') }}</div><div class="text-muted">{{ row.evidence.model }}</div></td>
          <td class="max-w-48"><p v-for="reason in row.reasons" :key="reason">{{ tr(`reasons.${reason}`) }}</p><span v-if="!row.reasons.length">{{ tr('checks.clear') }}</span></td>
          <td class="whitespace-nowrap">{{ money(row.evidence.actualCost) }}</td><td class="whitespace-nowrap">{{ money(row.evidence.accountCost) }}</td>
          <td>{{ tr(`states.${row.state}`) }}</td><td>{{ tr(`checks.${row.verification}`) }}</td>
          <td><Button :disabled="busy" @click="run(() => open(row.id))">{{ tr('open') }}</Button></td>
        </tr></tbody>
      </table></div>
      <p v-if="!items.length && !loading" class="py-6 text-center text-sm text-muted">{{ tr('empty') }}</p>
      <div class="flex items-center justify-end gap-3 text-xs"><Button :disabled="busy || loading || listPage === 1" @click="listPage--">{{ tr('previous') }}</Button>{{ tr('page') }} {{ listPage }}<Button :disabled="busy || loading || !hasMore" @click="listPage++">{{ tr('next') }}</Button></div>
    </section>

    <section v-if="selected" class="rounded-xl border border-border bg-panel p-4 space-y-4" :aria-label="tr('details')">
      <div class="flex flex-wrap items-center gap-3"><h2 ref="detailHeading" tabindex="-1" class="mr-auto font-medium">{{ tr('details') }} · #{{ selected.id }}</h2>
        <Button :disabled="busy" @click="run(() => open(selected!.id, false))">{{ tr('refresh') }}</Button><Button :disabled="busy" @click="recheck">{{ tr('recheck') }}</Button><Button :disabled="busy" @click="selected = null">{{ tr('close') }}</Button></div>
      <p class="break-all text-sm">{{ selected.slug }} · {{ selected.evidence.requestId ?? tr('unknown') }}</p>
      <p class="text-sm text-accent">{{ tr(`checks.${selected.verification}`) }}</p>
      <p v-if="selected.verification === 'unavailable'" class="text-sm text-muted">{{ tr('unavailableHint') }}</p>
      <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm"><div v-for="key in fields" :key="key" class="min-w-0"><dt class="text-xs text-muted">{{ tr(key) }}</dt><dd class="mt-1 break-all">{{ key === 'billingType' ? tr(`types.${selected.evidence.billingType}`) : selected.evidence[key] ?? tr('unknown') }}</dd></div></dl>
      <p class="text-xs text-muted">{{ tr('formula') }}</p><p class="text-xs text-muted">{{ tr('settlementProof') }}</p>
      <form class="space-y-3 border-t border-border pt-4" @submit.prevent="save">
        <label>{{ tr('state') }}<select v-model="decision" :disabled="busy"><option v-for="s in states" :key="s" :value="s" :disabled="s === 'resolved' && !canResolve">{{ tr(`states.${s}`) }}</option></select></label>
        <p class="text-xs text-muted">{{ tr('resolveHint') }}</p>
        <label>{{ tr('note') }}<textarea v-model="note" maxlength="2000" rows="3" required :disabled="busy"></textarea></label>
        <Button type="submit" :disabled="busy || !note.trim()">{{ tr('save') }}</Button>
      </form>
      <h3 class="text-sm font-medium">{{ tr('history') }}</h3>
      <ol class="space-y-3"><li v-for="event in selected.events" :key="event.id" class="border-l-2 border-border pl-3 text-sm"><p>{{ tr(`kinds.${event.kind}`) }} · {{ tr(`states.${event.state}`) }}</p><p class="text-xs text-muted">{{ event.actor }} · {{ event.createdAt }} UTC</p><p v-if="event.note" class="mt-1 whitespace-pre-wrap break-words">{{ event.note }}</p></li></ol>
      <p v-if="selected.historyTruncated" class="text-xs text-muted">{{ tr('historyLimited') }}</p>
    </section>
  </div>
</template>

<style scoped>
label { display: block; font-size: 12px; }
input, select, textarea { display: block; width: 100%; min-width: 0; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg); color: inherit; font: inherit; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
input:disabled, select:disabled, textarea:disabled { opacity: .6; }
th, td { padding: 12px 8px; }
</style>
