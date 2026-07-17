<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Activity, ArrowRight, CircleDollarSign, HeartPulse, Server } from 'lucide-vue-next';
import { get } from '../api/client';
import type { AlertsResponse, AlertView, SitesResponse, SiteView } from '../api/types';
import Badge from '../components/ui/Badge.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import Skeleton from '../components/ui/Skeleton.vue';
import StatCard from '../components/ui/StatCard.vue';
import StatusDot from '../components/ui/StatusDot.vue';

/**
 * 总览：4 统计卡 + open 告警条 + 站点卡网格。玻璃化 + i18n 样板视图。
 * 数据源 GET /api/sites 与 GET /api/alerts?status=open；告警 501 时静默隐藏。
 */
const router = useRouter();
const { t } = useI18n();

const sites = ref<SiteView[]>([]);
const alerts = ref<AlertView[]>([]);
const loading = ref(true);
const loadError = ref('');

let timer: number | null = null;

async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true;
  try {
    const res = await get<SitesResponse>('/api/sites', { silent: true });
    sites.value = res.sites;
    loadError.value = '';
  } catch (err) {
    if (initial) loadError.value = err instanceof Error ? err.message : t('overview.loadFailed');
  }
  try {
    const res = await get<AlertsResponse>('/api/alerts', { silent: true, query: { status: 'open' } });
    alerts.value = Array.isArray(res?.alerts) ? res.alerts : [];
  } catch {
    alerts.value = [];
  }
  loading.value = false;
}

onMounted(() => {
  void refresh(true);
  timer = window.setInterval(() => void refresh(), 30_000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

// ---- 统计聚合 ----
const visibleSites = computed(() => sites.value.filter((s) => s.status !== 'destroyed'));

const healthStat = computed(() => {
  const probed = visibleSites.value.filter((s) => s.ok !== undefined);
  if (probed.length === 0) return { value: '—', hint: t('overview.healthyNoData'), tone: 'default' as const };
  const up = probed.filter((s) => s.ok === true).length;
  return {
    value: `${up}/${probed.length}`,
    hint: up === probed.length ? t('overview.healthyAll') : t('overview.healthyDown', { n: probed.length - up }),
    tone: up === probed.length ? ('green' as const) : ('red' as const),
  };
});

const usageStat = computed(() => {
  let requests = 0;
  let cost = 0;
  let unit = '';
  let has = false;
  for (const s of visibleSites.value) {
    if (s.usage24h) {
      has = true;
      requests += s.usage24h.requests ?? 0;
      cost += s.usage24h.cost ?? 0;
      if (!unit && s.usage24h.costUnit) unit = s.usage24h.costUnit;
    }
  }
  return { has, requests, cost, unit };
});

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}
function fmtCost(n: number, unit: string): string {
  const v = n >= 100 ? n.toFixed(0) : n.toFixed(2);
  return unit ? `${v} ${unit}` : v;
}

// ---- 告警展示 ----
function severityTone(sev: string): 'red' | 'amber' | 'accent' {
  if (sev === 'critical') return 'red';
  if (sev === 'warning') return 'amber';
  return 'accent';
}
function severityText(sev: string): string {
  if (sev === 'critical') return t('overview.severity.critical');
  if (sev === 'warning') return t('overview.severity.warning');
  return t('overview.severity.info');
}
function relTime(iso: string): string {
  const time = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('overview.relTime.justNow');
  if (min < 60) return t('overview.relTime.minAgo', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('overview.relTime.hourAgo', { n: h });
  return t('overview.relTime.dayAgo', { n: Math.floor(h / 24) });
}

// ---- 站点卡 ----
function siteStatus(s: SiteView): string {
  if (s.status === 'active' && s.ok === false) return 'down';
  return s.status;
}
function openSite(s: SiteView): void {
  void router.push(`/sites/${s.slug}`);
}
function jobKindText(kind: string): string {
  const known = ['provision', 'upgrade', 'start', 'stop', 'destroy'];
  return known.includes(kind) ? t(`overview.jobKind.${kind}`) : kind;
}
</script>

<template>
  <div class="space-y-5">
    <!-- 统计卡 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        :label="t('overview.statSites')"
        :value="loading ? '' : visibleSites.length"
        :loading="loading"
        :icon="Server"
        :hint="t('overview.statSitesHint')"
      />
      <StatCard
        :label="t('overview.statHealthy')"
        :value="loading ? '' : healthStat.value"
        :loading="loading"
        :tone="healthStat.tone"
        :icon="HeartPulse"
        :hint="healthStat.hint"
      />
      <StatCard
        :label="t('overview.stat24hReq')"
        :value="loading ? '' : usageStat.has ? fmtInt(usageStat.requests) : '—'"
        :loading="loading"
        :icon="Activity"
        :hint="t('overview.statAllSites')"
      />
      <StatCard
        :label="t('overview.stat24hCost')"
        :value="loading ? '' : usageStat.has ? fmtCost(usageStat.cost, usageStat.unit) : '—'"
        :loading="loading"
        :icon="CircleDollarSign"
        :hint="t('overview.statAllSites')"
      />
    </div>

    <!-- open 告警条 -->
    <section v-if="alerts.length > 0" class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between border-b border-[var(--glass-border)] px-4 py-2.5">
        <p class="rp-microlabel">{{ t('overview.openAlerts', { n: alerts.length }) }}</p>
        <RouterLink to="/alerts" class="flex items-center gap-1 text-xs text-accent transition-opacity hover:opacity-80">
          {{ t('overview.allAlerts') }} <ArrowRight :size="12" />
        </RouterLink>
      </header>
      <ul>
        <li
          v-for="a in alerts.slice(0, 5)"
          :key="a.id"
          class="flex items-center gap-3 border-b border-[var(--glass-border)]/60 px-4 py-2.5 last:border-0"
        >
          <Badge :tone="severityTone(a.severity)" size="sm">{{ severityText(a.severity) }}</Badge>
          <p class="min-w-0 flex-1 truncate text-[13px]">
            {{ a.title }}
            <span v-if="a.detail" class="text-muted"> · {{ a.detail }}</span>
          </p>
          <span v-if="a.siteSlug" class="shrink-0 font-mono text-xs text-muted">{{ a.siteSlug }}</span>
          <span class="tnum shrink-0 text-xs text-muted/70">{{ relTime(a.lastSeenAt) }}</span>
        </li>
      </ul>
    </section>

    <!-- 站点卡网格 -->
    <section>
      <div class="mb-3 flex items-center justify-between">
        <p class="rp-microlabel">{{ t('overview.sitesSection') }}</p>
        <RouterLink to="/sites" class="flex items-center gap-1 text-xs text-accent transition-opacity hover:opacity-80">
          {{ t('overview.siteManage') }} <ArrowRight :size="12" />
        </RouterLink>
      </div>

      <div v-if="loading" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="i in 3" :key="i" class="rp-panel p-4">
          <Skeleton :lines="3" />
        </div>
      </div>

      <div v-else-if="loadError" class="rp-panel p-8">
        <EmptyState :title="t('overview.loadFailed')" :description="loadError" />
      </div>

      <div v-else-if="visibleSites.length === 0" class="rp-panel p-8">
        <EmptyState :title="t('overview.noSites')" :description="t('overview.noSitesDesc')" />
      </div>

      <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="s in visibleSites"
          :key="s.slug"
          class="rp-panel rp-panel-hover cursor-pointer p-4"
          @click="openSite(s)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <StatusDot :status="siteStatus(s)" />
                <h3 class="truncate text-[14px] font-semibold">{{ s.label }}</h3>
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-muted">{{ s.slug }}</p>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1">
              <Badge tone="muted" size="sm" mono>{{ s.engine }} · {{ s.version }}</Badge>
              <Badge v-if="s.managed === 'external'" tone="amber" size="sm">{{ t('overview.externalManaged') }}</Badge>
            </div>
          </div>

          <div class="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--glass-border)]/70 pt-3">
            <div>
              <p class="text-[10.5px] text-muted/80">{{ t('overview.latency') }}</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.latencyMs !== undefined ? `${s.latencyMs}ms` : '—' }}
              </p>
            </div>
            <div>
              <p class="text-[10.5px] text-muted/80">{{ t('overview.req24h') }}</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.usage24h?.requests !== undefined ? fmtInt(s.usage24h.requests) : '—' }}
              </p>
            </div>
            <div>
              <p class="text-[10.5px] text-muted/80">{{ t('overview.cost24h') }}</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.usage24h?.cost !== undefined ? fmtCost(s.usage24h.cost, s.usage24h.costUnit ?? '') : '—' }}
              </p>
            </div>
          </div>

          <div
            v-if="s.activeJob || s.error"
            class="mt-2.5 flex items-center gap-2 border-t border-[var(--glass-border)]/70 pt-2.5"
          >
            <Badge v-if="s.activeJob" tone="accent" size="sm">
              {{
                s.activeJob.status === 'running'
                  ? t('overview.jobRunning', { kind: jobKindText(s.activeJob.kind) })
                  : t('overview.jobQueued', { kind: jobKindText(s.activeJob.kind) })
              }}
            </Badge>
            <p v-if="s.error" class="min-w-0 flex-1 truncate text-xs text-red/90">{{ s.error }}</p>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
