<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ArrowRight, CheckCircle2, CircleSlash, Layers, Lock, Megaphone, Minus, Package, Power,
  Radio, RefreshCw, ScanEye, SearchX, SkipForward, Sparkles, Trash2, TriangleAlert, XCircle,
} from 'lucide-vue-next';
import { get, post } from '../api/client';
import type {
  BatchPreviewResponse, MarketplaceTemplate, PreviewFlag, PreviewItem, SitesResponse, SiteView,
} from '../api/types';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton, StatusDot, Tabs, toast } from '../components/ui';
import type { SelectOption, TabItem } from '../components/ui';

/**
 * 批量操作（panel 核心价值）+ 跨站渠道矩阵。
 * 操作标签页：多选站点 → 一次操作扇出（公告/品牌/建渠道/改渠道/删渠道/启停/市场授权/生命周期）。
 * 矩阵标签页：行=渠道名，列=站，格=启用/停用/缺失 —— 一眼看清站群漂移。
 * 逐站结果回显；readonly 站被拒；权限/审计由单站写路径保证。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const tab = ref('ops');
const tabs = computed<TabItem[]>(() => [
  { key: 'ops', label: t('batch.tabOps') },
  { key: 'matrix', label: t('batch.tabMatrix') },
]);

// ---- 站点列表（两个标签页共用）----
const sites = ref<SiteView[]>([]);
const loading = ref(true);
const selected = ref<Set<string>>(new Set());

async function loadSites(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SitesResponse>('/api/sites', { silent: true });
    sites.value = (Array.isArray(res?.sites) ? res.sites : []).filter((s) => s.status !== 'destroyed');
  } catch {
    sites.value = [];
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void loadSites();
  void loadTemplates();
});

function toggle(slug: string): void {
  const next = new Set(selected.value);
  if (next.has(slug)) next.delete(slug);
  else next.add(slug);
  selected.value = next;
}
const allSelected = computed(() => sites.value.length > 0 && selected.value.size === sites.value.length);
function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(sites.value.map((s) => s.slug));
}
const selectedList = computed(() => Array.from(selected.value));
const selectedReadonly = computed(() => sites.value.filter((s) => selected.value.has(s.slug) && s.readonly).length);

// ---- 操作定义 ----
type ActionKind =
  | 'announcement' | 'branding' | 'channel.create' | 'channel.update'
  | 'channel.delete' | 'channel.toggle' | 'grant' | 'lifecycle';

interface ActionDef { value: ActionKind; label: string; icon: typeof Megaphone; desc: string; danger?: boolean }
const action = ref<ActionKind>('announcement');
const actionOptions = computed<ActionDef[]>(() => [
  { value: 'announcement', label: t('batch.actions.announcement'), icon: Megaphone, desc: t('batch.actions.announcementDesc') },
  { value: 'branding', label: t('batch.actions.branding'), icon: Sparkles, desc: t('batch.actions.brandingDesc') },
  { value: 'channel.create', label: t('batch.actions.channelCreate'), icon: Radio, desc: t('batch.actions.channelCreateDesc') },
  { value: 'channel.update', label: t('batch.actions.channelUpdate'), icon: RefreshCw, desc: t('batch.actions.channelUpdateDesc') },
  { value: 'channel.toggle', label: t('batch.actions.channelToggle'), icon: Power, desc: t('batch.actions.channelToggleDesc') },
  { value: 'channel.delete', label: t('batch.actions.channelDelete'), icon: Trash2, desc: t('batch.actions.channelDeleteDesc'), danger: true },
  { value: 'grant', label: t('batch.actions.grant'), icon: Package, desc: t('batch.actions.grantDesc') },
  { value: 'lifecycle', label: t('batch.actions.lifecycle'), icon: Power, desc: t('batch.actions.lifecycleDesc') },
]);

// 表单字段
const fAnnouncement = ref('');
const fSiteName = ref('');
const fLogoUrl = ref('');
const fBrandAnnouncement = ref('');
const chName = ref('');
const chProtocol = ref<string | number>('openai');
const chBaseUrl = ref('');
const chApiKey = ref('');
const chModels = ref('');
const toggleName = ref('');
const toggleEnabled = ref<string | number>('true');
// update
const upName = ref('');
const upBaseUrl = ref('');
const upApiKey = ref('');
const upModels = ref('');
// delete
const delName = ref('');
// lifecycle
const lifeOp = ref<string | number>('upgrade');
const lifeVersion = ref('');
// grant
const templates = ref<MarketplaceTemplate[]>([]);
const grantKey = ref<string | number>('');
const grantByoBaseUrl = ref('');
const grantByoApiKey = ref('');

const protocolOptions: SelectOption[] = [
  { value: 'openai', label: 'openai' }, { value: 'anthropic', label: 'anthropic' },
  { value: 'openai-responses', label: 'openai-responses' }, { value: 'gemini', label: 'gemini' },
];
const toggleOptions = computed<SelectOption[]>(() => [
  { value: 'true', label: t('batch.enable') }, { value: 'false', label: t('batch.disable') },
]);
const lifeOptions = computed<SelectOption[]>(() => [
  { value: 'upgrade', label: t('batch.lifeUpgrade') },
  { value: 'start', label: t('batch.lifeStart') },
  { value: 'stop', label: t('batch.lifeStop') },
]);
const templateOptions = computed<SelectOption[]>(() =>
  templates.value.map((tpl) => ({ value: tpl.key, label: `${tpl.title} (${tpl.source})` })),
);
const grantTemplate = computed(() => templates.value.find((tpl) => tpl.key === grantKey.value) ?? null);
const grantNeedsByo = computed(() => grantTemplate.value?.source === 'byo');

async function loadTemplates(): Promise<void> {
  try {
    const r = await get<{ templates: MarketplaceTemplate[] }>('/api/marketplace/templates', { silent: true });
    templates.value = Array.isArray(r?.templates) ? r.templates : [];
  } catch {
    templates.value = [];
  }
}

const canSubmit = computed(() => {
  if (!canWrite.value || selected.value.size === 0) return false;
  switch (action.value) {
    case 'announcement': return true;
    case 'branding': return Boolean(fSiteName.value.trim() || fLogoUrl.value.trim() || fBrandAnnouncement.value.trim());
    case 'channel.create': return Boolean(chName.value.trim() && chBaseUrl.value.trim() && chApiKey.value && chModels.value.trim());
    case 'channel.update': return Boolean(upName.value.trim() && (upBaseUrl.value.trim() || upApiKey.value || upModels.value.trim()));
    case 'channel.toggle': return Boolean(toggleName.value.trim());
    case 'channel.delete': return Boolean(delName.value.trim());
    case 'grant': return Boolean(grantKey.value && (!grantNeedsByo.value || (grantByoBaseUrl.value.trim() && grantByoApiKey.value)));
    case 'lifecycle': return lifeOp.value !== 'upgrade' || Boolean(lifeVersion.value.trim());
  }
  return false;
});

// ---- 提交 ----
interface BatchResult { slug: string; ok: boolean; detail?: string; error?: string }
const submitting = ref(false);
const results = ref<BatchResult[]>([]);
const summary = ref<{ total: number; ok: number; failed: number } | null>(null);

function buildBody(): Record<string, unknown> {
  const slugs = selectedList.value;
  switch (action.value) {
    case 'announcement': return { kind: 'announcement', slugs, announcement: fAnnouncement.value };
    case 'branding': {
      const b: Record<string, unknown> = { kind: 'branding', slugs };
      if (fSiteName.value.trim()) b.siteName = fSiteName.value.trim();
      if (fLogoUrl.value.trim()) b.logoUrl = fLogoUrl.value.trim();
      if (fBrandAnnouncement.value.trim()) b.announcement = fBrandAnnouncement.value.trim();
      return b;
    }
    case 'channel.create':
      return {
        kind: 'channel.create', slugs,
        channel: { name: chName.value.trim(), protocol: chProtocol.value, baseUrl: chBaseUrl.value.trim(), apiKey: chApiKey.value, models: chModels.value.split(/[\s,]+/).filter(Boolean) },
      };
    case 'channel.update': {
      const patch: Record<string, unknown> = {};
      if (upBaseUrl.value.trim()) patch.baseUrl = upBaseUrl.value.trim();
      if (upApiKey.value) patch.apiKey = upApiKey.value;
      if (upModels.value.trim()) patch.models = upModels.value.split(/[\s,]+/).filter(Boolean);
      return { kind: 'channel.update', slugs, channelName: upName.value.trim(), patch };
    }
    case 'channel.toggle':
      return { kind: 'channel.toggle', slugs, channelName: toggleName.value.trim(), enabled: toggleEnabled.value === 'true' };
    case 'channel.delete':
      return { kind: 'channel.delete', slugs, channelName: delName.value.trim() };
    case 'grant': {
      const g: Record<string, unknown> = { kind: 'grant', slugs, templateKey: grantKey.value };
      if (grantNeedsByo.value) g.byo = { baseUrl: grantByoBaseUrl.value.trim(), apiKey: grantByoApiKey.value };
      return g;
    }
    case 'lifecycle': {
      const l: Record<string, unknown> = { kind: 'lifecycle', slugs, op: lifeOp.value };
      if (lifeOp.value === 'upgrade') l.toVersion = lifeVersion.value.trim();
      return l;
    }
  }
  return {};
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  const danger = action.value === 'channel.delete';
  if (danger && !window.confirm(t('batch.confirmDelete', { name: delName.value.trim(), n: selected.value.size }))) return;
  submitting.value = true;
  results.value = [];
  summary.value = null;
  try {
    const res = await post<{ total: number; ok: number; failed: number; results: BatchResult[] }>('/api/sites/batch', buildBody());
    results.value = res.results;
    summary.value = { total: res.total, ok: res.ok, failed: res.failed };
    if (res.failed === 0) toast.success(t('batch.allOk', { n: res.ok }));
    else toast.info(t('batch.partial', { ok: res.ok, failed: res.failed }));
    preview.value = null; // 真执行后预览已失效
    await loadSites();
  } catch {
    /* client 已弹错误 toast */
  } finally {
    submitting.value = false;
  }
}

// ---- 干跑预览（dryRun）：读操作，先看每站将发生什么，再用同一 payload 确认执行 ----
const preview = ref<BatchPreviewResponse | null>(null);
const previewing = ref(false);

async function runPreview(): Promise<void> {
  if (!canSubmit.value) return;
  previewing.value = true;
  preview.value = null;
  results.value = [];
  summary.value = null;
  try {
    preview.value = await post<BatchPreviewResponse>('/api/sites/batch', { ...buildBody(), dryRun: true });
  } catch {
    /* client 已弹错误 toast */
  } finally {
    previewing.value = false;
  }
}

/** 预览里是否存在“会实际改动”的条目（noop/miss/skip 不算变更；conflict 与普通变更算） */
const previewHasChange = computed(() => {
  const p = preview.value;
  if (!p) return false;
  return p.results.some(
    (r) => r.ok && (r.preview ?? []).some((i) => i.flag === undefined || i.flag === 'conflict'),
  );
});

type FlagTone = 'muted' | 'amber' | 'accent';
/** 变更标记 → 图标 + 颜色 + 徽标色 + 文案 */
function flagMeta(flag?: PreviewFlag): { icon: typeof ArrowRight; cls: string; tone: FlagTone; label: string } {
  switch (flag) {
    case 'noop': return { icon: Minus, cls: 'text-muted', tone: 'muted', label: t('batch.preview.flags.noop') };
    case 'conflict': return { icon: TriangleAlert, cls: 'text-amber', tone: 'amber', label: t('batch.preview.flags.conflict') };
    case 'blocked': return { icon: Lock, cls: 'text-amber', tone: 'amber', label: t('batch.preview.flags.blocked') };
    case 'miss': return { icon: SearchX, cls: 'text-muted', tone: 'muted', label: t('batch.preview.flags.miss') };
    case 'skip': return { icon: SkipForward, cls: 'text-muted', tone: 'muted', label: t('batch.preview.flags.skip') };
    default: return { icon: ArrowRight, cls: 'text-accent', tone: 'accent', label: t('batch.preview.flags.change') };
  }
}

/** 一条预览的人类可读标题（apiKey 只标“将轮换”，绝不回显任何值） */
function itemLabel(item: PreviewItem): string {
  switch (item.field) {
    case 'apiKey': return t('batch.preview.rotateKey');
    case 'siteName': return t('batch.preview.f.siteName');
    case 'logoUrl': return t('batch.preview.f.logoUrl');
    case 'announcement': return t('batch.preview.f.announcement');
    case 'baseUrl': return t('batch.preview.f.baseUrl');
    case 'models': return t('batch.preview.f.models');
    case 'priority': return t('batch.preview.f.priority');
    case 'weight': return t('batch.preview.f.weight');
    case 'enabled': return t('batch.preview.f.enabled');
    case 'version': return t('batch.preview.f.version');
    case 'status': return t('batch.preview.f.status');
    case 'create': return t('batch.preview.willCreate', { name: item.target });
    case 'delete': return t('batch.preview.willDelete', { name: item.target });
  }
  if (item.flag === 'miss') return t('batch.preview.missDesc', { name: item.target });
  if (item.flag === 'skip') return t('batch.preview.skipDesc');
  return item.target;
}

/** 该条是否有 from→to 值可展示（apiKey/纯 flag 条目无值） */
function hasDelta(item: PreviewItem): boolean {
  if (item.field === 'apiKey') return false;
  return item.from !== undefined || item.to !== undefined;
}

function siteStatus(s: SiteView): string {
  if (s.status === 'active' && s.ok === false) return 'down';
  return s.status;
}

// ---- 渠道矩阵 ----
interface MatrixResp {
  sites: Array<{ slug: string; label: string; ok: boolean }>;
  channels: Array<{ name: string; protocol: string; presence: Record<string, 'enabled' | 'disabled' | 'absent'> }>;
}
const matrix = ref<MatrixResp | null>(null);
const matrixLoading = ref(false);
async function loadMatrix(): Promise<void> {
  matrixLoading.value = true;
  try {
    matrix.value = await get<MatrixResp>('/api/sites/channel-matrix', { silent: true });
  } catch {
    matrix.value = null;
  } finally {
    matrixLoading.value = false;
  }
}
function onTab(k: string): void {
  tab.value = k;
  if (k === 'matrix' && matrix.value === null) void loadMatrix();
}
function cellClass(state: string): string {
  if (state === 'enabled') return 'bg-green/15 text-green';
  if (state === 'disabled') return 'bg-amber/15 text-amber';
  return 'text-muted/30';
}
function cellText(state: string): string {
  if (state === 'enabled') return '●';
  if (state === 'disabled') return '○';
  return '—';
}
</script>

<template>
  <div class="rp-page space-y-5">
    <div>
      <h1 class="flex items-center gap-2 text-[15px] font-semibold">
        <Layers :size="17" class="text-accent" /> {{ t('batch.title') }}
      </h1>
      <p class="mt-0.5 text-xs text-muted">{{ t('batch.subtitle') }}</p>
    </div>

    <Tabs :model-value="tab" :tabs="tabs" @update:model-value="onTab" />

    <!-- ===== 批量操作 ===== -->
    <div v-if="tab === 'ops'" class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,340px)_1fr]">
      <!-- 左：选站 -->
      <section class="rp-panel flex flex-col overflow-hidden">
        <header class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-semibold">{{ t('batch.selectSites') }}</h2>
          <button v-if="sites.length > 0" type="button" class="text-xs text-accent hover:underline" @click="toggleAll">
            {{ allSelected ? t('batch.clearAll') : t('batch.selectAll') }}
          </button>
        </header>
        <div v-if="loading" class="p-4"><Skeleton :lines="5" /></div>
        <div v-else-if="sites.length === 0" class="p-8">
          <EmptyState :title="t('batch.noSites')" :description="t('batch.noSitesDesc')" />
        </div>
        <div v-else class="max-h-[520px] divide-y divide-border/50 overflow-y-auto">
          <label
            v-for="s in sites" :key="s.slug"
            class="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-panel-2/50"
            :class="selected.has(s.slug) ? 'bg-accent/8' : ''"
          >
            <input type="checkbox" class="accent-[var(--color-accent)]" :checked="selected.has(s.slug)" @change="toggle(s.slug)" />
            <StatusDot :status="siteStatus(s)" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[13px] font-medium">{{ s.label }}</span>
                <Badge v-if="s.readonly" tone="muted" size="sm"><Lock :size="9" /> {{ t('sites.readonlyBadge') }}</Badge>
              </div>
              <span class="truncate font-mono text-[11px] text-muted">{{ s.slug }}</span>
            </div>
          </label>
        </div>
        <footer v-if="sites.length > 0" class="border-t border-border px-4 py-2.5 text-xs text-muted">
          {{ t('batch.selectedCount', { n: selected.size }) }}
          <span v-if="selectedReadonly > 0" class="text-amber"> · {{ t('batch.readonlyWarn', { n: selectedReadonly }) }}</span>
        </footer>
      </section>

      <!-- 右：操作 + 结果 -->
      <section class="space-y-5">
        <div class="rp-panel p-4">
          <p class="rp-microlabel mb-3">{{ t('batch.chooseAction') }}</p>
          <div class="grid grid-cols-2 gap-2 xl:grid-cols-4">
            <button
              v-for="a in actionOptions" :key="a.value" type="button"
              class="flex flex-col gap-1 rounded-xl border p-2.5 text-left transition-colors"
              :class="action === a.value ? (a.danger ? 'border-red/50 bg-red/8' : 'border-accent/50 bg-accent/8') : 'border-border hover:border-border-2'"
              @click="action = a.value"
            >
              <component :is="a.icon" :size="15" :class="action === a.value ? (a.danger ? 'text-red' : 'text-accent') : 'text-muted'" />
              <span class="text-[12px] font-medium leading-tight">{{ a.label }}</span>
            </button>
          </div>
          <p class="mt-2 text-[11px] text-muted">{{ actionOptions.find((a) => a.value === action)?.desc }}</p>

          <div class="mt-4 space-y-4 border-t border-border/60 pt-4">
            <template v-if="action === 'announcement'">
              <Field :label="t('batch.announcementLabel')" :hint="t('batch.announcementHint')">
                <textarea v-model="fAnnouncement" rows="4" class="w-full resize-y rounded-lg border border-border bg-panel-2/50 px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/60" :placeholder="t('batch.announcementPlaceholder')"></textarea>
              </Field>
            </template>

            <template v-else-if="action === 'branding'">
              <Field :label="t('batch.siteNameLabel')" :hint="t('batch.brandingHint')"><Input v-model="fSiteName" :placeholder="t('batch.siteNamePlaceholder')" /></Field>
              <Field label="Logo URL"><Input v-model="fLogoUrl" mono placeholder="https://.../logo.png" /></Field>
              <Field :label="t('batch.announcementLabel')"><Input v-model="fBrandAnnouncement" :placeholder="t('batch.announcementPlaceholder')" /></Field>
            </template>

            <template v-else-if="action === 'channel.create'">
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field :label="t('batch.channelName')" required><Input v-model="chName" :placeholder="t('batch.channelNamePlaceholder')" /></Field>
                <Field :label="t('batch.protocol')" required><Select v-model="chProtocol" :options="protocolOptions" /></Field>
              </div>
              <Field label="Base URL" required><Input v-model="chBaseUrl" mono placeholder="https://upstream.example.com/v1" /></Field>
              <Field :label="t('batch.apiKey')" required :hint="t('batch.apiKeyHint')"><Input v-model="chApiKey" type="password" mono /></Field>
              <Field :label="t('batch.models')" required :hint="t('batch.modelsHint')"><Input v-model="chModels" mono placeholder="gpt-4o, claude-3-5-sonnet" /></Field>
            </template>

            <template v-else-if="action === 'channel.update'">
              <Field :label="t('batch.channelName')" required :hint="t('batch.updateMatchHint')"><Input v-model="upName" :placeholder="t('batch.channelNamePlaceholder')" /></Field>
              <p class="text-[11px] text-muted">{{ t('batch.updateFillHint') }}</p>
              <Field label="Base URL"><Input v-model="upBaseUrl" mono placeholder="https://new-upstream.example.com/v1" /></Field>
              <Field :label="t('batch.rotateKey')" :hint="t('batch.rotateKeyHint')"><Input v-model="upApiKey" type="password" mono /></Field>
              <Field :label="t('batch.models')" :hint="t('batch.modelsHint')"><Input v-model="upModels" mono placeholder="gpt-4o, gpt-4o-mini" /></Field>
            </template>

            <template v-else-if="action === 'channel.toggle'">
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field :label="t('batch.channelName')" required :hint="t('batch.channelToggleHint')"><Input v-model="toggleName" :placeholder="t('batch.channelNamePlaceholder')" /></Field>
                <Field :label="t('batch.state')" required><Select v-model="toggleEnabled" :options="toggleOptions" /></Field>
              </div>
            </template>

            <template v-else-if="action === 'channel.delete'">
              <Field :label="t('batch.channelName')" required :hint="t('batch.deleteHint')"><Input v-model="delName" :placeholder="t('batch.channelNamePlaceholder')" /></Field>
              <p class="rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-[11px] leading-relaxed text-red/90">{{ t('batch.deleteWarn') }}</p>
            </template>

            <template v-else-if="action === 'grant'">
              <Field :label="t('batch.template')" required :hint="t('batch.grantHint')">
                <Select v-model="grantKey" :options="templateOptions" :placeholder="t('batch.selectTemplate')" />
              </Field>
              <template v-if="grantNeedsByo">
                <Field label="Base URL" required><Input v-model="grantByoBaseUrl" mono placeholder="https://upstream.example.com/v1" /></Field>
                <Field :label="t('batch.apiKey')" required><Input v-model="grantByoApiKey" type="password" mono /></Field>
              </template>
            </template>

            <template v-else-if="action === 'lifecycle'">
              <p class="rounded-lg border border-border bg-panel-2/40 px-3 py-2 text-[11px] text-muted">{{ t('batch.lifecycleNote') }}</p>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field :label="t('batch.lifeOp')" required><Select v-model="lifeOp" :options="lifeOptions" /></Field>
                <Field v-if="lifeOp === 'upgrade'" :label="t('batch.toVersion')" required :hint="t('batch.toVersionHint')"><Input v-model="lifeVersion" mono placeholder="0.1.161" /></Field>
              </div>
            </template>
          </div>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p class="text-xs text-muted">{{ t('batch.willApply', { n: selected.size }) }}</p>
            <div class="flex items-center gap-2">
              <Button variant="outline" :disabled="!canSubmit" :loading="previewing" @click="runPreview">
                <ScanEye :size="14" /> {{ t('batch.dryRun') }}
              </Button>
              <Button :variant="action === 'channel.delete' ? 'danger' : 'primary'" :disabled="!canSubmit" :loading="submitting" @click="submit">
                {{ t('batch.apply') }}
              </Button>
            </div>
          </div>
        </div>

        <!-- 干跑预览：每站 × 变更项，flag 用颜色/图标区分；表下同一 payload 确认执行 -->
        <div v-if="preview" class="rp-panel overflow-hidden">
          <header class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <ScanEye :size="15" class="text-accent" />
            <h2 class="text-[13px] font-semibold">{{ t('batch.preview.title') }}</h2>
            <Badge tone="muted" size="sm">{{ t('batch.preview.siteCount', { n: preview.total }) }}</Badge>
            <Badge v-if="preview.failed > 0" tone="red" size="sm">{{ t('batch.preview.unreachable', { n: preview.failed }) }}</Badge>
            <span class="ml-auto text-[11px] text-muted">{{ t('batch.preview.readNote') }}</span>
          </header>

          <div class="divide-y divide-border/50">
            <div v-for="r in preview.results" :key="r.slug" class="px-4 py-3">
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-[12px] font-medium">{{ r.slug }}</span>
                <Badge v-if="r.blocked" tone="amber" size="sm"><Lock :size="9" /> {{ t('batch.preview.flags.blocked') }}</Badge>
                <XCircle v-if="!r.ok" :size="13" class="text-red" />
              </div>

              <p v-if="!r.ok" class="mt-1 text-[11.5px] text-red/90">{{ r.error }}</p>
              <p v-else-if="(r.preview ?? []).length === 0" class="mt-1 text-[11.5px] text-muted">{{ t('batch.preview.noChange') }}</p>

              <ul v-else class="mt-1.5 space-y-1.5">
                <li v-for="(item, idx) in r.preview" :key="idx" class="flex items-start gap-2">
                  <component :is="flagMeta(item.flag).icon" :size="13" class="mt-0.5 shrink-0" :class="flagMeta(item.flag).cls" />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-[12px]">{{ itemLabel(item) }}</span>
                      <Badge v-if="item.flag" :tone="flagMeta(item.flag).tone" size="sm">{{ flagMeta(item.flag).label }}</Badge>
                    </div>
                    <div v-if="hasDelta(item)" class="mt-0.5 flex flex-wrap items-center gap-1 font-mono text-[11px]">
                      <span v-if="item.from !== undefined" class="text-muted">{{ item.from || '∅' }}</span>
                      <ArrowRight v-if="item.from !== undefined && item.to !== undefined" :size="11" class="text-muted/50" />
                      <span v-if="item.to !== undefined" class="text-text/85">{{ item.to || '∅' }}</span>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>

          <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p class="text-[11.5px]" :class="previewHasChange ? 'text-muted' : 'text-amber'">
              {{ previewHasChange ? t('batch.preview.confirmHint', { n: preview.ok }) : t('batch.preview.nothingToDo') }}
            </p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" @click="preview = null">{{ t('batch.preview.dismiss') }}</Button>
              <Button
                :variant="action === 'channel.delete' ? 'danger' : 'primary'"
                size="sm"
                :disabled="!canSubmit"
                :loading="submitting"
                @click="submit"
              >
                {{ t('batch.preview.confirm') }}
              </Button>
            </div>
          </footer>
        </div>

        <div v-if="summary" class="rp-panel overflow-hidden">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-[13px] font-semibold">{{ t('batch.results') }}</h2>
            <Badge tone="green" size="sm">{{ t('batch.okBadge', { n: summary.ok }) }}</Badge>
            <Badge v-if="summary.failed > 0" tone="red" size="sm">{{ t('batch.failBadge', { n: summary.failed }) }}</Badge>
          </header>
          <ul class="divide-y divide-border/50">
            <li v-for="r in results" :key="r.slug" class="flex items-center gap-3 px-4 py-2.5">
              <CheckCircle2 v-if="r.ok" :size="15" class="shrink-0 text-green" />
              <XCircle v-else :size="15" class="shrink-0 text-red" />
              <span class="w-40 shrink-0 truncate font-mono text-[12px]">{{ r.slug }}</span>
              <span class="min-w-0 flex-1 truncate text-xs" :class="r.ok ? 'text-muted' : 'text-red/90'">{{ r.ok ? (r.detail ?? t('batch.done')) : r.error }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- ===== 渠道矩阵 ===== -->
    <div v-else class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 class="text-[13px] font-semibold">{{ t('batch.matrixTitle') }}</h2>
          <p class="mt-0.5 text-[11px] text-muted">{{ t('batch.matrixDesc') }}</p>
        </div>
        <Button size="sm" variant="ghost" :loading="matrixLoading" @click="loadMatrix"><RefreshCw :size="13" /> {{ t('common.refresh') }}</Button>
      </header>
      <div v-if="matrixLoading && !matrix" class="p-4"><Skeleton :lines="6" /></div>
      <div v-else-if="!matrix || matrix.channels.length === 0" class="p-8">
        <EmptyState :title="t('batch.matrixEmpty')" :description="t('batch.matrixEmptyDesc')" :icon="CircleSlash" />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="border-b border-border">
              <th class="sticky left-0 z-10 bg-panel px-4 py-2.5 text-left font-medium text-muted">{{ t('batch.channelName') }}</th>
              <th v-for="s in matrix.sites" :key="s.slug" class="px-2 py-2.5 text-center font-medium" :class="s.ok ? 'text-muted' : 'text-red/70'">
                <span class="block max-w-[90px] truncate" :title="s.label">{{ s.label }}</span>
                <span v-if="!s.ok" class="text-[9px]">{{ t('batch.siteUnreachable') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in matrix.channels" :key="c.name + c.protocol" class="border-b border-border/40 hover:bg-panel-2/40">
              <td class="sticky left-0 z-10 bg-panel px-4 py-2">
                <span class="font-medium">{{ c.name }}</span>
                <Badge tone="muted" size="sm" mono class="ml-1.5">{{ c.protocol }}</Badge>
              </td>
              <td v-for="s in matrix.sites" :key="s.slug" class="px-2 py-2 text-center">
                <span class="inline-flex h-6 w-6 items-center justify-center rounded-md text-[13px]" :class="cellClass(c.presence[s.slug] ?? 'absent')" :title="c.presence[s.slug]">
                  {{ cellText(c.presence[s.slug] ?? 'absent') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="flex flex-wrap items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1"><span class="text-green">●</span> {{ t('batch.legendEnabled') }}</span>
        <span class="inline-flex items-center gap-1"><span class="text-amber">○</span> {{ t('batch.legendDisabled') }}</span>
        <span class="inline-flex items-center gap-1"><span class="text-muted/40">—</span> {{ t('batch.legendAbsent') }}</span>
      </footer>
    </div>
  </div>
</template>
