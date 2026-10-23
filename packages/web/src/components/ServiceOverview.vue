<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, CircleCheck, CircleHelp, RefreshCw, ArrowRight, Activity, ListTodo, ScanSearch, Layers } from 'lucide-vue-next';
import { Button, Badge } from './ui';
import { serviceStatus, evidenceTime, type ServiceReport, type ServiceWork } from '../serviceStatus';
const props = defineProps<{ report: ServiceReport | null; works: ServiceWork[]; hasMore: boolean; siteStatus?: string | undefined; slug?: string | undefined; loading: boolean; failed: boolean; busy: boolean; day: string; now: number; canWrite: boolean }>();
const emit = defineEmits<{ (event: 'refresh' | 'collect' | 'signals' | 'work' | 'quality'): void }>();
const { locale } = useI18n();
const l = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const state = computed(() => serviceStatus(props));
const messages = computed<Record<string, [string, string]>>(() => ({
  loading: [l('正在读取状态', 'Reading status'), l('正在汇总今日请求与处理事项…', 'Loading today’s requests and work queue…')],
  unavailable: [l('状态读取失败', 'Status unavailable'), l('暂时无法读取面板数据，请刷新重试。', 'Panel data could not be loaded. Try refreshing.')],
  inactive: [l('站点尚未就绪', 'Site not ready'), l('该站点尚未处于启用状态，请先检查安装或站点配置。', 'This site is not active. Check its installation or configuration.')],
  'day-changed': [l('今日状态待更新', 'Refresh today’s status'), l('日期已切换，刷新后查看今天的数据。', 'A new day has started. Refresh to load today’s evidence.')],
  signals: [l('发现异常线索', 'Issues detected'), l(`今日已读取的日志中，${state.value.flagged} 条记录需要核查，涉及 ${state.value.affected} 个渠道 / 模型。`, `${state.value.flagged} collected records need review across ${state.value.affected} channel / model groups today.`)],
  incident: [l('有故障事项待处理', 'Incidents need attention'), l('存在尚未解决的故障事项，请查看处理进展与验证结果。', 'Unresolved incident cases need follow-up and verification.')],
  'collection-error': [l('状态待确认', 'Status unconfirmed'), l('日志读取失败，当前无法判断请求状态。请重试或检查站点权限。', 'Log collection failed. Retry or check site permissions to assess requests.')],
  unsupported: [l('状态待确认', 'Status unconfirmed'), l('当前站点的日志接口暂不兼容，请检查引擎版本与接入配置。', 'The log interface is unsupported. Check the engine version and connection settings.')],
  changed: [l('状态待确认', 'Status unconfirmed'), l('源日志发生变化，本轮数据尚未完整。可重新读取已有日志。', 'Source logs changed before collection completed. Read the logs again.')],
  empty: [l('暂无请求数据', 'No request evidence'), l('今天尚无可用于判断的请求记录；没有请求不代表服务正常或故障。', 'No request evidence is available today. No traffic does not establish health or failure.')],
  stale: [l('状态待确认', 'Status unconfirmed'), l('最近请求或日志更新已超过 30 分钟，当前状态需要新的证据。', 'The latest request or log update is over 30 minutes old. Current status needs newer evidence.')],
  partial: [l('状态待确认', 'Status unconfirmed'), l('已读取的日志暂未发现异常，但本轮还未读完。继续读取可补全判断依据。', 'No issues found in collected logs so far, but collection is incomplete. Read the next batch for more evidence.')],
  limited: [l('状态待确认', 'Status unconfirmed'), l('已达到日志样本上限，请按渠道或模型查看；当前数据不能代表完整情况。', 'The sample limit was reached. Filter by channel or model; these logs do not cover the full scope.')],
  coverage: [l('状态待确认', 'Status unconfirmed'), l('已读取的消费记录暂未发现异常，但来源不覆盖全部失败请求。', 'No issues found in the collected consumption records, but the source does not cover all failed requests.')],
  work: [l('有事项待跟进', 'Work needs follow-up'), l('已观测请求暂未发现异常，还有未完成的服务事项。', 'No issues found in observed requests. Service work still needs follow-up.')],
  clear: [l('暂未发现异常', 'No issues observed'), l('近期请求证据有效，今日已读取的消费与错误日志中未发现异常线索。', 'Recent evidence is available. No issues were found in today’s collected consumption and error logs.')],
}));
const message = computed(() => messages.value[state.value.reason]!);
const icon = computed(() => state.value.tone === 'red' || state.value.tone === 'amber' ? AlertTriangle : state.value.tone === 'green' ? CircleCheck : CircleHelp);
const action = computed(() => state.value.action === 'collect' && !props.canWrite ? 'refresh' : state.value.action);
const actionText = computed(() => ({ refresh: l('刷新状态', 'Refresh status'), collect: l('读取已有日志', 'Read existing logs'), signals: l('查看异常线索', 'Review issues'), work: l('查看待处理事项', 'Review pending work'), quality: l('查看请求明细', 'View request details'), site: l('检查站点', 'Check site') })[action.value]);
function act() { if (action.value !== 'site') emit(action.value); }
const updated = computed(() => { const time = evidenceTime(props.report?.run?.updatedAt);return Number.isFinite(time) ? new Intl.DateTimeFormat(locale.value.startsWith('zh') ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '—'; });
const hiddenMetrics = computed(() => props.loading || props.failed || !props.report || state.value.reason === 'day-changed');
const metrics = computed(() => [
  { icon: Activity, label: l('已观测请求', 'Observed requests'), value: hiddenMetrics.value ? '—' : state.value.records.toLocaleString(), hint: l('今日已读取的日志样本', 'Today’s collected log samples'), tone: '' },
  { icon: ScanSearch, label: l('异常线索', 'Flagged records'), value: hiddenMetrics.value || !state.value.records ? '—' : state.value.flagged.toLocaleString(), hint: l('错误记录或费用复核线索', 'Errors or billing review signals'), tone: state.value.flagged ? 'text-red' : '' },
  { icon: Layers, label: l('涉及渠道 / 模型', 'Affected channel / model groups'), value: hiddenMetrics.value || !state.value.records ? '—' : String(state.value.affected), hint: l('有异常线索的分组', 'Groups containing flagged records'), tone: state.value.affected ? 'text-red' : '' },
  { icon: ListTodo, label: props.hasMore ? l('待处理事项（已加载）', 'Pending work (loaded)') : l('待处理事项', 'Pending work'), value: hiddenMetrics.value ? '—' : `${state.value.pending}${props.hasMore ? '+' : ''}`, hint: props.hasMore ? l('还有更多事项未加载', 'More cases are not loaded') : state.value.urgent ? l(`${state.value.urgent} 项紧急`, `${state.value.urgent} urgent`) : l('包含待处理、处理中和等待材料', 'Open, in progress or awaiting information'), tone: state.value.pending ? 'text-amber' : '' },
]);
</script>
<template>
  <section aria-live="polite" :aria-label="l('今日服务概览','Today’s service overview')" class="space-y-3" :data-status="state.reason">
    <div class="service-health rounded-xl border p-4 sm:p-5" :class="`health-${state.tone}`">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <div class="health-icon flex size-11 shrink-0 items-center justify-center rounded-xl"><component :is="loading ? RefreshCw : icon" :size="23" :class="{'animate-spin':loading}" aria-hidden="true" /></div>
          <div class="min-w-0"><p class="text-xs text-muted">{{ l('今日服务概览','Today’s service overview') }} · {{ day }} {{ l('北京时间','Beijing time') }}</p><h2 class="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{{ message[0] }}</h2><p class="mt-2 max-w-2xl text-sm leading-6 text-muted">{{ message[1] }}</p></div>
        </div>
        <RouterLink v-if="action==='site'" :to="`/sites/${slug}`" class="inline-flex items-center gap-1 rounded-lg border border-border bg-panel px-3 py-2 text-sm">{{actionText}}<ArrowRight :size="14" aria-hidden="true" /></RouterLink>
        <Button v-else :disabled="busy||loading" @click="act">{{actionText}}<ArrowRight :size="14" aria-hidden="true" /></Button>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-current/10 pt-3 text-xs text-muted">
        <span>{{ l('日志更新','Logs updated') }} {{ updated }} {{ l('北京时间','Beijing time') }}</span>
        <Badge :tone="report?.sourceScope==='consume-and-error-logs'?'muted':'amber'" size="sm">{{ report?.sourceScope==='consume-and-error-logs'?l('消费与错误日志','Consumption & error logs'):report?.sourceScope==='consumption-only'?l('仅消费记录','Consumption records only'):l('暂无可用来源','No evidence source') }}</Badge>
        <span>{{l('依据已有日志判断，不额外调用模型','Based on existing logs; no extra model calls')}}</span>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4"><div v-for="metric in metrics" :key="metric.label" class="rp-panel min-w-0 p-4"><div class="flex items-start justify-between gap-2"><p class="text-xs text-muted">{{metric.label}}</p><component :is="metric.icon" :size="16" class="shrink-0 text-muted" aria-hidden="true" /></div><p class="mt-2 text-2xl font-semibold tabular-nums" :class="metric.tone">{{metric.value}}</p><p class="mt-2 text-xs leading-5 text-muted">{{metric.hint}}</p></div></div>
  </section>
</template>
<style scoped>
.service-health{background:var(--color-panel);border-color:var(--glass-border)}
.health-amber{background:linear-gradient(110deg,color-mix(in srgb,var(--color-amber) 8%,var(--color-panel)),var(--color-panel));border-color:color-mix(in srgb,var(--color-amber) 32%,transparent)}
.health-red{background:linear-gradient(110deg,color-mix(in srgb,var(--color-red) 8%,var(--color-panel)),var(--color-panel));border-color:color-mix(in srgb,var(--color-red) 32%,transparent)}
.health-green{background:linear-gradient(110deg,color-mix(in srgb,var(--color-green) 8%,var(--color-panel)),var(--color-panel));border-color:color-mix(in srgb,var(--color-green) 32%,transparent)}
.health-icon{background:var(--color-panel-2);color:var(--color-muted)}
.health-amber .health-icon{color:var(--color-amber);background:color-mix(in srgb,var(--color-amber) 12%,transparent)}
.health-red .health-icon{color:var(--color-red);background:color-mix(in srgb,var(--color-red) 12%,transparent)}
.health-green .health-icon{color:var(--color-green);background:color-mix(in srgb,var(--color-green) 12%,transparent)}
</style>
