<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Search } from 'lucide-vue-next';
import { get, patch } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Badge, Button, EmptyState, Table, type TableColumn } from '../../components/ui';
import type { SiteUser, SiteUsersResponse } from './types';

/** 用户页：搜索（debounce）+ 列表 + 启用/禁用（写操作 canWrite 门控）。 */
const props = defineProps<{ slug: string }>();
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const users = ref<SiteUser[]>([]);
const loading = ref(true);
const loadError = ref('');
const search = ref('');
let debounce: number | null = null;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteUsersResponse>(`/api/sites/${props.slug}/users`, {
      silent: true,
      query: { search: search.value.trim() || undefined },
    });
    users.value = Array.isArray(res.users) ? res.users : [];
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('siteDetail.loadFailed');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(search, () => {
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(load, 300);
});
onBeforeUnmount(() => {
  if (debounce !== null) window.clearTimeout(debounce);
});

const rows = computed(() => users.value as unknown as Record<string, unknown>[]);
function asUser(row: Record<string, unknown>): SiteUser {
  return row as unknown as SiteUser;
}

const columns = computed<TableColumn[]>(() => [
  { key: 'email', label: t('siteDetail.users.colEmail') },
  { key: 'username', label: t('siteDetail.users.colUsername') },
  { key: 'role', label: t('siteDetail.users.colRole') },
  { key: 'balance', label: t('siteDetail.users.colBalance'), align: 'right' },
  { key: 'status', label: t('siteDetail.users.colStatus') },
  { key: 'actions', label: t('siteDetail.users.colActions'), align: 'right' },
]);

function statusText(s: string): string {
  if (s === 'active') return t('siteDetail.users.statusActive');
  if (s === 'disabled') return t('siteDetail.users.statusDisabled');
  return s;
}
function statusTone(s: string): 'green' | 'muted' {
  return s === 'active' ? 'green' : 'muted';
}
function balanceText(b?: number): string {
  return b === undefined || b === null ? '—' : b.toLocaleString('en-US');
}

const togglingId = ref<string | number | null>(null);
async function toggleStatus(u: SiteUser): Promise<void> {
  const next = u.status === 'active' ? 'disabled' : 'active';
  togglingId.value = u.id;
  try {
    await patch(`/api/sites/${props.slug}/users/${u.id}`, { status: next });
    toast.success(next === 'active' ? t('siteDetail.users.toastEnabled') : t('siteDetail.users.toastDisabled'));
    await load();
  } catch {
    /* toast 已弹 */
  } finally {
    togglingId.value = null;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div class="relative w-full max-w-[320px]">
        <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          v-model="search"
          type="text"
          :placeholder="t('siteDetail.users.searchPlaceholder')"
          class="h-8.5 w-full rounded-lg border border-border bg-bg/60 pl-8 pr-3 text-[13px] text-text placeholder:text-muted/50 transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
      </div>
      <p class="shrink-0 text-xs text-muted">
        {{ t('siteDetail.users.count', { n: users.length }) }}
      </p>
    </div>

    <div v-if="loadError" class="rp-panel p-8">
      <EmptyState :title="t('siteDetail.loadFailed')" :description="loadError">
        <Button size="sm" @click="load">{{ t('common.retry') }}</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table :columns="columns" :rows="rows" row-key="id" :loading="loading" :empty="t('siteDetail.users.empty')">
        <template #cell-email="{ row }">
          <span class="font-mono text-xs">{{ asUser(row).email ?? '—' }}</span>
        </template>
        <template #cell-username="{ row }">{{ asUser(row).username ?? '—' }}</template>
        <template #cell-role="{ row }">
          <Badge tone="muted" size="sm">{{ asUser(row).role }}</Badge>
        </template>
        <template #cell-balance="{ row }">
          <span class="tnum">{{ balanceText(asUser(row).balance) }}</span>
        </template>
        <template #cell-status="{ row }">
          <Badge :tone="statusTone(asUser(row).status)" size="sm">{{ statusText(asUser(row).status) }}</Badge>
        </template>
        <template #cell-actions="{ row }">
          <div v-if="canWrite" class="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              :loading="togglingId === asUser(row).id"
              @click="toggleStatus(asUser(row))"
            >
              {{ asUser(row).status === 'active' ? t('siteDetail.users.disable') : t('siteDetail.users.enable') }}
            </Button>
          </div>
          <span v-else class="text-xs text-muted/60">{{ t('siteDetail.readonly') }}</span>
        </template>
      </Table>
    </div>
  </div>
</template>
