<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { FlaskConical, Plus } from 'lucide-vue-next';
import { del, get, patch, post } from '../../api/client';
import { toast } from '../../components/ui/toast';
import {
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
} from '../../components/ui';
import type { ChannelSpec, ChannelTestResult, ChannelTestResponse, SiteChannel, SiteChannelsResponse } from './types';

/** 渠道页：列表 + 启停/测试/删除/新建（写操作 canWrite 门控，external 站仍可写）。 */
const props = defineProps<{ slug: string }>();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const channels = ref<SiteChannel[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteChannelsResponse>(`/api/sites/${props.slug}/channels`, { silent: true });
    channels.value = Array.isArray(res.channels) ? res.channels : [];
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const rows = computed(() => channels.value as unknown as Record<string, unknown>[]);
function asChannel(row: Record<string, unknown>): SiteChannel {
  return row as unknown as SiteChannel;
}

const columns: TableColumn[] = [
  { key: 'name', label: '名称' },
  { key: 'protocol', label: '协议' },
  { key: 'baseUrl', label: 'Base URL', mono: true },
  { key: 'models', label: '模型数', align: 'right' },
  { key: 'enabled', label: '状态' },
  { key: 'apiKey', label: 'API Key', mono: true },
  { key: 'actions', label: '操作', align: 'right' },
];

// ---- 启停 ----
const togglingId = ref<string | number | null>(null);
async function toggleEnabled(ch: SiteChannel): Promise<void> {
  togglingId.value = ch.id;
  try {
    await patch(`/api/sites/${props.slug}/channels/${ch.id}`, { enabled: !ch.enabled });
    toast.success(ch.enabled ? '渠道已停用' : '渠道已启用');
    await load();
  } catch {
    /* toast 已弹 */
  } finally {
    togglingId.value = null;
  }
}

// ---- 测试 ----
const testTarget = ref<SiteChannel | null>(null);
const testModel = ref<string | number | null>(null);
const testLoading = ref(false);
const testResult = ref<ChannelTestResult | null>(null);
const testModelOptions = computed<SelectOption[]>(() =>
  (testTarget.value?.models ?? []).map((m) => ({ value: m, label: m })),
);
function openTest(ch: SiteChannel): void {
  testTarget.value = ch;
  testModel.value = ch.models[0] ?? null;
  testResult.value = null;
}
async function doTest(): Promise<void> {
  if (!testTarget.value) return;
  testLoading.value = true;
  testResult.value = null;
  try {
    const res = await post<ChannelTestResponse>(
      `/api/sites/${props.slug}/channels/${testTarget.value.id}/test`,
      testModel.value ? { model: String(testModel.value) } : {},
    );
    testResult.value = res.result;
  } catch (err) {
    testResult.value = { ok: false, error: err instanceof Error ? err.message : '测试失败' };
  } finally {
    testLoading.value = false;
  }
}

// ---- 删除 ----
const deleteTarget = ref<SiteChannel | null>(null);
const deleteLoading = ref(false);
async function doDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleteLoading.value = true;
  try {
    await del(`/api/sites/${props.slug}/channels/${deleteTarget.value.id}`);
    toast.success('渠道已删除');
    deleteTarget.value = null;
    await load();
  } catch {
    /* toast 已弹 */
  } finally {
    deleteLoading.value = false;
  }
}

// ---- 新建 ----
const createOpen = ref(false);
const createLoading = ref(false);
const cName = ref('');
const cProtocol = ref<string | number | null>(null);
const cBaseUrl = ref('');
const cApiKey = ref('');
const cModels = ref('');
const cPriority = ref<string | number>('');
const protocolOptions: SelectOption[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];
function openCreate(): void {
  cName.value = '';
  cProtocol.value = null;
  cBaseUrl.value = '';
  cApiKey.value = '';
  cModels.value = '';
  cPriority.value = '';
  createOpen.value = true;
}
async function doCreate(): Promise<void> {
  if (!cName.value.trim() || cProtocol.value === null || !cBaseUrl.value.trim()) {
    toast.error('请填写名称、协议与 Base URL');
    return;
  }
  const models = cModels.value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const spec: ChannelSpec = {
    name: cName.value.trim(),
    protocol: String(cProtocol.value),
    baseUrl: cBaseUrl.value.trim(),
    apiKey: cApiKey.value.trim(),
    models,
  };
  if (cPriority.value !== '' && Number.isFinite(Number(cPriority.value))) {
    spec.priority = Number(cPriority.value);
  }
  createLoading.value = true;
  try {
    await post(`/api/sites/${props.slug}/channels`, spec);
    toast.success('渠道已创建');
    createOpen.value = false;
    await load();
  } catch {
    /* toast 已弹 */
  } finally {
    createLoading.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted">
        共 <span class="tnum text-text">{{ channels.length }}</span> 个渠道
      </p>
      <Button v-if="canWrite" variant="primary" size="sm" @click="openCreate">
        <Plus :size="14" /> 新建渠道
      </Button>
    </div>

    <div v-if="loadError" class="rp-panel p-8">
      <EmptyState title="加载失败" :description="loadError">
        <Button size="sm" @click="load">重试</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table :columns="columns" :rows="rows" row-key="id" :loading="loading" empty="暂无渠道">
        <template #cell-models="{ row }">{{ asChannel(row).models.length }}</template>
        <template #cell-enabled="{ row }">
          <StatusDot :status="asChannel(row).enabled ? 'active' : 'stopped'" :label="asChannel(row).enabled ? '启用' : '停用'" />
        </template>
        <template #cell-apiKey="{ value }">
          <span class="text-muted">{{ value }}</span>
        </template>
        <template #cell-actions="{ row }">
          <div v-if="canWrite" class="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" @click="openTest(asChannel(row))">测试</Button>
            <Button
              size="sm"
              variant="ghost"
              :loading="togglingId === asChannel(row).id"
              @click="toggleEnabled(asChannel(row))"
            >
              {{ asChannel(row).enabled ? '停用' : '启用' }}
            </Button>
            <Button size="sm" variant="ghost" @click="deleteTarget = asChannel(row)">删除</Button>
          </div>
          <span v-else class="text-xs text-muted/60">只读</span>
        </template>
      </Table>
    </div>

    <!-- 测试渠道 -->
    <Modal :open="testTarget !== null" title="测试渠道连通性" width="460px" @update:open="testTarget = null">
      <div v-if="testTarget" class="space-y-4">
        <p class="text-[13px] text-muted">
          渠道 <span class="font-mono text-text">{{ testTarget.name }}</span> · 选择一个模型发起探测请求。
        </p>
        <Field label="测试模型">
          <Select v-model="testModel" :options="testModelOptions" placeholder="使用默认模型" />
        </Field>
        <div
          v-if="testResult"
          class="rounded-lg border px-3 py-2.5 text-[13px]"
          :class="testResult.ok ? 'border-green/25 bg-green/8' : 'border-red/25 bg-red/8'"
        >
          <div class="flex items-center gap-2">
            <StatusDot :status="testResult.ok ? 'ok' : 'failed'" :label="testResult.ok ? '连通正常' : '连通失败'" />
            <span v-if="testResult.latencyMs !== undefined" class="tnum text-xs text-muted">
              {{ testResult.latencyMs }}ms
            </span>
            <span v-if="testResult.model" class="font-mono text-xs text-muted">{{ testResult.model }}</span>
          </div>
          <p v-if="testResult.error" class="mt-1.5 break-all text-xs text-red/90">{{ testResult.error }}</p>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="testTarget = null">关闭</Button>
        <Button variant="primary" :loading="testLoading" @click="doTest">
          <FlaskConical :size="14" /> 发起测试
        </Button>
      </template>
    </Modal>

    <!-- 新建渠道 -->
    <Modal v-model:open="createOpen" title="新建渠道" width="560px">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="渠道名称" required>
          <Input v-model="cName" placeholder="如 openai-main" />
        </Field>
        <Field label="协议" required>
          <Select v-model="cProtocol" :options="protocolOptions" placeholder="选择协议" />
        </Field>
        <Field label="Base URL" required class="sm:col-span-2">
          <Input v-model="cBaseUrl" mono placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="API Key" hint="仅用于下发到站点，出口不回显" class="sm:col-span-2">
          <Input v-model="cApiKey" mono type="password" placeholder="sk-..." />
        </Field>
        <Field label="模型列表" hint="逗号或换行分隔" class="sm:col-span-2">
          <Input v-model="cModels" placeholder="gpt-4o, gpt-4o-mini" />
        </Field>
        <Field label="优先级" hint="可选，数字越大越优先">
          <Input v-model="cPriority" type="number" placeholder="0" />
        </Field>
      </div>
      <template #footer>
        <Button variant="ghost" @click="createOpen = false">取消</Button>
        <Button variant="primary" :loading="createLoading" @click="doCreate">创建渠道</Button>
      </template>
    </Modal>

    <!-- 删除渠道 -->
    <ConfirmDanger
      :open="deleteTarget !== null"
      title="删除渠道"
      :confirm-text="deleteTarget?.name ?? ''"
      :message="`删除后该渠道将从站点移除，正在使用它的请求会转移到其它渠道。输入渠道名以确认。`"
      action-label="确认删除"
      :loading="deleteLoading"
      @update:open="deleteTarget = null"
      @confirm="doDelete"
    />
  </div>
</template>
