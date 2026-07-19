<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Link2, Lock, Plus, Server } from 'lucide-vue-next';
import { del, get, post } from '../api/client';
import type { SitesResponse, SiteView } from '../api/types';
import {
  Badge,
  Button,
  ConfirmDanger,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusDot,
  Table,
  type SelectOption,
  type TableColumn,
} from '../components/ui';
import { toast } from '../components/ui/toast';
import SiteRowActions from './sites/SiteRowActions.vue';

/**
 * 站点列表 + 新建站点向导。
 * 数据源 GET /api/sites，30s 轻量自刷新。写操作 inject canWrite 后可见；
 * external（外部接管）站隐藏全部生命周期操作。销毁走 ConfirmDanger 逐字确认。
 */
const router = useRouter();
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

// ---- 本视图专属请求/响应类型（不污染共享 types.ts） ----
interface CreateSiteBody {
  slug: string;
  label: string;
  engine: string;
  version: string;
  adminEmail: string;
  hostPort?: number;
  branding?: { siteName: string; announcement?: string };
}
interface CreateSiteResult {
  slug: string;
  jobId: number;
  hostPort: number;
}
interface JobRef {
  slug: string;
  jobId: number;
}

// ---- 列表数据 ----
const sites = ref<SiteView[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const loadError = ref('');
let timer: number | null = null;

async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true;
  else refreshing.value = true;
  try {
    const res = await get<SitesResponse>('/api/sites', { silent: true });
    sites.value = Array.isArray(res?.sites) ? res.sites : [];
    loadError.value = '';
  } catch (err) {
    if (initial) loadError.value = err instanceof Error ? err.message : t('sites.loadFailed');
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => {
  void refresh(true);
  void loadVersions();
  timer = window.setInterval(() => void refresh(), 30_000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

const visibleSites = computed(() => sites.value.filter((s) => s.status !== 'destroyed'));
const downCount = computed(
  () => visibleSites.value.filter((s) => s.status === 'active' && s.ok === false).length,
);
const rows = computed<Record<string, unknown>[]>(
  () => visibleSites.value as unknown as Record<string, unknown>[],
);

function asSite(row: Record<string, unknown>): SiteView {
  return row as unknown as SiteView;
}

// ---- 展示辅助 ----
const columns = computed<TableColumn[]>(() => [
  { key: 'status', label: t('sites.columns.status'), width: '92px' },
  { key: 'site', label: t('sites.columns.site') },
  { key: 'engine', label: t('sites.columns.engine'), width: '168px' },
  { key: 'hostPort', label: t('sites.columns.hostPort'), align: 'right', width: '80px' },
  { key: 'usage', label: t('sites.columns.usage'), align: 'right', width: '176px' },
  { key: 'job', label: t('sites.columns.job'), width: '128px' },
  { key: 'actions', label: '', align: 'right', width: '52px' },
]);

function siteStatus(s: SiteView): string {
  if (s.status === 'active' && s.ok === false) return 'down';
  return s.status;
}
function fmtInt(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('en-US');
}
function fmtCost(n: number | undefined, unit: string): string {
  if (n === undefined) return '—';
  const v = n >= 100 ? n.toFixed(0) : n.toFixed(2);
  return unit ? `${v} ${unit}` : v;
}
function jobKindText(kind: string): string {
  const known = ['provision', 'upgrade', 'start', 'stop', 'destroy'];
  return known.includes(kind) ? t(`sites.jobKind.${kind}`) : kind;
}
function jobStatusText(status: string): string {
  if (status === 'running') return t('sites.jobStatus.running');
  if (status === 'queued') return t('sites.jobStatus.queued');
  return status;
}

function openSite(s: SiteView): void {
  void router.push(`/sites/${s.slug}`);
}

// ---- 生命周期操作 ----
const busySlug = ref('');

async function lifecycle(s: SiteView, kind: 'start' | 'stop'): Promise<void> {
  busySlug.value = s.slug;
  try {
    await post<JobRef>(`/api/sites/${s.slug}/${kind}`);
    toast.success(t('sites.toast.queued'));
    await refresh(true);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    busySlug.value = '';
  }
}

// 升级
const upgradeOpen = ref(false);
const upgradeSite = ref<SiteView | null>(null);
const upgradeVersion = ref('');
const upgradeErr = ref('');
const upgradeBusy = ref(false);

function onUpgrade(s: SiteView): void {
  upgradeSite.value = s;
  upgradeVersion.value = '';
  upgradeErr.value = '';
  upgradeOpen.value = true;
}
async function submitUpgrade(): Promise<void> {
  const s = upgradeSite.value;
  if (!s) return;
  const v = upgradeVersion.value.trim();
  if (!v) {
    upgradeErr.value = t('sites.upgrade.errRequired');
    return;
  }
  if (v === s.version) {
    upgradeErr.value = t('sites.upgrade.errSame');
    return;
  }
  upgradeBusy.value = true;
  try {
    await post<JobRef>(`/api/sites/${s.slug}/upgrade`, { toVersion: v });
    toast.success(t('sites.toast.queued'));
    upgradeOpen.value = false;
    await refresh(true);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    upgradeBusy.value = false;
  }
}

// 销毁
const destroyOpen = ref(false);
const destroySite = ref<SiteView | null>(null);
const destroyKeepData = ref(false);
const destroyBusy = ref(false);

function onDestroy(s: SiteView, keepData: boolean): void {
  destroySite.value = s;
  destroyKeepData.value = keepData;
  destroyOpen.value = true;
}
const destroyMessage = computed(() =>
  destroyKeepData.value ? t('sites.destroy.keepMsg') : t('sites.destroy.purgeMsg'),
);
async function submitDestroy(): Promise<void> {
  const s = destroySite.value;
  if (!s) return;
  destroyBusy.value = true;
  try {
    await del(`/api/sites/${s.slug}`, { confirm: s.slug, keepData: destroyKeepData.value });
    toast.success(t('sites.toast.queued'));
    destroyOpen.value = false;
    await refresh(true);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    destroyBusy.value = false;
  }
}

// ---- 新建站点向导 ----
const createOpen = ref(false);
const submitting = ref(false);
const engineOptions = computed<SelectOption[]>(() => [
  { value: 'sub2api', label: t('sites.create.engineRecommended') },
  { value: 'newapi', label: 'newapi' },
]);

const fEngine = ref<string | number | null>('sub2api');
const fVersion = ref('');
const fSlug = ref('');
const fLabel = ref('');
const fPort = ref<string | number>('');
const fEmail = ref('');
const fSiteName = ref('');
const fAnnouncement = ref('');
const errors = ref<Record<string, string>>({});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// slug 自动派生：域名/名称 → 合法 slug；派生失败（如纯中文）返回 ''
function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/, 1)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return SLUG_RE.test(s) ? s : '';
}
const CUSTOM_VERSION = '__custom__';

// 版本 = 官方镜像 tag（我们不托管 exe，provision 拉官方镜像）。下拉给已知 tag + 自定义兜底
const engineVersions = ref<{ sub2api: string[]; newapi: string[] }>({ sub2api: [], newapi: [] });
const fVersionSelect = ref<string | number>('');
const versionOptions = computed<SelectOption[]>(() => {
  const list = fEngine.value === 'newapi' ? engineVersions.value.newapi : engineVersions.value.sub2api;
  return [
    ...list.map((v) => ({ value: v, label: v })),
    { value: CUSTOM_VERSION, label: t('sites.create.versionCustom') },
  ];
});
async function loadVersions(): Promise<void> {
  try {
    engineVersions.value = await get<{ sub2api: string[]; newapi: string[] }>('/api/engines/versions', { silent: true });
  } catch {
    engineVersions.value = { sub2api: [], newapi: [] };
  }
}
// 引擎切换：版本选择重置为该引擎最新
watch(fEngine, () => {
  const list = fEngine.value === 'newapi' ? engineVersions.value.newapi : engineVersions.value.sub2api;
  fVersionSelect.value = list[0] ?? CUSTOM_VERSION;
  fVersion.value = list[0] ?? '';
});
watch(fVersionSelect, (v) => {
  if (v === CUSTOM_VERSION) fVersion.value = '';
  else fVersion.value = String(v);
});

// 名称 → slug 自动预填；slug 被手改过（当前值 ≠ 上次自动值）就不再覆盖
const fSlugAuto = ref('');
watch(fLabel, (v) => {
  if (fSlug.value && fSlug.value !== fSlugAuto.value) return;
  const s = slugify(v);
  if (s) {
    fSlug.value = s;
    fSlugAuto.value = s;
  }
});

function openCreate(): void {
  fEngine.value = 'sub2api';
  const list = engineVersions.value.sub2api;
  fVersionSelect.value = list[0] ?? CUSTOM_VERSION;
  fVersion.value = list[0] ?? '';
  fSlug.value = '';
  fSlugAuto.value = '';
  fLabel.value = '';
  fPort.value = '';
  fEmail.value = '';
  fSiteName.value = '';
  fAnnouncement.value = '';
  errors.value = {};
  createOpen.value = true;
}

function validateCreate(): boolean {
  const e: Record<string, string> = {};
  if (!fEngine.value) e.engine = t('sites.create.errEngine');
  if (!fVersion.value.trim()) e.version = t('sites.create.errVersion');
  const slug = fSlug.value.trim();
  if (!slug) e.slug = t('sites.create.errSlugRequired');
  else if (!SLUG_RE.test(slug)) e.slug = t('sites.create.errSlugFormat');
  if (!fLabel.value.trim()) e.label = t('sites.create.errLabel');
  if (fPort.value !== '' && fPort.value !== null) {
    const p = Number(fPort.value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.hostPort = t('sites.create.errPort');
  }
  const email = fEmail.value.trim();
  if (!email) e.adminEmail = t('sites.create.errEmailRequired');
  else if (!EMAIL_RE.test(email)) e.adminEmail = t('sites.create.errEmailFormat');
  errors.value = e;
  return Object.keys(e).length === 0;
}

async function submitCreate(): Promise<void> {
  if (!validateCreate()) return;
  submitting.value = true;
  try {
    const body: CreateSiteBody = {
      slug: fSlug.value.trim(),
      label: fLabel.value.trim(),
      engine: String(fEngine.value),
      version: fVersion.value.trim(),
      adminEmail: fEmail.value.trim(),
    };
    if (fPort.value !== '' && fPort.value !== null) body.hostPort = Number(fPort.value);
    const siteName = fSiteName.value.trim();
    if (siteName) {
      body.branding = { siteName };
      const announcement = fAnnouncement.value.trim();
      if (announcement) body.branding.announcement = announcement;
    }
    const res = await post<CreateSiteResult>('/api/sites', body);
    toast.success(t('sites.toast.created'));
    createOpen.value = false;
    void router.push(`/sites/${res.slug}`);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    submitting.value = false;
  }
}

// ---- 接入已有站点（adopt）----
const adoptOpen = ref(false);
const adoptSubmitting = ref(false);
const aEngine = ref<string | number | null>('sub2api');
const aSlug = ref('');
const aLabel = ref('');
const aBaseUrl = ref('');
const aCredMode = ref<string | number>('key');
const aAdminKey = ref('');
const aAdminEmail = ref('');
const aAdminPassword = ref('');
const aReadonly = ref(true);
const aErrors = ref<Record<string, string>>({});

// baseUrl 域名 → slug 自动预填；同 create,手改后不覆盖
const aSlugAuto = ref('');
watch(aBaseUrl, (v) => {
  if (aSlug.value && aSlug.value !== aSlugAuto.value) return;
  const s = slugify(v);
  if (s) {
    aSlug.value = s;
    aSlugAuto.value = s;
  }
});

const credModeOptions = computed<SelectOption[]>(() => [
  { value: 'key', label: t('sites.adopt.credKey') },
  { value: 'password', label: t('sites.adopt.credPassword') },
]);

function openAdopt(): void {
  aEngine.value = 'sub2api';
  aSlug.value = '';
  aSlugAuto.value = '';
  aLabel.value = '';
  aBaseUrl.value = '';
  aCredMode.value = 'key';
  aAdminKey.value = '';
  aAdminEmail.value = '';
  aAdminPassword.value = '';
  aReadonly.value = true;
  aErrors.value = {};
  adoptOpen.value = true;
}

function validateAdopt(): boolean {
  const e: Record<string, string> = {};
  if (!aEngine.value) e.engine = t('sites.create.errEngine');
  const slug = aSlug.value.trim();
  if (!slug) e.slug = t('sites.create.errSlugRequired');
  else if (!SLUG_RE.test(slug)) e.slug = t('sites.create.errSlugFormat');
  const url = aBaseUrl.value.trim();
  if (!url || !/^https?:\/\//.test(url)) e.baseUrl = t('sites.adopt.errBaseUrl');
  if (aCredMode.value === 'key') {
    if (!aAdminKey.value.trim()) e.adminKey = t('sites.adopt.errAdminKey');
  } else {
    if (!EMAIL_RE.test(aAdminEmail.value.trim())) e.adminEmail = t('sites.create.errEmailFormat');
    if (!aAdminPassword.value) e.adminPassword = t('sites.adopt.errAdminPassword');
  }
  aErrors.value = e;
  return Object.keys(e).length === 0;
}

async function submitAdopt(): Promise<void> {
  if (!validateAdopt()) return;
  adoptSubmitting.value = true;
  try {
    const body: Record<string, unknown> = {
      slug: aSlug.value.trim(),
      baseUrl: aBaseUrl.value.trim().replace(/\/+$/, ''),
      engine: String(aEngine.value),
      readonly: aReadonly.value,
    };
    const label = aLabel.value.trim();
    if (label) body.label = label;
    if (aCredMode.value === 'key') body.adminApiKey = aAdminKey.value.trim();
    else {
      body.adminEmail = aAdminEmail.value.trim();
      body.adminPassword = aAdminPassword.value;
    }
    const res = await post<{ slug: string }>('/api/sites/adopt', body);
    toast.success(t('sites.adopt.success'));
    adoptOpen.value = false;
    void router.push(`/sites/${res.slug}`);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    adoptSubmitting.value = false;
  }
}
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 顶部标题栏 -->
    <div class="flex items-end justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">{{ t('sites.title') }}</h1>
        <p class="mt-0.5 text-xs text-muted">
          {{ t('sites.summaryCount', { n: visibleSites.length }) }}<span v-if="downCount" class="text-red">
            · {{ t('sites.summaryDown', { n: downCount }) }}</span
          ><span v-if="refreshing" class="ml-1 text-muted/50">· {{ t('sites.updating') }}</span>
        </p>
      </div>
      <div v-if="canWrite" class="flex items-center gap-2">
        <Button variant="outline" @click="openAdopt">
          <Link2 :size="14" />
          {{ t('sites.adopt.button') }}
        </Button>
        <Button variant="primary" @click="openCreate">
          <Plus :size="14" />
          {{ t('sites.new') }}
        </Button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="rp-panel overflow-hidden">
      <div v-if="loadError && !loading" class="p-8">
        <EmptyState :title="t('sites.loadFailed')" :description="loadError">
          <Button variant="outline" @click="() => refresh(true)">{{ t('common.retry') }}</Button>
        </EmptyState>
      </div>

      <div v-else-if="!loading && visibleSites.length === 0" class="p-8">
        <EmptyState
          :title="t('sites.empty.title')"
          :description="t('sites.empty.desc')"
          :icon="Server"
        >
          <div v-if="canWrite" class="flex items-center justify-center gap-2">
            <Button variant="outline" @click="openAdopt">
              <Link2 :size="14" />
              {{ t('sites.adopt.button') }}
            </Button>
            <Button variant="primary" @click="openCreate">
              <Plus :size="14" />
              {{ t('sites.new') }}
            </Button>
          </div>
        </EmptyState>
      </div>

      <Table
        v-else
        :columns="columns"
        :rows="rows"
        row-key="slug"
        :loading="loading"
        clickable
        @row-click="(row) => openSite(asSite(row))"
      >
        <template #cell-status="{ row }">
          <StatusDot :status="siteStatus(asSite(row))" />
        </template>

        <template #cell-site="{ row }">
          <div class="flex items-center gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="truncate font-sans text-[13px] font-medium text-text">{{
                  asSite(row).label
                }}</span>
                <Badge v-if="asSite(row).managed === 'external'" tone="amber" size="sm">{{ t('sites.externalManaged') }}</Badge>
                <Badge v-if="asSite(row).readonly" tone="muted" size="sm">
                  <Lock :size="10" /> {{ t('sites.readonlyBadge') }}
                </Badge>
              </div>
              <span class="truncate font-mono text-[11px] text-muted">{{ asSite(row).slug }}</span>
            </div>
          </div>
        </template>

        <template #cell-engine="{ row }">
          <Badge tone="muted" size="sm" mono>{{ asSite(row).engine }} · {{ asSite(row).version }}</Badge>
        </template>

        <template #cell-hostPort="{ row }">
          <span class="tnum text-[13px]">{{ asSite(row).hostPort ?? '—' }}</span>
        </template>

        <template #cell-usage="{ row }">
          <span class="tnum text-[13px]">
            {{ fmtInt(asSite(row).usage24h?.requests) }}
            <span class="text-muted/60"> / </span>
            <span class="text-muted">{{
              fmtCost(asSite(row).usage24h?.cost, asSite(row).usage24h?.costUnit ?? '')
            }}</span>
          </span>
        </template>

        <template #cell-job="{ row }">
          <Badge v-if="asSite(row).activeJob" tone="accent" size="sm">
            {{ jobKindText(asSite(row).activeJob!.kind) }} ·
            {{ jobStatusText(asSite(row).activeJob!.status) }}
          </Badge>
          <span v-else class="text-muted/40">—</span>
        </template>

        <template #cell-actions="{ row }">
          <div
            v-if="canWrite && asSite(row).managed !== 'external'"
            class="flex justify-end"
            @click.stop
          >
            <SiteRowActions
              :site="asSite(row)"
              :busy="busySlug === asSite(row).slug"
              @upgrade="onUpgrade(asSite(row))"
              @start="lifecycle(asSite(row), 'start')"
              @stop="lifecycle(asSite(row), 'stop')"
              @destroy="(keep: boolean) => onDestroy(asSite(row), keep)"
            />
          </div>
          <span v-else class="text-muted/30">—</span>
        </template>
      </Table>
    </div>

    <!-- 升级弹窗 -->
    <Modal v-model:open="upgradeOpen" :title="t('sites.upgrade.title')" width="420px">
      <div class="space-y-3">
        <p class="text-[13px] text-muted">
          {{ t('sites.upgrade.descBefore')
          }}<code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-text">{{
            upgradeSite?.slug
          }}</code>{{ t('sites.upgrade.descMid')
          }}<span class="font-mono text-xs text-muted">{{ upgradeSite?.version }}</span
          >{{ t('sites.upgrade.descAfter') }}
        </p>
        <Field
          :label="t('sites.upgrade.versionLabel')"
          required
          :error="upgradeErr"
          :hint="t('sites.upgrade.versionHint')"
        >
          <Input
            v-model="upgradeVersion"
            mono
            placeholder="v0.1.160"
            :disabled="upgradeBusy"
            autofocus
          />
        </Field>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="upgradeBusy" @click="upgradeOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="upgradeBusy" @click="submitUpgrade">{{ t('sites.upgrade.submit') }}</Button>
      </template>
    </Modal>

    <!-- 销毁确认（逐字输入 slug） -->
    <ConfirmDanger
      v-model:open="destroyOpen"
      :title="t('sites.destroy.title')"
      :confirm-text="destroySite?.slug ?? ''"
      :message="destroyMessage"
      :action-label="t('sites.destroy.action')"
      :loading="destroyBusy"
      @confirm="submitDestroy"
    />

    <!-- 新建站点向导 -->
    <Modal v-model:open="createOpen" :title="t('sites.create.title')" width="560px">
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field :label="t('sites.create.engineLabel')" required :error="errors.engine">
            <Select v-model="fEngine" :options="engineOptions" :disabled="submitting" />
          </Field>
          <Field
            :label="t('sites.create.versionLabel')"
            required
            :error="errors.version"
            :hint="t('sites.create.versionHintDropdown')"
          >
            <Select v-model="fVersionSelect" :options="versionOptions" :disabled="submitting" />
            <Input
              v-if="fVersionSelect === CUSTOM_VERSION"
              v-model="fVersion"
              mono
              class="mt-2"
              placeholder="0.1.160"
              :disabled="submitting"
            />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field :label="t('sites.create.labelLabel')" required :error="errors.label">
            <Input v-model="fLabel" :placeholder="t('sites.create.labelPlaceholder')" :disabled="submitting" />
          </Field>
          <Field
            label="slug"
            required
            :error="errors.slug"
            :hint="t('sites.create.slugHint')"
          >
            <Input v-model="fSlug" mono placeholder="my-site" :disabled="submitting" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field :label="t('sites.create.portLabel')" :error="errors.hostPort" :hint="t('sites.create.portHint')">
            <Input v-model="fPort" type="number" :placeholder="t('sites.create.portPlaceholder')" :disabled="submitting" />
          </Field>
          <Field
            :label="t('sites.create.emailLabel')"
            required
            :error="errors.adminEmail"
            :hint="t('sites.create.emailHint')"
          >
            <Input v-model="fEmail" type="email" placeholder="admin@example.com" :disabled="submitting" />
          </Field>
        </div>

        <div class="border-t border-border/70 pt-4">
          <p class="rp-microlabel mb-3">{{ t('sites.create.brandSection') }}</p>
          <div class="space-y-4">
            <Field :label="t('sites.create.siteNameLabel')" :error="errors.siteName">
              <Input v-model="fSiteName" :placeholder="t('sites.create.siteNamePlaceholder')" :disabled="submitting" />
            </Field>
            <Field :label="t('sites.create.announcementLabel')" :hint="t('sites.create.announcementHint')">
              <Input v-model="fAnnouncement" :placeholder="t('sites.create.announcementPlaceholder')" :disabled="submitting" />
            </Field>
          </div>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="submitting" @click="createOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="submitting" @click="submitCreate">{{ t('sites.create.submit') }}</Button>
      </template>
    </Modal>

    <!-- 接入已有站点（adopt） -->
    <Modal v-model:open="adoptOpen" :title="t('sites.adopt.title')" width="560px">
      <div class="space-y-4">
        <p class="rounded-lg border border-border bg-panel-2/50 px-3 py-2 text-xs leading-relaxed text-muted">
          {{ t('sites.adopt.intro') }}
        </p>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field :label="t('sites.create.engineLabel')" required :error="aErrors.engine">
            <Select v-model="aEngine" :options="engineOptions" :disabled="adoptSubmitting" />
          </Field>
          <Field :label="t('sites.adopt.baseUrlLabel')" required :error="aErrors.baseUrl" :hint="t('sites.adopt.baseUrlHint')">
            <Input v-model="aBaseUrl" mono placeholder="https://api.example.com" :disabled="adoptSubmitting" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="slug" required :error="aErrors.slug" :hint="t('sites.adopt.slugHint')">
            <Input v-model="aSlug" mono placeholder="my-legacy-site" :disabled="adoptSubmitting" />
          </Field>
          <Field :label="t('sites.create.labelLabel')">
            <Input v-model="aLabel" :placeholder="t('sites.create.labelPlaceholder')" :disabled="adoptSubmitting" />
          </Field>
        </div>

        <div class="border-t border-border/70 pt-4">
          <p class="rp-microlabel mb-3">{{ t('sites.adopt.credSection') }}</p>
          <p class="mb-3 rounded-lg border border-border bg-panel-2/40 px-3 py-2 text-[11px] leading-relaxed text-muted">
            {{ aEngine === 'newapi' ? t('sites.adopt.keyHelpNewapi') : t('sites.adopt.keyHelpSub2api') }}
          </p>
          <div class="space-y-4">
            <Field :label="t('sites.adopt.credModeLabel')">
              <Select v-model="aCredMode" :options="credModeOptions" :disabled="adoptSubmitting" />
            </Field>
            <Field
              v-if="aCredMode === 'key'"
              :label="t('sites.adopt.adminKeyLabel')"
              required
              :error="aErrors.adminKey"
              :hint="t('sites.adopt.adminKeyHint')"
            >
              <Input v-model="aAdminKey" type="password" mono :disabled="adoptSubmitting" />
            </Field>
            <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field :label="t('sites.adopt.adminEmailLabel')" required :error="aErrors.adminEmail">
                <Input v-model="aAdminEmail" type="email" placeholder="admin@example.com" :disabled="adoptSubmitting" />
              </Field>
              <Field :label="t('sites.adopt.adminPasswordLabel')" required :error="aErrors.adminPassword">
                <Input v-model="aAdminPassword" type="password" :disabled="adoptSubmitting" />
              </Field>
            </div>
          </div>
        </div>

        <label class="flex items-start gap-2 rounded-lg border border-border bg-panel-2/50 px-3 py-2.5 text-xs text-muted">
          <input v-model="aReadonly" type="checkbox" class="mt-0.5 accent-[var(--color-accent)]" />
          <span>
            <span class="font-medium text-text">{{ t('sites.adopt.readonlyLabel') }}</span><br />
            {{ t('sites.adopt.readonlyHint') }}
          </span>
        </label>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="adoptSubmitting" @click="adoptOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="adoptSubmitting" @click="submitAdopt">{{ t('sites.adopt.submit') }}</Button>
      </template>
    </Modal>
  </div>
</template>
