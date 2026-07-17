<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, type ComputedRef } from 'vue';
import { BellRing, Check, CircleCheck, RefreshCw, ShieldCheck, TriangleAlert, Webhook } from 'lucide-vue-next';
import { get, post, put, ApiError } from '../api/client';
import { session } from '../api/session';
import type { AlertSettings, AlertsResponse, AlertResolveResponse, AlertView } from '../api/types';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  Tabs,
  toast,
  type TabItem,
} from '../components/ui';

/**
 * 告警中心（G3）：
 * - 顶部状态筛选 Tabs（未解决 / 已解决 / 全部，默认未解决）。
 * - root 额外「通知设置」→ Modal（GET/PUT /api/settings/alerts，webhookUrl）。
 * - GET /api/alerts?status= 列表；canWrite 且 open 行可「标记已解决」。
 * - 30s 自刷新；加载 / 空 / 错误态齐全。
 */

// viewer 只读：Shell 以 provide('canWrite') 注入
const canWrite = inject<ComputedRef<boolean>>(
  'canWrite',
  computed(() => false),
);

// ---- 状态筛选 ----
const statusTab = ref<string>('open');
const statusTabs: TabItem[] = [
  { key: 'open', label: '未解决' },
  { key: 'resolved', label: '已解决' },
  { key: 'all', label: '全部' },
];

// ---- 列表数据 ----
const alerts = ref<AlertView[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const loadError = ref('');
const resolvingId = ref<number | null>(null);

let timer: number | null = null;

async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true;
  else refreshing.value = true;
  try {
    const res = await get<AlertsResponse>('/api/alerts', {
      silent: true,
      query: { status: statusTab.value },
    });
    alerts.value = Array.isArray(res?.alerts) ? res.alerts : [];
    loadError.value = '';
  } catch (err) {
    // 初次加载失败展示错误态；自刷新失败静默保留旧数据
    if (initial) loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function switchTab(key: string): void {
  if (key === statusTab.value) return;
  statusTab.value = key;
  void refresh(true);
}

onMounted(() => {
  void refresh(true);
  timer = window.setInterval(() => void refresh(), 30_000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

// ---- 展示映射 ----
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

const KIND_TEXT: Record<string, string> = {
  site_down: '站点不可达',
  channel_disabled: '渠道被停用',
  low_balance: '上游余额偏低',
  job_failed: '任务失败',
};
function kindText(kind: string): string {
  return KIND_TEXT[kind] ?? kind;
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

// ---- 标记已解决 ----
async function resolveAlert(a: AlertView): Promise<void> {
  if (resolvingId.value !== null) return;
  resolvingId.value = a.id;
  try {
    await post<AlertResolveResponse>(`/api/alerts/${a.id}/resolve`);
    toast.success('告警已标记为解决');
    await refresh();
  } catch {
    // client 已自动弹出后端中文错误文案（已解决再点 400 等）
  } finally {
    resolvingId.value = null;
  }
}

// ---- 通知设置（root）----
const settingsOpen = ref(false);
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const webhookUrl = ref('');
const webhookError = ref('');

async function openSettings(): Promise<void> {
  settingsOpen.value = true;
  webhookError.value = '';
  settingsLoading.value = true;
  try {
    const res = await get<AlertSettings>('/api/settings/alerts', { silent: true });
    webhookUrl.value = res?.webhookUrl ?? '';
  } catch (err) {
    webhookUrl.value = '';
    toast.error(err instanceof ApiError ? err.message : '读取通知设置失败');
    settingsOpen.value = false;
  } finally {
    settingsLoading.value = false;
  }
}

async function saveSettings(): Promise<void> {
  const trimmed = webhookUrl.value.trim();
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    webhookError.value = '仅支持 http:// 或 https:// 开头的地址';
    return;
  }
  webhookError.value = '';
  settingsSaving.value = true;
  try {
    // 清空 = 停用推送
    await put<AlertSettings>('/api/settings/alerts', { webhookUrl: trimmed || null });
    toast.success(trimmed ? '通知 webhook 已保存' : '已停用告警推送');
    settingsOpen.value = false;
  } catch {
    // client 已弹错误
  } finally {
    settingsSaving.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <!-- 工具栏：状态筛选 + 通知设置 -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <Tabs :tabs="statusTabs" :model-value="statusTab" @update:model-value="switchTab" />
      <div class="flex items-center gap-2">
        <RefreshCw
          v-if="refreshing"
          :size="13"
          class="animate-spin text-muted/70"
          aria-label="刷新中"
        />
        <Button v-if="session.isRoot.value" size="sm" @click="openSettings">
          <BellRing :size="14" />
          通知设置
        </Button>
      </div>
    </div>

    <!-- 列表 -->
    <section class="rp-panel overflow-hidden">
      <!-- 表头 -->
      <div
        v-if="!loading && !loadError && alerts.length > 0"
        class="hidden items-center gap-3 border-b border-border px-4 py-2.5 md:flex"
      >
        <span class="rp-microlabel w-[64px] shrink-0">级别</span>
        <span class="rp-microlabel w-[96px] shrink-0">类型</span>
        <span class="rp-microlabel min-w-0 flex-1">告警</span>
        <span class="rp-microlabel w-[132px] shrink-0">站点</span>
        <span class="rp-microlabel w-[112px] shrink-0 text-right">最近</span>
        <span v-if="canWrite" class="w-[92px] shrink-0" />
      </div>

      <!-- 加载骨架 -->
      <div v-if="loading" class="divide-y divide-border/60">
        <div v-for="i in 5" :key="i" class="px-4 py-3.5">
          <Skeleton :lines="2" />
        </div>
      </div>

      <!-- 错误态 -->
      <div v-else-if="loadError" class="p-8">
        <EmptyState title="加载失败" :description="loadError" :icon="TriangleAlert">
          <Button size="sm" @click="refresh(true)">
            <RefreshCw :size="14" />
            重试
          </Button>
        </EmptyState>
      </div>

      <!-- 空态 -->
      <div v-else-if="alerts.length === 0" class="p-8">
        <EmptyState
          :icon="ShieldCheck"
          :title="statusTab === 'resolved' ? '暂无已解决告警' : '暂无告警，一切正常'"
          :description="
            statusTab === 'open'
              ? '所有站点运行正常，出现异常时会在此汇总。'
              : statusTab === 'resolved'
                ? '尚未有告警被标记为已解决。'
                : '当前没有任何告警记录。'
          "
        />
      </div>

      <!-- 告警行 -->
      <ul v-else class="divide-y divide-border/60">
        <li
          v-for="a in alerts"
          :key="a.id"
          class="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-3"
        >
          <!-- 级别 -->
          <div class="w-[64px] shrink-0">
            <Badge :tone="severityTone(a.severity)" size="sm">{{ severityText(a.severity) }}</Badge>
          </div>

          <!-- 类型 -->
          <div class="w-[96px] shrink-0">
            <span class="text-xs text-muted">{{ kindText(a.kind) }}</span>
          </div>

          <!-- 标题 + 详情 -->
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium text-text/90">{{ a.title }}</p>
            <p v-if="a.detail" class="mt-0.5 truncate text-xs text-muted">{{ a.detail }}</p>
          </div>

          <!-- 站点 slug -->
          <div class="w-[132px] shrink-0">
            <span v-if="a.siteSlug" class="truncate font-mono text-xs text-muted">{{ a.siteSlug }}</span>
            <span v-else class="text-xs text-muted/50">—</span>
          </div>

          <!-- 时间 -->
          <div class="w-[112px] shrink-0 md:text-right">
            <p class="tnum text-xs text-muted/90" :title="`首次 ${relTime(a.firstSeenAt)}`">
              {{ relTime(a.lastSeenAt) }}
            </p>
          </div>

          <!-- 操作 / 状态 -->
          <div v-if="canWrite" class="w-[92px] shrink-0 md:text-right">
            <Button
              v-if="a.status === 'open'"
              size="sm"
              :loading="resolvingId === a.id"
              :disabled="resolvingId !== null && resolvingId !== a.id"
              @click="resolveAlert(a)"
            >
              <Check :size="14" />
              解决
            </Button>
            <span v-else class="inline-flex items-center gap-1 text-xs text-green/90">
              <CircleCheck :size="13" />
              已解决
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- 通知设置弹窗（root） -->
    <Modal v-model:open="settingsOpen" title="告警通知设置" width="480px" :closable="!settingsSaving">
      <div class="space-y-4">
        <div class="flex items-start gap-3">
          <div class="mt-0.5 rounded-lg border border-accent/25 bg-accent/10 p-2 text-accent">
            <Webhook :size="16" />
          </div>
          <p class="text-[13px] leading-relaxed text-muted">
            配置后，新的严重 / 警告告警将推送到该 webhook。留空并保存即停用推送。
          </p>
        </div>

        <div v-if="settingsLoading" class="py-2">
          <Skeleton :lines="2" />
        </div>
        <Field
          v-else
          label="Webhook 地址"
          :error="webhookError"
          hint="支持 http(s):// 地址，如企业微信 / 飞书 / Slack 机器人。留空 = 停用。"
        >
          <Input
            v-model="webhookUrl"
            type="url"
            mono
            placeholder="https://example.com/webhook"
            :disabled="settingsSaving"
            autocomplete="off"
          />
        </Field>
      </div>

      <template #footer>
        <Button variant="ghost" :disabled="settingsSaving" @click="settingsOpen = false">取消</Button>
        <Button
          variant="primary"
          :loading="settingsSaving"
          :disabled="settingsLoading"
          @click="saveSettings"
        >
          保存
        </Button>
      </template>
    </Modal>
  </div>
</template>
