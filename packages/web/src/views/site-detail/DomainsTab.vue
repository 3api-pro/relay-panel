<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Globe, Plus, Trash2 } from 'lucide-vue-next';
import { del, get, post } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Button, EmptyState, Input, Modal, Skeleton } from '../../components/ui';
import type { SiteDomainsResponse } from './types';

/** 域名页：列表 + 添加 / 删除（普通确认）。需在 Caddy 配置反代方可生效。 */
const props = defineProps<{ slug: string }>();
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const domains = ref<string[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteDomainsResponse>(`/api/sites/${props.slug}/domains`, { silent: true });
    domains.value = Array.isArray(res.domains) ? res.domains : [];
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('siteDetail.loadFailed');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const newDomain = ref('');
const adding = ref(false);
async function addDomain(): Promise<void> {
  const d = newDomain.value.trim();
  if (!d) {
    toast.error(t('siteDetail.domains.toastNeedDomain'));
    return;
  }
  adding.value = true;
  try {
    const res = await post<SiteDomainsResponse>(`/api/sites/${props.slug}/domains`, { domain: d });
    domains.value = Array.isArray(res.domains) ? res.domains : domains.value;
    newDomain.value = '';
    toast.success(t('siteDetail.domains.toastAdded'));
  } catch {
    /* toast 已弹 */
  } finally {
    adding.value = false;
  }
}

const removeTarget = ref<string | null>(null);
const removing = ref(false);
async function removeDomain(): Promise<void> {
  if (removeTarget.value === null) return;
  removing.value = true;
  try {
    const res = await del<SiteDomainsResponse>(
      `/api/sites/${props.slug}/domains/${encodeURIComponent(removeTarget.value)}`,
    );
    domains.value = Array.isArray(res.domains) ? res.domains : domains.value;
    toast.success(t('siteDetail.domains.toastDeleted'));
    removeTarget.value = null;
  } catch {
    /* toast 已弹 */
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg border border-border bg-panel-2/40 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
      {{ t('siteDetail.domains.banner') }}
    </div>

    <div v-if="canWrite" class="flex items-center gap-2">
      <div class="w-full max-w-[360px]">
        <Input v-model="newDomain" mono placeholder="api.example.com" @keydown.enter="addDomain" />
      </div>
      <Button variant="primary" size="sm" :loading="adding" @click="addDomain">
        <Plus :size="14" /> {{ t('siteDetail.domains.add') }}
      </Button>
    </div>

    <div v-if="loading" class="rp-panel p-4"><Skeleton :lines="3" /></div>

    <div v-else-if="loadError" class="rp-panel p-8">
      <EmptyState :title="t('siteDetail.loadFailed')" :description="loadError">
        <Button size="sm" @click="load">{{ t('common.retry') }}</Button>
      </EmptyState>
    </div>

    <div v-else-if="domains.length === 0" class="rp-panel p-8">
      <EmptyState :icon="Globe" :title="t('siteDetail.domains.emptyTitle')" :description="t('siteDetail.domains.emptyDesc')" />
    </div>

    <ul v-else class="rp-panel divide-y divide-border/60 overflow-hidden">
      <li v-for="d in domains" :key="d" class="flex items-center gap-3 px-4 py-3">
        <Globe :size="15" class="shrink-0 text-muted/70" />
        <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{{ d }}</span>
        <Button v-if="canWrite" size="sm" variant="ghost" @click="removeTarget = d">
          <Trash2 :size="14" /> {{ t('common.delete') }}
        </Button>
      </li>
    </ul>

    <Modal :open="removeTarget !== null" :title="t('siteDetail.domains.deleteTitle')" width="420px" @update:open="removeTarget = null">
      <p class="text-[13px] leading-relaxed text-muted">
        {{ t('siteDetail.domains.deleteConfirmPre') }}
        <code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-text">{{ removeTarget }}</code>
        {{ t('siteDetail.domains.deleteConfirmPost') }}
      </p>
      <template #footer>
        <Button variant="ghost" @click="removeTarget = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="removing" @click="removeDomain">{{ t('siteDetail.domains.deleteAction') }}</Button>
      </template>
    </Modal>
  </div>
</template>
