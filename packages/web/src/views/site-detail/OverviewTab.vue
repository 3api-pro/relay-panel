<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Activity, Boxes, CircleDollarSign, Users } from 'lucide-vue-next';
import { get } from '../../api/client';
import type { SiteView } from '../../api/types';
import type { SiteUsageResponse } from './types';
import { AreaChart, Button, EmptyState, StatCard, type AreaPoint } from '../../components/ui';
import { fmtCost, fmtInt } from './format';

/** 概览页：14 天用量趋势（成本/请求可切换）+ 站点实时统计卡。 */
const props = defineProps<{ slug: string; site: SiteView | null }>();
const { t } = useI18n();

const buckets = ref<SiteUsageResponse['buckets']>([]);
const costUnit = ref('');
const loading = ref(true);
const loadError = ref('');
const metric = ref<'cost' | 'requests'>('cost');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteUsageResponse>(`/api/sites/${props.slug}/usage`, {
      silent: true,
      query: { days: 14 },
    });
    buckets.value = Array.isArray(res.buckets) ? res.buckets : [];
    costUnit.value = res.costUnit ?? '';
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('siteDetail.loadFailed');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function dayLabel(date: string): string {
  return date.length > 5 ? date.slice(5) : date;
}

const points = computed<AreaPoint[]>(() =>
  buckets.value.map((b) => ({
    label: dayLabel(b.date),
    value: metric.value === 'cost' ? b.cost : b.requests,
  })),
);
const chartColor = computed(() => (metric.value === 'cost' ? '#43d17f' : '#6d8bff'));
const formatValue = computed<(v: number) => string>(() =>
  metric.value === 'cost' ? (v: number) => fmtCost(v, costUnit.value) : (v: number) => fmtInt(v),
);

// ---- 实时统计卡（读站点探测字段）----
const groupsVal = computed(() => props.site?.groups);
const accountsTotal = computed(() => props.site?.accounts?.total);
const accountsActive = computed(() => props.site?.accounts?.active);
const req24h = computed(() => props.site?.usage24h?.requests);
const cost24h = computed(() => props.site?.usage24h?.cost);
const cost24hUnit = computed(() => props.site?.usage24h?.costUnit ?? costUnit.value);
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="t('siteDetail.overview.groups')" :value="groupsVal ?? '—'" :icon="Boxes" :hint="t('siteDetail.overview.groupsHint')" />
      <StatCard
        :label="t('siteDetail.overview.accounts')"
        :value="accountsTotal ?? '—'"
        :icon="Users"
        :hint="accountsActive !== undefined ? t('siteDetail.overview.accountsActive', { n: accountsActive }) : t('siteDetail.overview.accountsHint')"
      />
      <StatCard
        :label="t('siteDetail.overview.req24h')"
        :value="req24h !== undefined ? fmtInt(req24h) : '—'"
        :icon="Activity"
        :hint="t('siteDetail.overview.last24h')"
      />
      <StatCard
        :label="t('siteDetail.overview.cost24h')"
        :value="cost24h !== undefined ? fmtCost(cost24h, cost24hUnit) : '—'"
        :icon="CircleDollarSign"
        :hint="t('siteDetail.overview.last24h')"
      />
    </div>

    <section class="rp-panel overflow-hidden">
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p class="rp-microlabel">{{ t('siteDetail.overview.trendTitle') }}</p>
        <div class="flex items-center gap-1 rounded-lg border border-border bg-bg/40 p-0.5">
          <Button :variant="metric === 'cost' ? 'primary' : 'ghost'" size="sm" @click="metric = 'cost'">{{ t('siteDetail.overview.metricCost') }}</Button>
          <Button :variant="metric === 'requests' ? 'primary' : 'ghost'" size="sm" @click="metric = 'requests'">
            {{ t('siteDetail.overview.metricRequests') }}
          </Button>
        </div>
      </header>
      <div class="px-4 py-4">
        <div v-if="loading" class="rp-shimmer h-[200px] w-full rounded-lg" />
        <div v-else-if="loadError" class="py-10">
          <EmptyState :title="t('siteDetail.overview.loadFailedTitle')" :description="loadError">
            <Button size="sm" @click="load">{{ t('common.retry') }}</Button>
          </EmptyState>
        </div>
        <div v-else-if="points.length === 0" class="py-10">
          <EmptyState :title="t('siteDetail.overview.emptyTitle')" :description="t('siteDetail.overview.emptyDesc')" />
        </div>
        <AreaChart v-else :points="points" :height="220" :color="chartColor" :format-value="formatValue" />
      </div>
    </section>
  </div>
</template>
