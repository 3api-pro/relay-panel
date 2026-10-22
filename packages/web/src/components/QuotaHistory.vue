<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import type { QuotaOperation, PlatformQuotaInput, QuotaWindow } from '../api/types';
import { Button, Field } from './ui';
const props = defineProps<{ slug: string; revision: number }>();
const { locale } = useI18n(), l = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const items = ref<QuotaOperation[]>([]), more = ref(false), busy = ref(false), error = ref('');
const notes = ref<Record<number, string>>({}), acknowledged = ref<Record<number, boolean>>({});
const labels: Record<string, [string, string]> = { preview: ['已预览', 'Previewed'], applying: ['执行结果待核实', 'Write pending verification'], verified: ['配置回读一致', 'Configuration verified'], conflict: ['配置冲突，未写入', 'Conflict, no write'], uncertain: ['结果待复核', 'Needs review'], failed: ['写入前检查失败', 'Preflight failed'], resolved: ['差异已人工处理', 'Difference resolved'] };
const label = (status: string) => labels[status] ? l(...labels[status]) : status;
const amount = (v: number | null | undefined) => v == null ? l('不限', 'Unlimited') : `${v} USD`;
const fields = { daily: 'dailyLimitUsd', weekly: 'weeklyLimitUsd', monthly: 'monthlyLimitUsd' } as const;
const windows: QuotaWindow[] = ['daily', 'weekly', 'monthly'];
const limit = (rows: PlatformQuotaInput[], platform: string, w: QuotaWindow) => amount(rows.find(r => r.platform === platform)?.[fields[w]]);
const platforms = (o: QuotaOperation) => [...new Set([...o.beforeLimits, ...o.requestedLimits, ...(o.observed ?? [])].map(r => r.platform))];
const date = (v: string) => new Date(/[Z+]|-\d\d:\d\d$/.test(v.slice(10)) ? v : v.replace(' ', 'T') + 'Z').toLocaleString();
let generation = 0;
async function load(append = false) {
  const run = ++generation, slug = props.slug;
  busy.value = true; error.value = '';
  try {
    const before = append ? items.value.at(-1)?.id : undefined;
    const r = await get<{ items: QuotaOperation[]; hasMore: boolean }>(`/api/risk/quotas/${encodeURIComponent(slug)}/history${before ? `?before=${before}` : ''}`);
    if (run !== generation) return;
    items.value = append ? [...items.value, ...r.items] : r.items; more.value = r.hasMore;
  } catch (e) { if (run === generation) error.value = String(e); } finally { if (run === generation) busy.value = false; }
}
async function review(o: QuotaOperation, resolve = false) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  const slug = props.slug, run = generation;
  try {
    const r = await post<{ operation: QuotaOperation }>(`/api/risk/quotas/${encodeURIComponent(slug)}/${o.id}/${resolve ? 'resolve' : 'review'}`, resolve ? { observedFingerprint: o.observedFingerprint, note: notes.value[o.id], acknowledgeNoPending: acknowledged.value[o.id] === true } : {});
    if (run !== generation) return;
    items.value = items.value.map(item => item.id === o.id ? r.operation : item);
    acknowledged.value[o.id] = false;
  } catch (e) { if (run === generation) error.value = String(e); } finally { if (run === generation) busy.value = false; }
}
watch(() => [props.slug, props.revision], () => { items.value = []; notes.value = {}; acknowledged.value = {}; void load(); }, { immediate: true });
</script>

<template>
  <div class="space-y-3 border-t border-border pt-4">
    <div class="flex items-center justify-between gap-3"><h3 class="text-sm font-medium">{{ l('限额操作记录', 'Quota operations') }}</h3><Button size="sm" variant="ghost" :disabled="busy" @click="load()">{{ l('刷新记录', 'Refresh') }}</Button></div>
    <p v-if="error" role="alert" class="text-xs text-red">{{ error }}</p>
    <p v-if="!items.length" class="text-xs text-muted">{{ busy ? l('正在读取…', 'Loading…') : l('此站点暂无操作记录。', 'No quota operations for this site.') }}</p>
    <details v-for="o in items" :key="o.id" class="rounded-lg border border-border p-3">
      <summary class="cursor-pointer text-xs leading-6">#{{ o.id }} · {{ l('用户', 'User') }} #{{ o.userId }} · {{ o.change.platform }} · {{ label(o.status) }} · {{ date(o.createdAt) }}</summary>
      <div class="mt-3 space-y-3">
        <p class="text-xs leading-6 text-muted">{{ o.detail || l('预览尚未执行，十分钟内有效。', 'Preview not executed; valid for ten minutes.') }}</p>
        <div class="overflow-x-auto"><table class="w-full min-w-[480px] text-left text-xs"><thead><tr><th class="p-2">{{ l('平台 / 窗口', 'Platform / window') }}</th><th class="p-2">{{ l('写入前', 'Before') }}</th><th class="p-2">{{ l('预期配置', 'Requested') }}</th><th class="p-2">{{ l('最近回读', 'Last read') }}</th></tr></thead><tbody><template v-for="p in platforms(o)" :key="p"><tr v-for="w in windows" :key="w" class="border-t border-border"><td class="p-2">{{ p }} / {{ w === 'monthly' ? l('30 天', '30 days') : w === 'daily' ? l('日', 'Daily') : l('周', 'Weekly') }}</td><td class="p-2">{{ limit(o.beforeLimits, p, w) }}</td><td class="p-2">{{ limit(o.requestedLimits, p, w) }}</td><td class="p-2">{{ o.observed ? amount(o.observed.find(r => r.platform === p)?.[w].limitUsd) : '—' }}</td></tr></template></tbody></table></div>
        <p v-if="o.checkedAt" class="text-xs text-muted">{{ l('回读时间', 'Read at') }}: {{ date(o.checkedAt) }}</p>
        <p v-if="o.resolutionNote" class="whitespace-pre-wrap break-words text-xs">{{ o.resolutionNote }}</p>
        <template v-if="['uncertain', 'applying'].includes(o.status)">
          <p class="text-xs leading-6 text-muted">{{ l('执行开始两分钟后可回读，不会重新写入。若配置仍不同，请先确认引擎没有待执行请求；五分钟后可接受最近回读的配置并记录处理意见。', 'Read back after two minutes without another write. If the configuration differs, check that no engine request remains pending. After five minutes you can accept the latest observed configuration with a review note.') }}</p>
          <Button size="sm" :disabled="busy" @click="review(o)">{{ l('回读复核', 'Read back') }}</Button>
          <form v-if="o.observedFingerprint && o.status === 'uncertain'" class="space-y-3" @submit.prevent="review(o, true)">
            <Field :label="l('差异处理意见', 'Resolution note')"><textarea v-model="notes[o.id]" minlength="10" maxlength="1000" required class="min-h-20 w-full rounded border border-border bg-panel p-2 text-sm" /></Field>
            <label class="flex items-start gap-2 text-xs leading-6"><input v-model="acknowledged[o.id]" type="checkbox" required class="mt-1.5" /><span>{{ l('已确认引擎没有待执行请求，接受上方最近回读的配置；这不表示原写入成功。', 'No engine request remains pending. I accept the last-read configuration above; this does not mark the original write successful.') }}</span></label>
            <Button size="sm" variant="outline" :disabled="busy || !acknowledged[o.id]" type="submit">{{ l('记录处理并关闭差异', 'Record resolution') }}</Button>
          </form>
        </template>
      </div>
    </details>
    <Button v-if="more" :disabled="busy" size="sm" variant="ghost" @click="load(true)">{{ l('更早记录', 'Older operations') }}</Button>
  </div>
</template>
