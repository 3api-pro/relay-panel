<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { get } from '../../api/client';
import { Button, Drawer, EmptyState, StatusDot, Table, type TableColumn } from '../../components/ui';
import type { JobsResponse, JobView } from './types';
import { fmtDateTime, jobKindText, relTime } from './format';

/** 任务页：列表 + 步骤时间线抽屉；存在进行中任务时 2s 轮询。 */
const props = defineProps<{ slug: string }>();

const jobs = ref<JobView[]>([]);
const loading = ref(true);
const loadError = ref('');
const selectedId = ref<number | null>(null);

async function load(initial = false): Promise<void> {
  if (initial) loading.value = true;
  try {
    const res = await get<JobsResponse>('/api/jobs', {
      silent: true,
      query: { slug: props.slug, limit: 50 },
    });
    jobs.value = Array.isArray(res.jobs) ? res.jobs : [];
    loadError.value = '';
  } catch (err) {
    if (initial) loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    if (initial) loading.value = false;
  }
}

const hasRunning = computed(() =>
  jobs.value.some((j) => j.status === 'running' || j.status === 'queued' || j.status === 'pending'),
);

let timer: number | null = null;
onMounted(() => {
  void load(true);
  timer = window.setInterval(() => {
    if (hasRunning.value) void load();
  }, 2000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

const rows = computed(() => jobs.value as unknown as Record<string, unknown>[]);
function asJob(row: Record<string, unknown>): JobView {
  return row as unknown as JobView;
}
const selectedJob = computed(() => jobs.value.find((j) => j.id === selectedId.value) ?? null);

const columns: TableColumn[] = [
  { key: 'kind', label: '类型' },
  { key: 'status', label: '状态' },
  { key: 'createdBy', label: '创建者' },
  { key: 'createdAt', label: '创建时间', align: 'right' },
];
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted">
        共 <span class="tnum text-text">{{ jobs.length }}</span> 条任务
        <span v-if="hasRunning" class="ml-2 text-accent">· 有进行中任务，自动刷新中</span>
      </p>
    </div>

    <div v-if="loadError" class="rp-panel p-8">
      <EmptyState title="加载失败" :description="loadError">
        <Button size="sm" @click="load(true)">重试</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table
        :columns="columns"
        :rows="rows"
        row-key="id"
        :loading="loading"
        empty="暂无任务"
        clickable
        @row-click="(row) => (selectedId = asJob(row).id)"
      >
        <template #cell-kind="{ row }">
          <span class="font-medium">{{ jobKindText(asJob(row).kind) }}</span>
        </template>
        <template #cell-status="{ row }">
          <StatusDot :status="asJob(row).status" />
        </template>
        <template #cell-createdBy="{ row }">
          <span class="text-muted">{{ asJob(row).createdBy || '—' }}</span>
        </template>
        <template #cell-createdAt="{ row }">
          <span class="tnum text-muted">{{ relTime(asJob(row).createdAt) }}</span>
        </template>
      </Table>
    </div>

    <Drawer :open="selectedId !== null" width="520px" @update:open="selectedId = null">
      <template #title>
        <div v-if="selectedJob" class="flex items-center gap-2">
          <h2 class="text-sm font-semibold">{{ jobKindText(selectedJob.kind) }}任务 · #{{ selectedJob.id }}</h2>
          <StatusDot :status="selectedJob.status" />
        </div>
        <h2 v-else class="text-sm font-semibold">任务详情</h2>
      </template>

      <div v-if="selectedJob" class="space-y-5">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
          <div>
            <dt class="rp-microlabel">创建者</dt>
            <dd class="mt-0.5">{{ selectedJob.createdBy || '—' }}</dd>
          </div>
          <div>
            <dt class="rp-microlabel">站点</dt>
            <dd class="mt-0.5 font-mono text-xs">{{ selectedJob.slug }}</dd>
          </div>
          <div>
            <dt class="rp-microlabel">创建时间</dt>
            <dd class="tnum mt-0.5">{{ fmtDateTime(selectedJob.createdAt) }}</dd>
          </div>
          <div>
            <dt class="rp-microlabel">结束时间</dt>
            <dd class="tnum mt-0.5">{{ selectedJob.finishedAt ? fmtDateTime(selectedJob.finishedAt) : '—' }}</dd>
          </div>
        </dl>

        <div
          v-if="selectedJob.error"
          class="rounded-lg border border-red/25 bg-red/8 px-3 py-2.5 text-xs leading-relaxed text-red/90"
        >
          {{ selectedJob.error }}
        </div>

        <div>
          <p class="rp-microlabel mb-3">执行步骤</p>
          <ol v-if="selectedJob.steps.length > 0" class="relative space-y-4 border-l border-border pl-5">
            <li v-for="(s, i) in selectedJob.steps" :key="i" class="relative">
              <span class="absolute -left-[22px] top-0.5">
                <StatusDot :status="s.status" />
              </span>
              <div class="flex items-center justify-between gap-2">
                <span class="text-[13px] font-medium">{{ s.step }}</span>
                <span class="tnum shrink-0 text-xs text-muted/70">{{ relTime(s.at) }}</span>
              </div>
              <p v-if="s.detail" class="mt-0.5 break-all text-xs leading-relaxed text-muted">{{ s.detail }}</p>
            </li>
          </ol>
          <p v-else class="text-xs text-muted">暂无步骤记录。</p>
        </div>
      </div>

      <template #footer>
        <Button variant="ghost" @click="selectedId = null">关闭</Button>
      </template>
    </Drawer>
  </div>
</template>
