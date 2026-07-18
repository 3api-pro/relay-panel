<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { CheckCircle2, Layers, Lock, Megaphone, Radio, Sparkles, XCircle } from 'lucide-vue-next';
import { get, post } from '../api/client';
import type { SitesResponse, SiteView } from '../api/types';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton, StatusDot, toast } from '../components/ui';
import type { SelectOption } from '../components/ui';

/**
 * 批量操作（panel 核心价值）：多选站点 → 一次操作扇出到全部。
 * 目前支持：公告、品牌、建渠道、按名启停渠道。逐站结果回显，readonly 站会被拒。
 * 数据源 GET /api/sites；提交 POST /api/sites/batch。
 */
const { t } = useI18n();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

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
onMounted(loadSites);

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

// ---- 操作 ----
type ActionKind = 'announcement' | 'branding' | 'channel.create' | 'channel.toggle';
const action = ref<ActionKind>('announcement');
const actionOptions = computed<{ value: ActionKind; label: string; icon: typeof Megaphone; desc: string }[]>(() => [
  { value: 'announcement', label: t('batch.actions.announcement'), icon: Megaphone, desc: t('batch.actions.announcementDesc') },
  { value: 'branding', label: t('batch.actions.branding'), icon: Sparkles, desc: t('batch.actions.brandingDesc') },
  { value: 'channel.create', label: t('batch.actions.channelCreate'), icon: Radio, desc: t('batch.actions.channelCreateDesc') },
  { value: 'channel.toggle', label: t('batch.actions.channelToggle'), icon: Radio, desc: t('batch.actions.channelToggleDesc') },
]);

// 各操作字段
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

const protocolOptions: SelectOption[] = [
  { value: 'openai', label: 'openai' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'gemini', label: 'gemini' },
];
const toggleOptions = computed<SelectOption[]>(() => [
  { value: 'true', label: t('batch.enable') },
  { value: 'false', label: t('batch.disable') },
]);

const canSubmit = computed(() => {
  if (!canWrite.value || selected.value.size === 0) return false;
  switch (action.value) {
    case 'announcement':
      return true;
    case 'branding':
      return Boolean(fSiteName.value.trim() || fLogoUrl.value.trim() || fBrandAnnouncement.value.trim());
    case 'channel.create':
      return Boolean(chName.value.trim() && chBaseUrl.value.trim() && chApiKey.value && chModels.value.trim());
    case 'channel.toggle':
      return Boolean(toggleName.value.trim());
  }
  return false;
});

// ---- 提交 ----
interface BatchResult {
  slug: string;
  ok: boolean;
  detail?: string;
  error?: string;
}
const submitting = ref(false);
const results = ref<BatchResult[]>([]);
const summary = ref<{ total: number; ok: number; failed: number } | null>(null);

function buildBody(): Record<string, unknown> {
  const slugs = selectedList.value;
  switch (action.value) {
    case 'announcement':
      return { kind: 'announcement', slugs, announcement: fAnnouncement.value };
    case 'branding': {
      const b: Record<string, unknown> = { kind: 'branding', slugs };
      if (fSiteName.value.trim()) b.siteName = fSiteName.value.trim();
      if (fLogoUrl.value.trim()) b.logoUrl = fLogoUrl.value.trim();
      if (fBrandAnnouncement.value.trim()) b.announcement = fBrandAnnouncement.value.trim();
      return b;
    }
    case 'channel.create':
      return {
        kind: 'channel.create',
        slugs,
        channel: {
          name: chName.value.trim(),
          protocol: chProtocol.value,
          baseUrl: chBaseUrl.value.trim(),
          apiKey: chApiKey.value,
          models: chModels.value.split(/[\s,]+/).filter(Boolean),
        },
      };
    case 'channel.toggle':
      return { kind: 'channel.toggle', slugs, channelName: toggleName.value.trim(), enabled: toggleEnabled.value === 'true' };
  }
  return {};
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  results.value = [];
  summary.value = null;
  try {
    const res = await post<{ total: number; ok: number; failed: number; results: BatchResult[] }>(
      '/api/sites/batch',
      buildBody(),
    );
    results.value = res.results;
    summary.value = { total: res.total, ok: res.ok, failed: res.failed };
    if (res.failed === 0) toast.success(t('batch.allOk', { n: res.ok }));
    else toast.info(t('batch.partial', { ok: res.ok, failed: res.failed }));
    await loadSites();
  } catch {
    /* client 已弹错误 toast */
  } finally {
    submitting.value = false;
  }
}

function siteStatus(s: SiteView): string {
  if (s.status === 'active' && s.ok === false) return 'down';
  return s.status;
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

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,340px)_1fr]">
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
            v-for="s in sites"
            :key="s.slug"
            class="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-panel-2/50"
            :class="selected.has(s.slug) ? 'bg-accent/8' : ''"
          >
            <input
              type="checkbox"
              class="accent-[var(--color-accent)]"
              :checked="selected.has(s.slug)"
              @change="toggle(s.slug)"
            />
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
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="a in actionOptions"
              :key="a.value"
              type="button"
              class="flex items-start gap-2 rounded-xl border p-3 text-left transition-colors"
              :class="action === a.value ? 'border-accent/50 bg-accent/8' : 'border-border hover:border-border-2'"
              @click="action = a.value"
            >
              <component :is="a.icon" :size="15" class="mt-0.5 shrink-0" :class="action === a.value ? 'text-accent' : 'text-muted'" />
              <span class="min-w-0">
                <span class="block text-[13px] font-medium">{{ a.label }}</span>
                <span class="block text-[11px] leading-snug text-muted">{{ a.desc }}</span>
              </span>
            </button>
          </div>

          <div class="mt-4 space-y-4 border-t border-border/60 pt-4">
            <!-- 公告 -->
            <template v-if="action === 'announcement'">
              <Field :label="t('batch.announcementLabel')" :hint="t('batch.announcementHint')">
                <textarea
                  v-model="fAnnouncement"
                  rows="4"
                  class="w-full resize-y rounded-lg border border-border bg-panel-2/50 px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/60"
                  :placeholder="t('batch.announcementPlaceholder')"
                ></textarea>
              </Field>
            </template>

            <!-- 品牌 -->
            <template v-else-if="action === 'branding'">
              <Field :label="t('batch.siteNameLabel')" :hint="t('batch.brandingHint')">
                <Input v-model="fSiteName" :placeholder="t('batch.siteNamePlaceholder')" />
              </Field>
              <Field label="Logo URL">
                <Input v-model="fLogoUrl" mono placeholder="https://.../logo.png" />
              </Field>
              <Field :label="t('batch.announcementLabel')">
                <Input v-model="fBrandAnnouncement" :placeholder="t('batch.announcementPlaceholder')" />
              </Field>
            </template>

            <!-- 建渠道 -->
            <template v-else-if="action === 'channel.create'">
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field :label="t('batch.channelName')" required>
                  <Input v-model="chName" :placeholder="t('batch.channelNamePlaceholder')" />
                </Field>
                <Field :label="t('batch.protocol')" required>
                  <Select v-model="chProtocol" :options="protocolOptions" />
                </Field>
              </div>
              <Field label="Base URL" required>
                <Input v-model="chBaseUrl" mono placeholder="https://upstream.example.com/v1" />
              </Field>
              <Field :label="t('batch.apiKey')" required :hint="t('batch.apiKeyHint')">
                <Input v-model="chApiKey" type="password" mono autocomplete="off" />
              </Field>
              <Field :label="t('batch.models')" required :hint="t('batch.modelsHint')">
                <Input v-model="chModels" mono placeholder="gpt-4o, claude-3-5-sonnet" />
              </Field>
            </template>

            <!-- 启停渠道 -->
            <template v-else-if="action === 'channel.toggle'">
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field :label="t('batch.channelName')" required :hint="t('batch.channelToggleHint')">
                  <Input v-model="toggleName" :placeholder="t('batch.channelNamePlaceholder')" />
                </Field>
                <Field :label="t('batch.state')" required>
                  <Select v-model="toggleEnabled" :options="toggleOptions" />
                </Field>
              </div>
            </template>
          </div>

          <div class="mt-4 flex items-center justify-between border-t border-border/60 pt-4">
            <p class="text-xs text-muted">
              {{ t('batch.willApply', { n: selected.size }) }}
            </p>
            <Button variant="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">
              {{ t('batch.apply') }}
            </Button>
          </div>
        </div>

        <!-- 结果 -->
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
              <span class="min-w-0 flex-1 truncate text-xs" :class="r.ok ? 'text-muted' : 'text-red/90'">
                {{ r.ok ? (r.detail ?? t('batch.done')) : r.error }}
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>
