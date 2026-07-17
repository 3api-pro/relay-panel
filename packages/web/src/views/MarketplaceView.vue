<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Store } from 'lucide-vue-next';
import { del, get, patch } from '../api/client';
import { session } from '../api/session';
import { toast } from '../components/ui/toast';
import {
  Badge,
  Button,
  ConfirmDanger,
  EmptyState,
  Select,
  Skeleton,
  Table,
  Tabs,
  type TableColumn,
  type TabItem,
} from '../components/ui';
import type {
  MarketplaceGrant,
  MarketplaceGrantsResponse,
  MarketplaceTemplate,
  MarketplaceTemplatesResponse,
  SitesResponse,
  SiteView,
} from '../api/types';
import TemplateCard from './marketplace/TemplateCard.vue';
import GrantWizard from './marketplace/GrantWizard.vue';
import TemplateFormModal from './marketplace/TemplateFormModal.vue';

/**
 * 渠道市场（G2）：模板浏览/启用 + 已授权管理。
 * - 模板 Tab：模板卡网格；canWrite 一键启用向导；root 可管理（增改停删）。
 * - 已授权 Tab：授权表 + 撤销（站不可达时可 force 仅改状态）。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));
const isRoot = session.isRoot;

const tab = ref<'templates' | 'grants'>('templates');
const tabItems = computed<TabItem[]>(() => [
  { key: 'templates', label: t('marketplace.tabTemplates'), count: templates.value.length },
  { key: 'grants', label: t('marketplace.tabGrants'), count: grants.value.length },
]);

// ---- 数据源 ----
const sites = ref<SiteView[]>([]);
const templates = ref<MarketplaceTemplate[]>([]);
const grants = ref<MarketplaceGrant[]>([]);

const templatesLoading = ref(true);
const templatesError = ref('');
const grantsLoading = ref(true);
const grantsError = ref('');

const showDisabled = ref(false);
const grantFilterSlug = ref('__all__');

async function loadSites(): Promise<void> {
  try {
    const res = await get<SitesResponse>('/api/sites', { silent: true });
    sites.value = res.sites;
  } catch {
    sites.value = [];
  }
}

async function loadTemplates(): Promise<void> {
  templatesLoading.value = true;
  try {
    const res = await get<MarketplaceTemplatesResponse>('/api/marketplace/templates', {
      silent: true,
      query: { all: isRoot.value && showDisabled.value ? 1 : undefined },
    });
    templates.value = res.templates;
    templatesError.value = '';
  } catch (err) {
    templatesError.value = err instanceof Error ? err.message : t('marketplace.loadFailed');
  } finally {
    templatesLoading.value = false;
  }
}

async function loadGrants(): Promise<void> {
  grantsLoading.value = true;
  try {
    const res = await get<MarketplaceGrantsResponse>('/api/marketplace/grants', {
      silent: true,
      query: { siteSlug: grantFilterSlug.value === '__all__' ? undefined : grantFilterSlug.value },
    });
    grants.value = res.grants;
    grantsError.value = '';
  } catch (err) {
    grantsError.value = err instanceof Error ? err.message : t('marketplace.loadFailed');
  } finally {
    grantsLoading.value = false;
  }
}

onMounted(() => {
  void loadSites();
  void loadTemplates();
  void loadGrants();
});

function toggleShowDisabled(): void {
  showDisabled.value = !showDisabled.value;
  void loadTemplates();
}

const grantSiteOptions = computed(() => [
  { value: '__all__', label: t('marketplace.allSites') },
  ...sites.value.filter((s) => s.status !== 'destroyed').map((s) => ({ value: s.slug, label: s.label })),
]);

function onGrantFilter(v: string): void {
  grantFilterSlug.value = v;
  void loadGrants();
}

// ---- 启用向导 ----
const wizardOpen = ref(false);
const wizardTemplate = ref<MarketplaceTemplate | null>(null);

function openWizard(t: MarketplaceTemplate): void {
  wizardTemplate.value = t;
  wizardOpen.value = true;
}

function onGrantCreated(): void {
  tab.value = 'grants';
  void loadGrants();
}

// ---- 模板管理（root）----
const formOpen = ref(false);
const formTemplate = ref<MarketplaceTemplate | null>(null);

function openCreate(): void {
  formTemplate.value = null;
  formOpen.value = true;
}
function openEdit(t: MarketplaceTemplate): void {
  formTemplate.value = t;
  formOpen.value = true;
}
function onTemplateSaved(): void {
  void loadTemplates();
}

async function toggleTemplate(tpl: MarketplaceTemplate): Promise<void> {
  try {
    await patch(`/api/marketplace/templates/${tpl.id}`, { enabled: !tpl.enabled }, { silent: true });
    toast.success(tpl.enabled ? t('marketplace.toast.templateDisabled') : t('marketplace.toast.templateEnabled'));
    await loadTemplates();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('marketplace.toast.toggleFailed'));
  }
}

// 删除模板
const delOpen = ref(false);
const delTarget = ref<MarketplaceTemplate | null>(null);
const delLoading = ref(false);

function askDelete(t: MarketplaceTemplate): void {
  delTarget.value = t;
  delOpen.value = true;
}
async function confirmDelete(): Promise<void> {
  const tpl = delTarget.value;
  if (!tpl) return;
  delLoading.value = true;
  try {
    await del(`/api/marketplace/templates/${tpl.id}`, undefined, { silent: true });
    toast.success(t('marketplace.toast.templateDeleted'));
    delOpen.value = false;
    delTarget.value = null;
    await loadTemplates();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('marketplace.toast.deleteFailed'));
    delOpen.value = false;
    delTarget.value = null;
  } finally {
    delLoading.value = false;
  }
}

// ---- 撤销授权 ----
const grantColumns = computed<TableColumn[]>(() => [
  { key: 'site', label: t('marketplace.col.site') },
  { key: 'template', label: t('marketplace.col.template') },
  { key: 'channelName', label: t('marketplace.col.channelName') },
  { key: 'source', label: t('marketplace.col.source') },
  { key: 'status', label: t('marketplace.col.status') },
  { key: 'createdAt', label: t('marketplace.col.createdAt') },
  { key: 'createdBy', label: t('marketplace.col.createdBy') },
  { key: 'actions', label: t('common.actions'), align: 'right' },
]);
const grantRows = computed(() => grants.value as unknown as Record<string, unknown>[]);

const revokeOpen = ref(false);
const revokeTarget = ref<MarketplaceGrant | null>(null);
const revokeLoading = ref(false);
const revokeForce = ref(false);

const revokeConfirmText = computed(() => revokeTarget.value?.channelName ?? revokeTarget.value?.templateKey ?? '');
const revokeMessage = computed(() => {
  if (revokeForce.value) return t('marketplace.revokeDialog.messageForce');
  return revokeTarget.value?.managed
    ? t('marketplace.revokeDialog.messageManaged')
    : t('marketplace.revokeDialog.message');
});

function askRevoke(row: Record<string, unknown>): void {
  revokeTarget.value = row as unknown as MarketplaceGrant;
  revokeForce.value = false;
  revokeOpen.value = true;
}

async function confirmRevoke(): Promise<void> {
  const g = revokeTarget.value;
  if (!g) return;
  revokeLoading.value = true;
  try {
    await del(`/api/marketplace/grants/${g.id}`, undefined, {
      silent: true,
      query: revokeForce.value ? { force: 1 } : {},
    });
    toast.success(t('marketplace.toast.grantRevoked'));
    revokeOpen.value = false;
    revokeTarget.value = null;
    await loadGrants();
  } catch (err) {
    // 站不可达/网关问题：后端提示可 force；升级为强制模式让用户再确认一次
    if (!revokeForce.value && err instanceof Error && err.message.includes('force=1')) {
      revokeForce.value = true;
      toast.error(err.message);
    } else {
      toast.error(err instanceof Error ? err.message : t('marketplace.toast.revokeFailed'));
      revokeOpen.value = false;
      revokeTarget.value = null;
    }
  } finally {
    revokeLoading.value = false;
  }
}

// ---- 展示辅助 ----
function sourceMeta(source: string): { text: string; tone: 'accent' | 'default' } {
  return source === 'managed'
    ? { text: t('marketplace.source.managed'), tone: 'accent' }
    : { text: t('marketplace.source.byo'), tone: 'default' };
}
function relTime(iso: string): string {
  const time = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('marketplace.relTime.justNow');
  if (min < 60) return t('marketplace.relTime.minAgo', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('marketplace.relTime.hourAgo', { n: h });
  return t('marketplace.relTime.dayAgo', { n: Math.floor(h / 24) });
}
</script>

<template>
  <div class="space-y-5">
    <Tabs v-model="tab" :tabs="tabItems" />

    <!-- ===================== 模板 Tab ===================== -->
    <section v-if="tab === 'templates'" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="rp-microlabel">{{ t('marketplace.sectionTemplates') }}</p>
        <div class="flex items-center gap-2">
          <button
            v-if="isRoot"
            type="button"
            class="flex items-center gap-1.5 rounded-lg border border-border bg-panel-2/50 px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-2 hover:text-text"
            @click="toggleShowDisabled"
          >
            <span
              class="relative h-4 w-7 rounded-full transition-colors"
              :class="showDisabled ? 'bg-accent' : 'bg-panel-2'"
            >
              <span
                class="absolute top-0.5 size-3 rounded-full bg-white transition-all"
                :class="showDisabled ? 'left-3.5' : 'left-0.5'"
              />
            </span>
            {{ t('marketplace.showDisabled') }}
          </button>
          <Button v-if="isRoot" variant="primary" size="sm" @click="openCreate">
            <Plus :size="14" />{{ t('marketplace.newTemplate') }}
          </Button>
        </div>
      </div>

      <!-- loading -->
      <div v-if="templatesLoading" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="i in 6" :key="i" class="rp-panel p-4"><Skeleton :lines="4" /></div>
      </div>

      <!-- error -->
      <div v-else-if="templatesError" class="rp-panel p-8">
        <EmptyState :title="t('marketplace.loadFailed')" :description="templatesError" />
      </div>

      <!-- empty -->
      <div v-else-if="templates.length === 0" class="rp-panel p-8">
        <EmptyState
          :icon="Store"
          :title="t('marketplace.emptyTemplatesTitle')"
          :description="isRoot ? t('marketplace.emptyTemplatesRoot') : t('marketplace.emptyTemplatesUser')"
        >
          <Button v-if="isRoot" variant="primary" size="sm" @click="openCreate">
            <Plus :size="14" />{{ t('marketplace.newTemplate') }}
          </Button>
        </EmptyState>
      </div>

      <!-- grid -->
      <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <TemplateCard
          v-for="t in templates"
          :key="t.id"
          :template="t"
          :can-write="canWrite"
          :is-root="isRoot"
          @enable="openWizard"
          @edit="openEdit"
          @toggle="toggleTemplate"
          @remove="askDelete"
        />
      </div>
    </section>

    <!-- ===================== 已授权 Tab ===================== -->
    <section v-else class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="rp-microlabel">{{ t('marketplace.sectionGrants') }}</p>
        <div class="w-56">
          <Select
            :model-value="grantFilterSlug"
            :options="grantSiteOptions"
            @update:model-value="(v) => onGrantFilter(String(v))"
          />
        </div>
      </div>

      <div v-if="grantsError" class="rp-panel p-8">
        <EmptyState :title="t('marketplace.loadFailed')" :description="grantsError" />
      </div>

      <div v-else class="rp-panel overflow-hidden">
        <Table
          :columns="grantColumns"
          :rows="grantRows"
          row-key="id"
          :loading="grantsLoading"
          :empty="t('marketplace.emptyGrants')"
        >
          <template #cell-site="{ row }">
            <div class="min-w-0">
              <p class="truncate font-medium">{{ (row as unknown as MarketplaceGrant).siteLabel }}</p>
              <p class="truncate font-mono text-[11px] text-muted">{{ (row as unknown as MarketplaceGrant).siteSlug }}</p>
            </div>
          </template>
          <template #cell-template="{ row }">
            <div class="min-w-0">
              <p class="truncate">{{ (row as unknown as MarketplaceGrant).templateTitle }}</p>
              <p class="truncate font-mono text-[11px] text-muted">{{ (row as unknown as MarketplaceGrant).templateKey }}</p>
            </div>
          </template>
          <template #cell-channelName="{ value }">
            <span :class="value ? '' : 'text-muted/60'">{{ value || '—' }}</span>
          </template>
          <template #cell-source="{ value }">
            <Badge :tone="sourceMeta(String(value)).tone" size="sm">{{ sourceMeta(String(value)).text }}</Badge>
          </template>
          <template #cell-status="{ value }">
            <Badge :tone="value === 'active' ? 'green' : 'muted'" size="sm">
              {{ value === 'active' ? t('marketplace.grantStatus.active') : t('marketplace.grantStatus.revoked') }}
            </Badge>
          </template>
          <template #cell-createdAt="{ value }">
            <span class="text-muted">{{ relTime(String(value)) }}</span>
          </template>
          <template #cell-createdBy="{ value }">
            <span class="truncate text-muted">{{ value }}</span>
          </template>
          <template #cell-actions="{ row }">
            <Button
              v-if="canWrite && (row as unknown as MarketplaceGrant).status === 'active'"
              variant="ghost"
              size="sm"
              @click="askRevoke(row)"
            >
              {{ t('marketplace.revoke') }}
            </Button>
            <span v-else class="text-muted/50">—</span>
          </template>
        </Table>
      </div>
    </section>

    <!-- ===================== 弹层 ===================== -->
    <GrantWizard v-model:open="wizardOpen" :template="wizardTemplate" :sites="sites" @created="onGrantCreated" />

    <TemplateFormModal v-model:open="formOpen" :template="formTemplate" @saved="onTemplateSaved" />

    <ConfirmDanger
      v-model:open="delOpen"
      :title="t('marketplace.delDialog.title')"
      :confirm-text="delTarget?.key ?? ''"
      :message="t('marketplace.delDialog.message')"
      :action-label="t('marketplace.delDialog.action')"
      :loading="delLoading"
      @confirm="confirmDelete"
    />

    <ConfirmDanger
      v-model:open="revokeOpen"
      :title="revokeForce ? t('marketplace.revokeDialog.titleForce') : t('marketplace.revokeDialog.title')"
      :confirm-text="revokeConfirmText"
      :message="revokeMessage"
      :action-label="revokeForce ? t('marketplace.revokeDialog.actionForce') : t('marketplace.revokeDialog.action')"
      :loading="revokeLoading"
      @confirm="confirmRevoke"
    />
  </div>
</template>
