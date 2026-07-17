<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ComputedRef } from 'vue';
import { useRouter } from 'vue-router';
import { Plus, Server } from 'lucide-vue-next';
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
    if (initial) loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => {
  void refresh(true);
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
const columns: TableColumn[] = [
  { key: 'status', label: '状态', width: '92px' },
  { key: 'site', label: '站点' },
  { key: 'engine', label: '引擎 / 版本', width: '168px' },
  { key: 'hostPort', label: '端口', align: 'right', width: '80px' },
  { key: 'usage', label: '24h 请求 / 成本', align: 'right', width: '176px' },
  { key: 'job', label: '任务', width: '128px' },
  { key: 'actions', label: '', align: 'right', width: '52px' },
];

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
  const map: Record<string, string> = {
    provision: '开站',
    upgrade: '升级',
    start: '启动',
    stop: '停止',
    destroy: '销毁',
  };
  return map[kind] ?? kind;
}
function jobStatusText(status: string): string {
  return status === 'running' ? '执行中' : status === 'queued' ? '排队中' : status;
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
    toast.success('任务已排队，可在任务页跟踪');
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
    upgradeErr.value = '请填写目标版本';
    return;
  }
  if (v === s.version) {
    upgradeErr.value = '目标版本与当前版本相同';
    return;
  }
  upgradeBusy.value = true;
  try {
    await post<JobRef>(`/api/sites/${s.slug}/upgrade`, { toVersion: v });
    toast.success('任务已排队，可在任务页跟踪');
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
  destroyKeepData.value
    ? '将停止并移除站点容器，但保留数据卷（数据库/上传），可日后重建恢复。'
    : '将永久删除该站点的容器与数据卷，数据无法恢复。',
);
async function submitDestroy(): Promise<void> {
  const s = destroySite.value;
  if (!s) return;
  destroyBusy.value = true;
  try {
    await del(`/api/sites/${s.slug}`, { confirm: s.slug, keepData: destroyKeepData.value });
    toast.success('任务已排队，可在任务页跟踪');
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
const engineOptions: SelectOption[] = [
  { value: 'sub2api', label: 'sub2api（推荐）' },
  { value: 'newapi', label: 'newapi' },
];

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

function openCreate(): void {
  fEngine.value = 'sub2api';
  fVersion.value = '';
  fSlug.value = '';
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
  if (!fEngine.value) e.engine = '请选择引擎';
  if (!fVersion.value.trim()) e.version = '请填写版本';
  const slug = fSlug.value.trim();
  if (!slug) e.slug = '请填写 slug';
  else if (!SLUG_RE.test(slug)) e.slug = '仅小写字母/数字/连字符，2–32 位，须以字母或数字开头';
  if (!fLabel.value.trim()) e.label = '请填写显示名称';
  if (fPort.value !== '' && fPort.value !== null) {
    const p = Number(fPort.value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.hostPort = '端口需为 1–65535 的整数';
  }
  const email = fEmail.value.trim();
  if (!email) e.adminEmail = '请填写管理员邮箱';
  else if (!EMAIL_RE.test(email)) e.adminEmail = '邮箱格式不正确';
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
    toast.success('开站任务已创建');
    createOpen.value = false;
    void router.push(`/sites/${res.slug}`);
  } catch {
    /* client 已弹错误 toast */
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 顶部标题栏 -->
    <div class="flex items-end justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">站点</h1>
        <p class="mt-0.5 text-xs text-muted">
          共 {{ visibleSites.length }} 个站点<span v-if="downCount" class="text-red">
            · {{ downCount }} 个异常</span
          ><span v-if="refreshing" class="ml-1 text-muted/50">· 更新中…</span>
        </p>
      </div>
      <Button v-if="canWrite" variant="primary" @click="openCreate">
        <Plus :size="14" />
        新建站点
      </Button>
    </div>

    <!-- 列表 -->
    <div class="rp-panel overflow-hidden">
      <div v-if="loadError && !loading" class="p-8">
        <EmptyState title="加载失败" :description="loadError">
          <Button variant="outline" @click="() => refresh(true)">重试</Button>
        </EmptyState>
      </div>

      <div v-else-if="!loading && visibleSites.length === 0" class="p-8">
        <EmptyState
          title="还没有站点"
          description="新建第一个中转站，或用 CLI 接管已有的存量站点。"
          :icon="Server"
        >
          <Button v-if="canWrite" variant="primary" @click="openCreate">
            <Plus :size="14" />
            新建站点
          </Button>
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
                <Badge v-if="asSite(row).managed === 'external'" tone="amber" size="sm">外部接管</Badge>
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
    <Modal v-model:open="upgradeOpen" title="升级站点" width="420px">
      <div class="space-y-3">
        <p class="text-[13px] text-muted">
          站点
          <code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-text">{{
            upgradeSite?.slug
          }}</code>
          将升级到指定版本，当前版本
          <span class="font-mono text-xs text-muted">{{ upgradeSite?.version }}</span>。
        </p>
        <Field label="目标版本" required :error="upgradeErr" hint="镜像 tag，如 v0.1.160">
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
        <Button variant="ghost" :disabled="upgradeBusy" @click="upgradeOpen = false">取消</Button>
        <Button variant="primary" :loading="upgradeBusy" @click="submitUpgrade">升级</Button>
      </template>
    </Modal>

    <!-- 销毁确认（逐字输入 slug） -->
    <ConfirmDanger
      v-model:open="destroyOpen"
      title="销毁站点"
      :confirm-text="destroySite?.slug ?? ''"
      :message="destroyMessage"
      action-label="销毁站点"
      :loading="destroyBusy"
      @confirm="submitDestroy"
    />

    <!-- 新建站点向导 -->
    <Modal v-model:open="createOpen" title="新建站点" width="560px">
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="引擎" required :error="errors.engine">
            <Select v-model="fEngine" :options="engineOptions" :disabled="submitting" />
          </Field>
          <Field label="版本" required :error="errors.version" hint="镜像 tag，如 v0.1.160">
            <Input v-model="fVersion" mono placeholder="v0.1.160" :disabled="submitting" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="slug"
            required
            :error="errors.slug"
            hint="小写字母/数字/连字符，2–32 位，URL 与容器标识"
          >
            <Input v-model="fSlug" mono placeholder="my-site" :disabled="submitting" />
          </Field>
          <Field label="显示名称" required :error="errors.label">
            <Input v-model="fLabel" placeholder="我的中转站" :disabled="submitting" />
          </Field>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="端口" :error="errors.hostPort" hint="留空则自动分配可用端口">
            <Input v-model="fPort" type="number" placeholder="自动分配" :disabled="submitting" />
          </Field>
          <Field label="管理员邮箱" required :error="errors.adminEmail" hint="站点初始管理员账号">
            <Input v-model="fEmail" type="email" placeholder="admin@example.com" :disabled="submitting" />
          </Field>
        </div>

        <div class="border-t border-border/70 pt-4">
          <p class="rp-microlabel mb-3">品牌（可选）</p>
          <div class="space-y-4">
            <Field label="站点名称" :error="errors.siteName">
              <Input v-model="fSiteName" placeholder="展示在站点前台的名称" :disabled="submitting" />
            </Field>
            <Field label="公告" hint="展示在站点前台的公告文案">
              <Input v-model="fAnnouncement" placeholder="可留空" :disabled="submitting" />
            </Field>
          </div>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="submitting" @click="createOpen = false">取消</Button>
        <Button variant="primary" :loading="submitting" @click="submitCreate">创建站点</Button>
      </template>
    </Modal>
  </div>
</template>
