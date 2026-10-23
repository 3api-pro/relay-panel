<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ExternalLink, RefreshCw } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import type { SystemVersionResponse, SystemUpdateResponse } from '../api/types';

const { t, locale } = useI18n();

const info = ref<SystemVersionResponse | null>(null);
const loading = ref(false);
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const update = ref<SystemUpdateResponse | null>(null);
const confirming = ref(false), submitting = ref(false), reconnecting = ref(false);
const updateError = ref('');
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false, polling = false;
const busy = computed(() => submitting.value || reconnecting.value || (!!update.value && !['idle', 'succeeded', 'failed'].includes(update.value.phase)));
const needsReload = computed(() => update.value?.phase === 'succeeded' && update.value.target !== current.value);
const canUpdate = computed(() => hasUpdate.value && update.value?.supported && !info.value?.prerelease && !busy.value);
async function loadUpdate(): Promise<void> {
  if (polling || disposed) return;
  polling = true;
  try {
    update.value = await get<SystemUpdateResponse>('/api/system/update', { silent: true, skipAuthRedirect: true });
    reconnecting.value = false;
    updateError.value = '';
  } catch {
    if (busy.value) reconnecting.value = true;
    else updateError.value = t('version.updateStatusFailed');
  } finally {
    polling = false;
    if (!disposed && (busy.value || open.value)) poll = setTimeout(() => void loadUpdate(), 3000);
  }
}
async function startUpdate(): Promise<void> {
  if (!canUpdate.value || !info.value?.latest) return;
  submitting.value = true; confirming.value = false; updateError.value = '';
  try {
    update.value = await post<SystemUpdateResponse>('/api/system/update', { target: info.value.latest, confirmed: true }, { silent: true });
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : t('version.updateStatusFailed');
    // A lost HTTP response does not prove the update was rejected. Reconcile before allowing another click.
    reconnecting.value = true;
  } finally {
    submitting.value = false;
    if (poll) clearTimeout(poll);
    void loadUpdate();
  }
}
function reload(): void { window.location.reload(); }
watch(open, value => { if (value) { if (poll) clearTimeout(poll); void loadUpdate(); } else confirming.value = false; });

const current = computed(() => info.value?.current ?? null);
const hasUpdate = computed(() => info.value?.hasUpdate === true);

async function load(force = false): Promise<void> {
  loading.value = true;
  try {
    info.value = await get<SystemVersionResponse>('/api/system/version', {
      silent: true,
      skipAuthRedirect: true,
      ...(force ? { query: { force: '1' } } : {}),
    });
  } catch {
    // 拉不到就保持上次结果/空态，不打扰用户
  } finally {
    loading.value = false;
  }
}

const publishedText = computed(() => {
  const at = info.value?.publishedAt;
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' });
});

function onDocClick(ev: MouseEvent): void {
  if (root.value && !ev.composedPath().includes(root.value)) open.value = false;
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false;
}

onMounted(() => {
  void load();
  void loadUpdate();
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  disposed = true;
  if (poll) clearTimeout(poll);
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="rp-ver-chip"
      :class="{ 'rp-ver-chip--update': hasUpdate, 'rp-ver-chip--active': open }"
      :title="hasUpdate ? t('version.updateAvailable') : t('version.upToDate')"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span v-if="current" class="font-medium tabular-nums">v{{ current }}</span>
      <span v-else class="inline-block h-3 w-12 animate-pulse rounded bg-panel-2" />
      <span v-if="hasUpdate" class="relative flex size-1.5">
        <span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span class="relative inline-flex size-1.5 rounded-full bg-amber-400" />
      </span>
    </button>

    <Transition name="rp-pop">
      <div
        v-if="open"
        class="rp-glass rp-glass-strong rp-ver-pop !absolute right-0 top-[calc(100%+8px)] z-50 w-[320px] max-w-[calc(100vw-24px)] p-3"
        role="dialog"
        :aria-label="t('version.updateAvailable')"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted">{{ t('version.currentVersion') }}</span>
          <button
            type="button"
            class="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-text"
            :disabled="loading"
            :title="t('version.refresh')"
            :aria-label="t('version.refresh')"
            @click="load(true)"
          >
            <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
          </button>
        </div>

        <p class="mt-1 text-[19px] font-semibold tracking-tight">
          <span v-if="current">v{{ current }}</span>
          <span v-else class="text-muted">—</span>
        </p>

        <!-- 状态行：有更新 / 已最新 / 查询失败（三态互斥，绝不把“查不到”说成已最新） -->
        <div class="mt-2 rounded-[10px] border border-[var(--glass-border)] bg-panel-2/40 px-2.5 py-2 text-xs">
          <template v-if="info?.error">
            <p class="text-muted">{{ t('version.checkFailed') }}</p>
            <p class="mt-0.5 text-[11px] text-muted/80">{{ info.error }}</p>
          </template>
          <template v-else-if="hasUpdate">
            <p class="font-medium text-amber-400">
              {{ t('version.updateAvailable') }} · v{{ info?.latest }}
            </p>
            <p v-if="publishedText" class="mt-0.5 text-[11px] text-muted">
              {{ t('version.published') }} {{ publishedText }}
            </p>
            <p class="mt-1 text-[11px] leading-relaxed text-muted">{{ t('version.upgradeHint') }}</p>
          </template>
          <template v-else-if="info?.latest">
            <p class="text-muted">{{ t('version.upToDate') }}</p>
          </template>
          <template v-else>
            <p class="text-muted">{{ t('version.checking') }}</p>
          </template>
        </div>

        <div v-if="hasUpdate || update?.phase === 'failed' || needsReload || busy" class="mt-3 text-xs" aria-live="polite">
          <template v-if="busy">
            <p class="flex items-center gap-2 font-medium"><RefreshCw :size="14" class="animate-spin" />{{ reconnecting ? t('version.reconnecting') : t(`version.phases.${update?.phase ?? 'downloading'}`) }}</p>
            <p class="mt-1 text-muted">{{ t('version.progressHint') }}</p>
          </template>
          <template v-else-if="needsReload">
            <p class="text-emerald-500">{{ t('version.updateSucceeded', { version: update?.target }) }}</p>
            <button type="button" class="mt-2 w-full rounded-lg bg-accent hover:bg-accent-dim px-3 py-2 text-white" @click="reload">{{ t('version.reload') }}</button>
          </template>
          <template v-else>
            <p v-if="update?.error" class="mb-2 text-red-400" role="alert">{{ update.error }}</p>
            <template v-if="confirming">
              <p class="font-medium">v{{ current }} → v{{ info?.latest }}</p>
              <p class="mt-1 leading-relaxed text-muted">{{ t('version.confirmHint') }}</p>
              <div class="mt-2 flex gap-2">
                <button type="button" class="flex-1 rounded-lg border border-[var(--glass-border)] px-3 py-2" @click="confirming = false">{{ t('version.cancel') }}</button>
                <button type="button" class="flex-1 rounded-lg bg-accent hover:bg-accent-dim px-3 py-2 text-white disabled:opacity-50" :disabled="!canUpdate" @click="startUpdate">{{ t('version.confirmUpdate') }}</button>
              </div>
            </template>
            <button v-else-if="hasUpdate" type="button" class="w-full rounded-lg bg-accent hover:bg-accent-dim px-3 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="!canUpdate" @click="confirming = true">{{ t('version.oneClickUpdate') }}</button>
            <p v-if="hasUpdate && update?.reason" class="mt-2 leading-relaxed text-muted">{{ update.reason }}</p>
            <p v-if="hasUpdate && info?.prerelease" class="mt-2 text-muted">{{ t('version.stableOnly') }}</p>
          </template>
          <p v-if="updateError" class="mt-2 text-red-400" role="alert">{{ updateError }}</p>
        </div>

        <a
          v-if="info?.url"
          :href="info.url"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-2 flex items-center justify-between gap-2 rounded-[10px] px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2/60 hover:text-text"
        >
          {{ t('version.releaseNotes') }}
          <ExternalLink :size="12" />
        </a>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 弹层内是密集小字，光靠玻璃透明度会让底层卡片文字透上来叠字；再压一层近实底保证可读 */
.rp-ver-pop {
  background:
    linear-gradient(
      color-mix(in oklab, var(--color-panel) 92%, transparent),
      color-mix(in oklab, var(--color-panel) 92%, transparent)
    ),
    var(--glass-bg-strong);
}

.rp-ver-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--color-muted);
  background: color-mix(in oklab, var(--color-panel-2) 40%, transparent);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 0 var(--glass-highlight);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
}
.rp-ver-chip:hover,
.rp-ver-chip--active {
  color: var(--color-text);
  border-color: var(--glass-border-hover);
  background: color-mix(in oklab, var(--color-panel-2) 70%, transparent);
}
/* 有可用更新：琥珀描边 + 文字，视觉上与常态明显区分但不喧宾夺主 */
.rp-ver-chip--update {
  color: rgb(251 191 36);
  border-color: color-mix(in oklab, rgb(251 191 36) 45%, transparent);
  background: color-mix(in oklab, rgb(251 191 36) 12%, transparent);
}
.rp-ver-chip--update:hover {
  color: rgb(252 211 77);
  border-color: color-mix(in oklab, rgb(251 191 36) 70%, transparent);
  background: color-mix(in oklab, rgb(251 191 36) 18%, transparent);
}
</style>
