<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import { Button, Card, Field, Input, Select } from '../components/ui';
const { locale } = useI18n();
const l = (zh: string, en: string): string => locale.value.startsWith('zh') ? zh : en;
interface Run { id: number; siteId: number; supplier: string; invoiceRef: string; invoiceAmount: number; fromDate: string; toDate: string; status: string; nextPage: number; version: number }
interface Summary { scannedRows: number; selectedRows: number; knownCostRows: number; observedCost: number; invoiceDifference: number | null; estimatedShortfall: number; estimableRows: number; costComplete: boolean }
const sites = ref<{ id: number; label: string; engine: string }[]>([]), runs = ref<Run[]>([]);
const siteId = ref<string | number | null>(null), supplier = ref(''), invoiceRef = ref(''), amount = ref<number | string>(''), accountId = ref('');
const from = ref(''), to = ref(''), note = ref(''), selected = ref<Run | null>(null), summary = ref<Summary | null>(null);
const userId = ref(''), model = ref(''), rate = ref<number | string>(''), rateFrom = ref(''), rateTo = ref(''), rateNote = ref('');
const busy = ref(false), error = ref('');
const rates = ref<{ id: number; userId: string; model: string; multiplier: number; fromAt: string; toAt: string; voidedAt: string | null }[]>([]);
const correctionReason = ref('');
async function loadRates(): Promise<void> { rates.value = siteId.value ? (await get<{ rates: typeof rates.value }>(`/api/admin/reconciliation/rates?siteId=${siteId.value}`)).rates : []; }
watch(siteId, () => { void action(loadRates); });
async function voidRate(id: number): Promise<void> { await action(async () => { await post(`/api/admin/reconciliation/rates/${id}/void`, { reason: correctionReason.value }); await loadRates(); if (selected.value) await open(selected.value); }); }
async function restart(): Promise<void> { if (!selected.value) return; await action(async () => { const r = await post<{ run: Run }>(`/api/admin/reconciliation/${selected.value!.id}/restart`, { version: selected.value!.version, note: correctionReason.value }); await load(); await open(r.run); }); }

async function load(): Promise<void> {
  try { const [s, r] = await Promise.all([get<{ sites: typeof sites.value }>('/api/admin/finance-review/sites'), get<{ runs: Run[] }>('/api/admin/reconciliation')]); sites.value = s.sites; runs.value = r.runs; }
  catch (e) { error.value = String(e); }
}
onMounted(load);
async function open(run: Run): Promise<void> { const result = await get<{ run: Run; summary: Summary }>(`/api/admin/reconciliation/${run.id}`); selected.value = result.run; summary.value = result.summary; }
async function action(fn: () => Promise<void>): Promise<void> { busy.value = true; error.value = ''; try { await fn(); } catch (e) { error.value = String(e); } finally { busy.value = false; } }
async function create(): Promise<void> { await action(async () => { const r = await post<{ run: Run }>('/api/admin/reconciliation', { siteId: Number(siteId.value), supplier: supplier.value, invoiceRef: invoiceRef.value,
  invoiceAmount: Number(amount.value), currency: 'USD', from: from.value, to: to.value, note: note.value, ...(accountId.value ? { accountId: accountId.value } : {}) }); await load(); await open(r.run); }); }
async function scan(): Promise<void> { if (!selected.value) return; const id = selected.value.id; await action(async () => { await post(`/api/admin/reconciliation/${id}/scan`); await load(); await open(selected.value!); }); }
async function saveRate(): Promise<void> { await action(async () => { await post('/api/admin/reconciliation/rates', { siteId: Number(siteId.value), userId: userId.value, model: model.value,
  from: rateFrom.value, to: rateTo.value, multiplier: Number(rate.value), note: rateNote.value }); rateNote.value = ''; await loadRates(); if (selected.value) await open(selected.value); }); }
const number = (n: number | null): string => n === null ? '—' : n.toFixed(6);
</script>
<template><div class="rp-page space-y-5">
  <h1 class="text-lg font-semibold">{{ l('供应商对账与历史费率','Supplier reconciliation & historical rates') }}</h1>
  <p class="text-sm leading-6 text-muted">{{ l('对比已结束日期的 USD 供应商账单与引擎请求记录。日期采用北京时间。记录缺失、费率冲突或扫描未完成时，不给出完整对账结论；请求记录不能证明钱包实际扣款。','Compare closed-period USD supplier invoices with engine request logs. Dates use Asia/Shanghai. Missing records, conflicting rates and incomplete scans prevent a complete result. Logs do not prove wallet settlement.') }}</p>
  <p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
  <Card><template #title>{{ l('新建对账任务','New reconciliation') }}</template><form class="grid gap-3 sm:grid-cols-2" @submit.prevent="create">
    <Field :label="l('站点（Sub2API 请求明细）','Site (Sub2API request records)')"><Select v-model="siteId" :options="sites.filter(s => s.engine === 'sub2api').map(s => ({ value: s.id, label: s.label }))" /></Field>
    <Field :label="l('供应商名称','Supplier')"><Input v-model="supplier" required /></Field>
    <Field :label="l('账单编号','Invoice reference')"><Input v-model="invoiceRef" required /></Field>
    <Field :label="l('账单金额（USD）','Invoice amount (USD)')"><Input v-model="amount" type="number" step="0.000001" min="0" required /></Field>
    <Field :label="l('开始日期（含）','First date (inclusive)')"><Input v-model="from" type="date" required /></Field>
    <Field :label="l('结束日期（含）','Last date (inclusive)')"><Input v-model="to" type="date" required /></Field>
    <Field :label="l('上游账号 ID（留空为全站）','Upstream account ID (empty for entire site)')"><Input v-model="accountId" /></Field>
    <Field :label="l('账单范围、币种和来源依据','Invoice scope, currency and source evidence')"><Input v-model="note" required minlength="5" maxlength="2000" /></Field>
    <Button type="submit" :loading="busy">{{ l('建立对账','Create reconciliation') }}</Button>
  </form></Card>
  <Card><template #title>{{ l('对账记录','Reconciliations') }}</template><div class="flex flex-wrap gap-2"><Button v-for="r in runs" :key="r.id" variant="outline" @click="action(() => open(r))">#{{ r.id }} {{ r.supplier }} · {{ r.invoiceRef }}</Button></div></Card>
  <Card v-if="selected && summary"><template #title>#{{ selected.id }} · {{ selected.supplier }}</template><div class="space-y-4 text-sm">
    <p>{{ selected.fromDate }} → {{ selected.toDate }} · USD · {{ selected.status }}</p>
    <div class="grid gap-3 sm:grid-cols-2"><p>{{ l('已扫描记录','Scanned records') }}：{{ summary.scannedRows }}</p><p>{{ l('已知成本 / 所选记录','Known costs / selected records') }}：{{ summary.knownCostRows }} / {{ summary.selectedRows }}</p><p>{{ l('记录中的上游成本','Observed supplier cost') }}：{{ number(summary.observedCost) }}</p><p>{{ l('账单减记录成本（完整时）','Invoice minus observed cost (complete only)') }}：{{ number(summary.invoiceDifference) }}</p><p>{{ l('少计费估算（不是欠款）','Estimated underbilling (not a debt)') }}：{{ number(summary.estimatedShortfall) }}</p><p>{{ l('可估算记录数','Records eligible for estimation') }}：{{ summary.estimableRows }}</p></div>
    <p v-if="!summary.costComplete" class="text-amber">{{ l('数据尚不完整，不能据此判定全部损失或供应商差错。','Coverage is incomplete; do not infer total losses or supplier errors.') }}</p>
    <Button v-if="selected.status === 'scanning'" :loading="busy" @click="scan">{{ l('扫描下一页','Scan next page') }} · {{ selected.nextPage }}</Button>
    <div v-if="selected.status !== 'complete'" class="space-y-2"><Field :label="l('重新扫描原因（清除本轮未完成记录）','Reason to restart (clears this incomplete scan)')"><Input v-model="correctionReason" minlength="5" /></Field><Button variant="outline" :disabled="correctionReason.trim().length < 5" :loading="busy" @click="restart">{{ l('重新扫描','Restart scan') }}</Button></div>
    <a :href="`/api/admin/reconciliation/${selected.id}/export.csv`" class="ml-4 text-accent">{{ l('下载逐请求核对 CSV','Download request-level CSV') }} ↓</a>
  </div></Card>
  <Card><template #title>{{ l('登记历史费率依据','Record historical rate evidence') }}</template><p class="mb-3 text-xs text-muted">{{ l('对应上方所选站点。指定用户、模型和准确时间范围；使用带时区的 ISO 时间，例如 2026-10-20T00:00:00+08:00。费率仅用于估算，不修改引擎或客户余额。','Applies to the site selected above. Specify a user, model and exact interval with ISO timestamps including an offset. Rates are used for estimates only; engine settings and balances are not modified.') }}</p>
    <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="saveRate"><Field :label="l('用户 ID','User ID')"><Input v-model="userId" required /></Field><Field :label="l('模型名称','Model')"><Input v-model="model" required /></Field><Field :label="l('生效时间（含）','Effective from (inclusive)')"><Input v-model="rateFrom" required /></Field><Field :label="l('截止时间（不含）','Effective until (exclusive)')"><Input v-model="rateTo" required /></Field><Field :label="l('计费倍率','Billing multiplier')"><Input v-model="rate" type="number" step="0.000001" min="0" required /></Field><Field :label="l('依据说明','Source evidence')"><Input v-model="rateNote" required minlength="5" /></Field><Button type="submit" :loading="busy" :disabled="!siteId">{{ l('保存历史费率','Save rate') }}</Button></form>
    <div class="mt-4 space-y-3"><Field :label="l('更正原因（作废错误费率时必填）','Correction reason (required to void a rate)')"><Input v-model="correctionReason" minlength="5" /></Field><div v-for="r in rates" :key="r.id" class="flex flex-wrap items-center gap-2 text-xs"><span>#{{ r.id }} · {{ r.userId }} / {{ r.model }} · {{ r.multiplier }} · {{ r.fromAt }} → {{ r.toAt }} UTC</span><span v-if="r.voidedAt">{{ l('已作废','Voided') }}</span><Button v-else variant="outline" :disabled="correctionReason.trim().length < 5" :loading="busy" @click="voidRate(r.id)">{{ l('作废','Void') }}</Button></div></div>
  </Card>
</div></template>
