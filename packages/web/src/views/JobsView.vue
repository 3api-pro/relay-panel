<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListChecks, RefreshCw } from 'lucide-vue-next';
import { get } from '../api/client';
import type { JobResponse, JobsResponse, JobView } from '../api/types';
import { Badge, Button, Drawer, EmptyState, StatusDot, Table } from '../components/ui';
import type { TableColumn } from '../components/ui';

/**
 * 任务中心：GET /api/jobs?limit=100 表格 + 行内 Drawer 详情。
 * - 列表：存在 running/queued 任务时 5s 轮询整表，否则 30s。
 * - Drawer：GET /api/jobs/:id，头部元信息 + steps 时间线；
 *   job 处于 queued/running 时打开期间 2s 轮询该 job，终态停止。
 * 只读视图（无写操作）。
 */
const { t } = useI18n();

// ---- 生命周期卫兵 ----
// setTimeout 轮询在 await 之后自我重排；卸载时若有在途请求，
// 其续体会绕过 onBeforeUnmount 的清理再次挂上定时器，形成永久后台轮询。
// alive 在 onBeforeUnmount 置 false，重排前一律先判 alive。
let alive = true;

// ---- 列表状态 ----
const jobs = ref<JobView[]>([]);
const loading = ref(true);
const loadError = ref('');
let listTimer: number | null = null;

// ---- 详情 / Drawer 状态 ----
const drawerOpen = ref(false);
const detail = ref<JobView | null>(null);
const detailError = ref('');
const activeJobId = ref<number | null>(null);
let detailTimer: number | null = null;

const columns = computed<TableColumn[]>(() => [
  { key: 'kind', label: t('jobs.col.kind'), width: '92px' },
  { key: 'slug', label: t('jobs.col.slug'), mono: true },
  { key: 'status', label: t('jobs.col.status'), width: '128px' },
  { key: 'createdBy', label: t('jobs.col.createdBy') },
  { key: 'createdAt', label: t('jobs.col.createdAt'), width: '112px' },
  { key: 'duration', label: t('jobs.col.duration'), align: 'right', width: '96px' },
]);

// ---- 类型映射 / 格式化 ----
const KNOWN_KINDS = ['provision', 'upgrade', 'start', 'stop', 'destroy'];
function jobKindText(kind: string): string {
  return KNOWN_KINDS.includes(kind) ? t(`jobs.kind.${kind}`) : kind;
}

function parseTime(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}

function relTime(iso: string): string {
  const ts = parseTime(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('jobs.relTime.justNow');
  if (min < 60) return t('jobs.relTime.minAgo', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('jobs.relTime.hourAgo', { n: h });
  return t('jobs.relTime.dayAgo', { n: Math.floor(h / 24) });
}

function fmtDateTime(iso: string): string {
  const t = parseTime(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtClock(iso: string): string {
  const t = parseTime(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 耗时：finishedAt - startedAt；未完成的以「至今」计（随轮询刷新） */
function fmtDuration(job: JobView): string {
  if (!job.startedAt) return '—';
  const start = parseTime(job.startedAt);
  if (Number.isNaN(start)) return '—';
  const end = job.finishedAt ? parseTime(job.finishedAt) : Date.now();
  const ms = Math.max(0, (Number.isNaN(end) ? Date.now() : end) - start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m${pad2(s)}s`;
  const h = Math.floor(m / 60);
  return `${h}h${pad2(m % 60)}m`;
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ---- 步骤状态 → 色调 / 文案 ----
function stepTone(status: string): 'green' | 'red' | 'amber' | 'accent' | 'muted' {
  if (status.startsWith('failed') || status === 'error') return 'red';
  if (status === 'succeeded' || status === 'ok' || status === 'done' || status === 'completed') return 'green';
  if (status === 'running') return 'accent';
  if (status === 'queued' || status === 'pending' || status === 'provisioning') return 'amber';
  return 'muted';
}
function stepStatusText(status: string): string {
  if (status.startsWith('failed') || status === 'error') return t('jobs.step.failed');
  if (status === 'succeeded' || status === 'ok' || status === 'done' || status === 'completed') return t('jobs.step.done');
  if (status === 'running') return t('jobs.step.running');
  if (status === 'queued' || status === 'pending') return t('jobs.step.queued');
  if (status === 'provisioning') return t('jobs.step.provisioning');
  if (status === 'skipped') return t('jobs.step.skipped');
  return status;
}
function stepTextClass(status: string): string {
  const tone = stepTone(status);
  if (tone === 'red') return 'text-red/90';
  if (tone === 'green') return 'text-green/90';
  if (tone === 'accent') return 'text-accent';
  if (tone === 'amber') return 'text-amber';
  return 'text-muted/70';
}

// ---- Table 行桥接（Table 行类型为 Record<string, unknown>）----
const tableRows = computed<Record<string, unknown>[]>(
  () => jobs.value as unknown as Record<string, unknown>[],
);
function asJob(row: Record<string, unknown>): JobView {
  return row as unknown as JobView;
}

// ---- 列表加载与轮询 ----
const hasActiveJobs = computed(() =>
  jobs.value.some((j) => j.status === 'running' || j.status === 'queued'),
);

async function refreshList(initial = false): Promise<void> {
  if (initial) loading.value = true;
  try {
    const res = await get<JobsResponse>('/api/jobs', { silent: true, query: { limit: 100 } });
    jobs.value = Array.isArray(res?.jobs) ? res.jobs : [];
    loadError.value = '';
  } catch (err) {
    if (initial) loadError.value = err instanceof Error ? err.message : t('jobs.loadFailed');
  } finally {
    if (initial) loading.value = false;
  }
}

function scheduleListPoll(): void {
  if (!alive) return;
  if (listTimer !== null) window.clearTimeout(listTimer);
  const delay = hasActiveJobs.value ? 5_000 : 30_000;
  listTimer = window.setTimeout(() => {
    void (async () => {
      await refreshList();
      if (alive) scheduleListPoll();
    })();
  }, delay);
}

async function manualRefresh(): Promise<void> {
  await refreshList(true);
  scheduleListPoll();
  if (activeJobId.value !== null) void loadDetail(activeJobId.value);
}

// ---- 详情加载与轮询 ----
async function loadDetail(id: number, initial = false): Promise<void> {
  if (initial) detailError.value = '';
  try {
    const res = await get<JobResponse>(`/api/jobs/${id}`, { silent: true });
    // 详情返回后可能 Drawer 已切走，丢弃过期响应
    if (activeJobId.value === id) {
      detail.value = res.job;
      detailError.value = '';
    }
  } catch (err) {
    if (activeJobId.value === id && !detail.value) {
      detailError.value = err instanceof Error ? err.message : t('jobs.loadFailed');
    }
  }
  if (alive) scheduleDetailPoll(id);
}

function scheduleDetailPoll(id: number): void {
  if (detailTimer !== null) {
    window.clearTimeout(detailTimer);
    detailTimer = null;
  }
  if (!alive || !drawerOpen.value || activeJobId.value !== id) return;
  const st = detail.value?.status;
  if (st === 'queued' || st === 'running') {
    detailTimer = window.setTimeout(() => {
      void loadDetail(id);
    }, 2_000);
  }
}

function openDrawer(row: Record<string, unknown>): void {
  const job = asJob(row);
  activeJobId.value = job.id;
  detail.value = job; // 用列表行数据先渲染，详情拉取后覆盖
  detailError.value = '';
  drawerOpen.value = true;
  void loadDetail(job.id, true);
}

const detailPolling = computed(
  () => detail.value?.status === 'queued' || detail.value?.status === 'running',
);
const drawerTitle = computed(() =>
  detail.value ? t('jobs.detail.titleWithId', { id: detail.value.id }) : t('jobs.detail.title'),
);

// Drawer 关闭时停止轮询并清理状态
watch(drawerOpen, (open) => {
  if (!open) {
    if (detailTimer !== null) {
      window.clearTimeout(detailTimer);
      detailTimer = null;
    }
    activeJobId.value = null;
    detail.value = null;
    detailError.value = '';
  }
});

onMounted(() => {
  void (async () => {
    await refreshList(true);
    scheduleListPoll();
  })();
});
onBeforeUnmount(() => {
  alive = false;
  if (listTimer !== null) window.clearTimeout(listTimer);
  if (detailTimer !== null) window.clearTimeout(detailTimer);
});
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 页头 -->
    <header class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5">
        <ListChecks :size="18" class="text-muted" />
        <div>
          <h1 class="text-[15px] font-semibold leading-tight">{{ t('jobs.title') }}</h1>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('jobs.subtitle') }}
            <span v-if="hasActiveJobs" class="ml-1 inline-flex items-center">
              <StatusDot tone="accent" pulse :label="t('jobs.activePolling')" />
            </span>
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" @click="manualRefresh">
        <RefreshCw :size="14" />
        {{ t('common.refresh') }}
      </Button>
    </header>

    <!-- 列表 -->
    <div v-if="loadError && jobs.length === 0" class="rp-panel p-8">
      <EmptyState :title="t('jobs.loadFailed')" :description="loadError">
        <Button variant="outline" size="sm" @click="manualRefresh">{{ t('common.retry') }}</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table
        :columns="columns"
        :rows="tableRows"
        row-key="id"
        :loading="loading"
        :empty="t('jobs.emptyList')"
        clickable
        @row-click="openDrawer"
      >
        <template #cell-kind="{ row }">
          <Badge tone="muted" size="sm">{{ jobKindText(asJob(row).kind) }}</Badge>
        </template>
        <template #cell-status="{ row }">
          <StatusDot :status="asJob(row).status" />
        </template>
        <template #cell-createdBy="{ row }">
          <span class="text-muted">{{ asJob(row).createdBy || '—' }}</span>
        </template>
        <template #cell-createdAt="{ row }">
          <span class="text-muted" :title="fmtDateTime(asJob(row).createdAt)">
            {{ relTime(asJob(row).createdAt) }}
          </span>
        </template>
        <template #cell-duration="{ row }">
          <span class="tnum text-muted">{{ fmtDuration(asJob(row)) }}</span>
        </template>
      </Table>
    </div>

    <!-- 详情 Drawer -->
    <Drawer v-model:open="drawerOpen" :title="drawerTitle" width="520px">
      <div v-if="detail" class="space-y-5">
        <!-- 头部元信息 -->
        <section class="rp-panel p-4">
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              <Badge tone="accent" size="sm">{{ jobKindText(detail.kind) }}</Badge>
              <span class="truncate font-mono text-xs text-muted">{{ detail.slug || '—' }}</span>
            </div>
            <StatusDot :status="detail.status" />
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border/60 pt-3 text-xs">
            <div class="min-w-0">
              <dt class="text-muted/70">{{ t('jobs.detail.createdBy') }}</dt>
              <dd class="mt-0.5 truncate">{{ detail.createdBy || '—' }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-muted/70">{{ t('jobs.detail.duration') }}</dt>
              <dd class="tnum mt-0.5">{{ fmtDuration(detail) }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-muted/70">{{ t('jobs.detail.createdAt') }}</dt>
              <dd class="tnum mt-0.5">{{ fmtDateTime(detail.createdAt) }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-muted/70">{{ t('jobs.detail.finishedAt') }}</dt>
              <dd class="tnum mt-0.5">{{ detail.finishedAt ? fmtDateTime(detail.finishedAt) : '—' }}</dd>
            </div>
          </dl>
        </section>

        <!-- 拉取失败提示（保留已有内容） -->
        <p v-if="detailError" class="text-xs text-amber">
          {{ t('jobs.detail.refreshFailed', { msg: detailError }) }}
        </p>

        <!-- 失败错误 -->
        <section v-if="detail.error" class="rounded-panel border border-red/40 bg-red/10 p-3">
          <p class="rp-microlabel text-red">{{ t('jobs.detail.errorLabel') }}</p>
          <p class="mt-1 whitespace-pre-wrap break-words text-xs text-red/90">{{ detail.error }}</p>
        </section>

        <!-- 步骤时间线 -->
        <section>
          <div class="mb-3 flex items-center gap-2">
            <p class="rp-microlabel">{{ t('jobs.detail.stepsLabel') }}</p>
            <StatusDot v-if="detailPolling" tone="accent" pulse :label="t('jobs.detail.liveRefresh')" />
          </div>

          <ol v-if="detail.steps.length > 0">
            <li
              v-for="(s, i) in detail.steps"
              :key="`${s.step}-${i}`"
              class="flex gap-3"
            >
              <!-- 竖线 + 圆点 -->
              <div class="flex flex-col items-center pt-1">
                <StatusDot :tone="stepTone(s.status)" :pulse="s.status === 'running'" />
                <span
                  v-if="i < detail.steps.length - 1"
                  class="mt-1.5 w-px flex-1 bg-border/70"
                />
              </div>
              <!-- 内容 -->
              <div class="min-w-0 flex-1 pb-4">
                <div class="flex items-start justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-[13px] font-medium">{{ s.step }}</span>
                    <span class="shrink-0 text-[11px]" :class="stepTextClass(s.status)">
                      {{ stepStatusText(s.status) }}
                    </span>
                  </div>
                  <span class="tnum shrink-0 text-[11px] text-muted/70">{{ fmtClock(s.at) }}</span>
                </div>
                <p v-if="s.detail" class="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted">
                  {{ s.detail }}
                </p>
              </div>
            </li>
          </ol>
          <p v-else class="text-xs text-muted">{{ t('jobs.detail.noSteps') }}</p>
        </section>
      </div>

      <!-- 无详情且拉取失败 -->
      <div v-else-if="detailError" class="pt-6">
        <EmptyState :title="t('jobs.loadFailed')" :description="detailError" />
      </div>

      <template #footer>
        <Button variant="ghost" size="sm" @click="drawerOpen = false">{{ t('common.close') }}</Button>
      </template>
    </Drawer>
  </div>
</template>
