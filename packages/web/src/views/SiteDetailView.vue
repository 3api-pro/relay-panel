<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
    if (initial || !site.value) loadError.value = err instanceof Error ? err.message : '加载失败';
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
  { key: 'overview', label: '概览' },
  { key: 'channels', label: '渠道' },
  { key: 'users', label: '用户' },
  { key: 'domains', label: '域名', count: site.value?.domains?.length },
  { key: 'settings', label: '设置' },
  { key: 'jobs', label: '任务' },
  { key: 'audit', label: '审计' },
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
    toast.error('请填写目标版本');
    return;
  }
  upgradeLoading.value = true;
  try {
    await post(`/api/sites/${slug.value}/upgrade`, { toVersion: v });
    toast.success('升级任务已提交');
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
    toast.success(action === 'start' ? '启动任务已提交' : '停止任务已提交');
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
    toast.success('销毁任务已提交');
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
      <ArrowLeft :size="13" /> 返回站点列表
    </RouterLink>

    <!-- 头部骨架 -->
    <div v-if="loading" class="rp-panel p-5">
      <Skeleton :lines="3" />
    </div>

    <!-- 加载失败（无缓存） -->
    <div v-else-if="loadError && !site" class="rp-panel p-10">
      <EmptyState title="站点加载失败" :description="loadError">
        <Button size="sm" @click="loadSite(true)">重试</Button>
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
              <Badge v-if="isExternal" tone="amber" size="sm">外部接管</Badge>
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span class="font-mono">{{ site.slug }}</span>
              <span class="tnum">端口 {{ site.hostPort }}</span>
              <span v-if="site.latencyMs !== undefined" class="tnum">延迟 {{ site.latencyMs }}ms</span>
              <span v-if="site.domains && site.domains.length > 0" class="truncate font-mono">
                {{ site.domains.join('、') }}
              </span>
            </div>
            <p v-if="site.error" class="mt-2 text-xs text-red/90">{{ site.error }}</p>
          </div>

          <!-- 生命周期操作 -->
          <div v-if="canLifecycle" class="flex shrink-0 items-center gap-2">
            <Badge v-if="busy && site.activeJob" tone="accent" size="sm">
              {{ jobKindText(site.activeJob.kind) }}任务{{ site.activeJob.status === 'running' ? '执行中' : '排队中' }}
            </Badge>
            <Button v-if="canStart" size="sm" :disabled="busy" :loading="powerLoading" @click="doPower('start')">
              <Play :size="14" /> 启动
            </Button>
            <Button v-if="canStop" size="sm" :disabled="busy" :loading="powerLoading" @click="doPower('stop')">
              <Square :size="14" /> 停止
            </Button>
            <Button size="sm" :disabled="busy" @click="openUpgrade">
              <ArrowUpCircle :size="14" /> 升级
            </Button>
            <Button v-if="canDestroy" size="sm" variant="danger" :disabled="busy" @click="destroyOpen = true">
              <Trash2 :size="14" /> 销毁
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
    <Modal v-model:open="upgradeOpen" title="升级站点" width="440px">
      <div class="space-y-3">
        <p class="text-[13px] leading-relaxed text-muted">
          将站点升级到指定引擎版本，会创建一个升级任务并短暂重启容器。
        </p>
        <Field label="目标版本" hint="当前版本填入以便修改">
          <Input v-model="upgradeVersion" mono placeholder="如 v0.1.160" />
        </Field>
      </div>
      <template #footer>
        <Button variant="ghost" @click="upgradeOpen = false">取消</Button>
        <Button variant="primary" :loading="upgradeLoading" @click="doUpgrade">提交升级</Button>
      </template>
    </Modal>

    <!-- 销毁 -->
    <ConfirmDanger
      v-model:open="destroyOpen"
      title="销毁站点"
      :confirm-text="slug"
      message="销毁将移除站点容器与编排路由，操作不可撤销。请输入站点 slug 以确认。"
      action-label="确认销毁"
      :loading="destroyLoading"
      @confirm="doDestroy"
    />
  </div>
</template>
