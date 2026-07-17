<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Activity, ArrowRight, CircleDollarSign, HeartPulse, Server } from 'lucide-vue-next';
import { get } from '../api/client';
import type { AlertsResponse, AlertView, SitesResponse, SiteView } from '../api/types';
import Badge from '../components/ui/Badge.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import Skeleton from '../components/ui/Skeleton.vue';
import StatCard from '../components/ui/StatCard.vue';
import StatusDot from '../components/ui/StatusDot.vue';

/**
 * 总览：4 统计卡 + open 告警条 + 站点卡网格。
 * 数据源 GET /api/sites 与 GET /api/alerts?status=open；
 * 告警接口未就绪（501）时静默隐藏该区块。30s 轻量自刷新。
 */
const router = useRouter();

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
    if (initial) loadError.value = err instanceof Error ? err.message : '加载失败';
  }
  try {
    const res = await get<AlertsResponse>('/api/alerts', { silent: true, query: { status: 'open' } });
    alerts.value = Array.isArray(res?.alerts) ? res.alerts : [];
  } catch {
    alerts.value = []; // 告警模块未就绪时隐藏区块
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
  if (probed.length === 0) return { value: '—', hint: '暂无探测数据', tone: 'default' as const };
  const up = probed.filter((s) => s.ok === true).length;
  return {
    value: `${up}/${probed.length}`,
    hint: up === probed.length ? '全部在线' : `${probed.length - up} 个站点异常`,
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
  if (sev === 'critical') return '严重';
  if (sev === 'warning') return '警告';
  return '提示';
}
function relTime(iso: string): string {
  const t = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
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
  const map: Record<string, string> = {
    provision: '开站',
    upgrade: '升级',
    start: '启动',
    stop: '停止',
    destroy: '销毁',
  };
  return map[kind] ?? kind;
}
</script>

<template>
  <div class="space-y-5">
    <!-- 统计卡 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="站点总数" :value="loading ? '' : visibleSites.length" :loading="loading" :icon="Server" hint="不含已销毁" />
      <StatCard
        label="健康站点"
        :value="loading ? '' : healthStat.value"
        :loading="loading"
        :tone="healthStat.tone"
        :icon="HeartPulse"
        :hint="healthStat.hint"
      />
      <StatCard
        label="24h 请求"
        :value="loading ? '' : usageStat.has ? fmtInt(usageStat.requests) : '—'"
        :loading="loading"
        :icon="Activity"
        hint="全部站点合计"
      />
      <StatCard
        label="24h 成本"
        :value="loading ? '' : usageStat.has ? fmtCost(usageStat.cost, usageStat.unit) : '—'"
        :loading="loading"
        :icon="CircleDollarSign"
        hint="全部站点合计"
      />
    </div>

    <!-- open 告警条 -->
    <section v-if="alerts.length > 0" class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p class="rp-microlabel">未解决告警 · {{ alerts.length }}</p>
        <RouterLink to="/alerts" class="flex items-center gap-1 text-xs text-accent transition-opacity hover:opacity-80">
          全部告警 <ArrowRight :size="12" />
        </RouterLink>
      </header>
      <ul>
        <li
          v-for="a in alerts.slice(0, 5)"
          :key="a.id"
          class="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0"
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
        <p class="rp-microlabel">站点</p>
        <RouterLink to="/sites" class="flex items-center gap-1 text-xs text-accent transition-opacity hover:opacity-80">
          站点管理 <ArrowRight :size="12" />
        </RouterLink>
      </div>

      <div v-if="loading" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="i in 3" :key="i" class="rp-panel p-4">
          <Skeleton :lines="3" />
        </div>
      </div>

      <div v-else-if="loadError" class="rp-panel p-8">
        <EmptyState title="加载失败" :description="loadError" />
      </div>

      <div v-else-if="visibleSites.length === 0" class="rp-panel p-8">
        <EmptyState title="还没有站点" description="到「站点」页新建第一个站点，或用 CLI 接管存量站。" />
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
              <Badge v-if="s.managed === 'external'" tone="amber" size="sm">外部接管</Badge>
            </div>
          </div>

          <div class="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
            <div>
              <p class="text-[10.5px] text-muted/80">延迟</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.latencyMs !== undefined ? `${s.latencyMs}ms` : '—' }}
              </p>
            </div>
            <div>
              <p class="text-[10.5px] text-muted/80">24h 请求</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.usage24h?.requests !== undefined ? fmtInt(s.usage24h.requests) : '—' }}
              </p>
            </div>
            <div>
              <p class="text-[10.5px] text-muted/80">24h 成本</p>
              <p class="tnum text-[13px] font-medium">
                {{ s.usage24h?.cost !== undefined ? fmtCost(s.usage24h.cost, s.usage24h.costUnit ?? '') : '—' }}
              </p>
            </div>
          </div>

          <div
            v-if="s.activeJob || s.error"
            class="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5"
          >
            <Badge v-if="s.activeJob" tone="accent" size="sm">
              {{ jobKindText(s.activeJob.kind) }}任务 · {{ s.activeJob.status === 'running' ? '执行中' : '排队中' }}
            </Badge>
            <p v-if="s.error" class="min-w-0 flex-1 truncate text-xs text-red/90">{{ s.error }}</p>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
