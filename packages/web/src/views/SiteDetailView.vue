<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, ArrowUpCircle, Play, Square, Trash2 } from 'lucide-vue-next';
import { del, get, post } from '../api/client';
import type { SiteView } from '../api/types';
import { toast } from '../components/ui/toast';
import {
  Badge,
  Button,
  ConfirmDanger,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  StatusDot,
  Tabs,
  type TabItem,
} from '../components/ui';
import { jobKindText } from './site-detail/format';
import OverviewTab from './site-detail/OverviewTab.vue';
import ChannelsTab from './site-detail/ChannelsTab.vue';
import UsersTab from './site-detail/UsersTab.vue';
import DomainsTab from './site-detail/DomainsTab.vue';
import SettingsTab from './site-detail/SettingsTab.vue';
import JobsTab from './site-detail/JobsTab.vue';
import AuditTab from './site-detail/AuditTab.vue';

/**
 * 单站钻取：站点头部（状态/引擎/域名/端口 + 生命周期操作）+ 七个懒载标签页。
 * 生命周期操作仅 canWrite 且非 external 站可见；渠道/用户/域名/设置对 external 站仍可写。
 */
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const slug = computed(() => String(route.params.slug ?? ''));
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const site = ref<SiteView | null>(null);
const loading = ref(true);
const loadError = ref('');

async function loadSite(initial = false): Promise<void> {
  if (initial) loading.value = true;
  try {
    const s = await get<SiteView>(`/api/sites/${slug.value}`, { silent: true });
    site.value = s;
    loadError.value = '';
  } catch (err) {
    if (initial || !site.value) loadError.value = err instanceof Error ? err.message : t('siteDetail.loadFailed');
  } finally {
    if (initial) loading.value = false;
  }
}

let timer: number | null = null;
onMounted(() => {
  void loadSite(true);
  // 有进行中任务时轻量轮询头部，反映状态流转
  timer = window.setInterval(() => {
    if (site.value?.activeJob) void loadSite();
  }, 3000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

const isExternal = computed(() => site.value?.managed === 'external');
const canLifecycle = computed(() => canWrite.value && !isExternal.value);
const busy = computed(() => Boolean(site.value?.activeJob));
const siteStatus = computed(() => {
  const s = site.value;
  if (!s) return '';
  if (s.status === 'active' && s.ok === false) return 'down';
  return s.status;
});
const canStop = computed(() => site.value?.status === 'active');
const canStart = computed(() => site.value?.status === 'stopped');
const canDestroy = computed(() => site.value !== null && site.value.status !== 'destroyed');

// ---- Tabs ----
const tabKey = ref('overview');
const tabs = computed<TabItem[]>(() => [
  { key: 'overview', label: t('siteDetail.tabs.overview') },
  { key: 'channels', label: t('siteDetail.tabs.channels') },
  { key: 'users', label: t('siteDetail.tabs.users') },
  { key: 'domains', label: t('siteDetail.tabs.domains'), count: site.value?.domains?.length },
  { key: 'settings', label: t('siteDetail.tabs.settings') },
  { key: 'jobs', label: t('siteDetail.tabs.jobs') },
  { key: 'audit', label: t('siteDetail.tabs.audit') },
]);

// ---- 升级 ----
const upgradeOpen = ref(false);
const upgradeVersion = ref('');
const upgradeLoading = ref(false);
function openUpgrade(): void {
  upgradeVersion.value = site.value?.version ?? '';
  upgradeOpen.value = true;
}
async function doUpgrade(): Promise<void> {
  const v = upgradeVersion.value.trim();
  if (!v) {
    toast.error(t('siteDetail.upgrade.toastNeedVersion'));
    return;
  }
  upgradeLoading.value = true;
  try {
    await post(`/api/sites/${slug.value}/upgrade`, { toVersion: v });
    toast.success(t('siteDetail.upgrade.toastSubmitted'));
    upgradeOpen.value = false;
    await loadSite();
  } catch {
    /* toast 已弹 */
  } finally {
    upgradeLoading.value = false;
  }
}

// ---- 启停 ----
const powerLoading = ref(false);
async function doPower(action: 'start' | 'stop'): Promise<void> {
  powerLoading.value = true;
  try {
    await post(`/api/sites/${slug.value}/${action}`);
    toast.success(action === 'start' ? t('siteDetail.power.startSubmitted') : t('siteDetail.power.stopSubmitted'));
    await loadSite();
  } catch {
    /* toast 已弹 */
  } finally {
    powerLoading.value = false;
  }
}

// ---- 销毁 ----
const destroyOpen = ref(false);
const destroyLoading = ref(false);
async function doDestroy(): Promise<void> {
  destroyLoading.value = true;
  try {
    await del(`/api/sites/${slug.value}`, { confirm: slug.value });
    toast.success(t('siteDetail.destroy.toastSubmitted'));
    destroyOpen.value = false;
    await router.push('/sites');
  } catch {
    /* toast 已弹 */
  } finally {
    destroyLoading.value = false;
  }
}
</script>

<template>
  <div class="rp-page space-y-5">
    <RouterLink to="/sites" class="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-text">
      <ArrowLeft :size="13" /> {{ t('siteDetail.header.back') }}
    </RouterLink>

    <!-- 头部骨架 -->
    <div v-if="loading" class="rp-panel p-5">
      <Skeleton :lines="3" />
    </div>

    <!-- 加载失败（无缓存） -->
    <div v-else-if="loadError && !site" class="rp-panel p-10">
      <EmptyState :title="t('siteDetail.header.loadFailedTitle')" :description="loadError">
        <Button size="sm" @click="loadSite(true)">{{ t('common.retry') }}</Button>
      </EmptyState>
    </div>

    <template v-else-if="site">
      <!-- 头部 -->
      <header class="rp-panel p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2.5">
              <StatusDot :status="siteStatus" />
              <h1 class="truncate text-lg font-semibold tracking-tight">{{ site.label }}</h1>
              <Badge tone="muted" size="sm" mono>{{ site.engine }} · {{ site.version }}</Badge>
              <Badge v-if="isExternal" tone="amber" size="sm">{{ t('siteDetail.header.external') }}</Badge>
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span class="font-mono">{{ site.slug }}</span>
              <span class="tnum">{{ t('siteDetail.header.port', { n: site.hostPort }) }}</span>
              <span v-if="site.latencyMs !== undefined" class="tnum">{{ t('siteDetail.header.latency', { n: site.latencyMs }) }}</span>
              <span v-if="site.domains && site.domains.length > 0" class="truncate font-mono">
                {{ site.domains.join('、') }}
              </span>
            </div>
            <p v-if="site.error" class="mt-2 text-xs text-red/90">{{ site.error }}</p>
          </div>

          <!-- 生命周期操作 -->
          <div v-if="canLifecycle" class="flex shrink-0 items-center gap-2">
            <Badge v-if="busy && site.activeJob" tone="accent" size="sm">
              {{
                site.activeJob.status === 'running'
                  ? t('siteDetail.header.jobRunning', { kind: jobKindText(site.activeJob.kind) })
                  : t('siteDetail.header.jobQueued', { kind: jobKindText(site.activeJob.kind) })
              }}
            </Badge>
            <Button v-if="canStart" size="sm" :disabled="busy" :loading="powerLoading" @click="doPower('start')">
              <Play :size="14" /> {{ t('siteDetail.header.start') }}
            </Button>
            <Button v-if="canStop" size="sm" :disabled="busy" :loading="powerLoading" @click="doPower('stop')">
              <Square :size="14" /> {{ t('siteDetail.header.stop') }}
            </Button>
            <Button size="sm" :disabled="busy" @click="openUpgrade">
              <ArrowUpCircle :size="14" /> {{ t('siteDetail.header.upgrade') }}
            </Button>
            <Button v-if="canDestroy" size="sm" variant="danger" :disabled="busy" @click="destroyOpen = true">
              <Trash2 :size="14" /> {{ t('siteDetail.header.destroy') }}
            </Button>
          </div>
        </div>
      </header>

      <!-- Tabs -->
      <div>
        <Tabs v-model="tabKey" :tabs="tabs" />
        <div class="pt-5">
          <OverviewTab v-if="tabKey === 'overview'" :slug="slug" :site="site" />
          <ChannelsTab v-else-if="tabKey === 'channels'" :slug="slug" />
          <UsersTab v-else-if="tabKey === 'users'" :slug="slug" />
          <DomainsTab v-else-if="tabKey === 'domains'" :slug="slug" />
          <SettingsTab v-else-if="tabKey === 'settings'" :slug="slug" />
          <JobsTab v-else-if="tabKey === 'jobs'" :slug="slug" />
          <AuditTab v-else-if="tabKey === 'audit'" :slug="slug" />
        </div>
      </div>
    </template>

    <!-- 升级 -->
    <Modal v-model:open="upgradeOpen" :title="t('siteDetail.upgrade.title')" width="440px">
      <div class="space-y-3">
        <p class="text-[13px] leading-relaxed text-muted">
          {{ t('siteDetail.upgrade.desc') }}
        </p>
        <Field :label="t('siteDetail.upgrade.versionLabel')" :hint="t('siteDetail.upgrade.versionHint')">
          <Input v-model="upgradeVersion" mono placeholder="v0.1.160" />
        </Field>
      </div>
      <template #footer>
        <Button variant="ghost" @click="upgradeOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="upgradeLoading" @click="doUpgrade">{{ t('siteDetail.upgrade.submit') }}</Button>
      </template>
    </Modal>

    <!-- 销毁 -->
    <ConfirmDanger
      v-model:open="destroyOpen"
      :title="t('siteDetail.destroy.title')"
      :confirm-text="slug"
      :message="t('siteDetail.destroy.message')"
      :action-label="t('siteDetail.destroy.action')"
      :loading="destroyLoading"
      @confirm="doDestroy"
    />
  </div>
</template>
