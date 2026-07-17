<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Button, Drawer, EmptyState, StatusDot, Table, type TableColumn } from '../../components/ui';
import { get } from '../../api/client';
import type { SiteAuditEvent, SiteAuditResponse } from './types';
import { fmtDateTime, relTime } from './format';

/** 审计页：最近 50 条事件；点击行查看 payload 详情（默认折叠在抽屉内）。 */
const props = defineProps<{ slug: string }>();

const events = ref<SiteAuditEvent[]>([]);
const loading = ref(true);
const loadError = ref('');
const selectedId = ref<string | number | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteAuditResponse>(`/api/sites/${props.slug}/audit`, {
      silent: true,
      query: { limit: 50 },
    });
    events.value = Array.isArray(res.events) ? res.events : [];
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const rows = computed(() => events.value as unknown as Record<string, unknown>[]);
function asEvent(row: Record<string, unknown>): SiteAuditEvent {
  return row as unknown as SiteAuditEvent;
}
const selectedEvent = computed(() => events.value.find((e) => e.id === selectedId.value) ?? null);

const columns: TableColumn[] = [
  { key: 'action', label: '动作' },
  { key: 'ok', label: '结果' },
  { key: 'actor', label: '操作者' },
  { key: 'createdAt', label: '时间', align: 'right' },
];

function payloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-muted">
      最近 <span class="tnum text-text">{{ events.length }}</span> 条操作记录
    </p>

    <div v-if="loadError" class="rp-panel p-8">
      <EmptyState title="加载失败" :description="loadError">
        <Button size="sm" @click="load">重试</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table
        :columns="columns"
        :rows="rows"
        row-key="id"
        :loading="loading"
        empty="暂无审计记录"
        clickable
        @row-click="(row) => (selectedId = asEvent(row).id)"
      >
        <template #cell-action="{ row }">
          <span class="font-mono text-xs">{{ asEvent(row).action }}</span>
        </template>
        <template #cell-ok="{ row }">
          <StatusDot :status="asEvent(row).ok ? 'ok' : 'failed'" :label="asEvent(row).ok ? '成功' : '失败'" />
        </template>
        <template #cell-actor="{ row }">
          <span class="text-muted">{{ asEvent(row).actor || '—' }}</span>
        </template>
        <template #cell-createdAt="{ row }">
          <span class="tnum text-muted">{{ relTime(asEvent(row).createdAt) }}</span>
        </template>
      </Table>
    </div>

    <Drawer :open="selectedId !== null" title="审计详情" width="520px" @update:open="selectedId = null">
      <div v-if="selectedEvent" class="space-y-5">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
          <div class="col-span-2">
            <dt class="rp-microlabel">动作</dt>
            <dd class="mt-0.5 font-mono text-xs">{{ selectedEvent.action }}</dd>
          </div>
          <div>
            <dt class="rp-microlabel">结果</dt>
            <dd class="mt-0.5">
              <StatusDot :status="selectedEvent.ok ? 'ok' : 'failed'" :label="selectedEvent.ok ? '成功' : '失败'" />
            </dd>
          </div>
          <div>
            <dt class="rp-microlabel">操作者</dt>
            <dd class="mt-0.5">{{ selectedEvent.actor || '—' }}</dd>
          </div>
          <div class="col-span-2">
            <dt class="rp-microlabel">时间</dt>
            <dd class="tnum mt-0.5">{{ fmtDateTime(selectedEvent.createdAt) }}</dd>
          </div>
        </dl>

        <div
          v-if="selectedEvent.error"
          class="rounded-lg border border-red/25 bg-red/8 px-3 py-2.5 text-xs leading-relaxed text-red/90"
        >
          {{ selectedEvent.error }}
        </div>

        <div v-if="payloadText(selectedEvent.payload)">
          <p class="rp-microlabel mb-2">Payload</p>
          <pre
            class="max-h-[360px] overflow-auto rounded-lg border border-border bg-bg/50 p-3 font-mono text-[11.5px] leading-relaxed text-muted"
          >{{ payloadText(selectedEvent.payload) }}</pre>
        </div>
      </div>
    </Drawer>
  </div>
</template>
