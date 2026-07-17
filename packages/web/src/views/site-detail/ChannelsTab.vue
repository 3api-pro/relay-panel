<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
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
const { t } = useI18n();
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
    loadError.value = err instanceof Error ? err.message : t('siteDetail.loadFailed');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const rows = computed(() => channels.value as unknown as Record<string, unknown>[]);
function asChannel(row: Record<string, unknown>): SiteChannel {
  return row as unknown as SiteChannel;
}

const columns = computed<TableColumn[]>(() => [
  { key: 'name', label: t('siteDetail.channels.colName') },
  { key: 'protocol', label: t('siteDetail.channels.colProtocol') },
  { key: 'baseUrl', label: 'Base URL', mono: true },
  { key: 'models', label: t('siteDetail.channels.colModels'), align: 'right' },
  { key: 'enabled', label: t('siteDetail.channels.colStatus') },
  { key: 'apiKey', label: 'API Key', mono: true },
  { key: 'actions', label: t('siteDetail.channels.colActions'), align: 'right' },
]);

// ---- 启停 ----
const togglingId = ref<string | number | null>(null);
async function toggleEnabled(ch: SiteChannel): Promise<void> {
  togglingId.value = ch.id;
  try {
    await patch(`/api/sites/${props.slug}/channels/${ch.id}`, { enabled: !ch.enabled });
    toast.success(ch.enabled ? t('siteDetail.channels.toastDisabled') : t('siteDetail.channels.toastEnabled'));
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
    testResult.value = { ok: false, error: err instanceof Error ? err.message : t('siteDetail.channels.testFailed') };
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
    toast.success(t('siteDetail.channels.toastDeleted'));
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
const protocolOptions = computed<SelectOption[]>(() => [
  { value: 'openai', label: t('siteDetail.channels.protoOpenai') },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
]);
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
    toast.error(t('siteDetail.channels.toastNeedFields'));
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
    toast.success(t('siteDetail.channels.toastCreated'));
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
        {{ t('siteDetail.channels.count', { n: channels.length }) }}
      </p>
      <Button v-if="canWrite" variant="primary" size="sm" @click="openCreate">
        <Plus :size="14" /> {{ t('siteDetail.channels.create') }}
      </Button>
    </div>

    <div v-if="loadError" class="rp-panel p-8">
      <EmptyState :title="t('siteDetail.loadFailed')" :description="loadError">
        <Button size="sm" @click="load">{{ t('common.retry') }}</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel overflow-hidden">
      <Table :columns="columns" :rows="rows" row-key="id" :loading="loading" :empty="t('siteDetail.channels.empty')">
        <template #cell-models="{ row }">{{ asChannel(row).models.length }}</template>
        <template #cell-enabled="{ row }">
          <StatusDot :status="asChannel(row).enabled ? 'active' : 'stopped'" :label="asChannel(row).enabled ? t('siteDetail.channels.enabled') : t('siteDetail.channels.disabled')" />
        </template>
        <template #cell-apiKey="{ value }">
          <span class="text-muted">{{ value }}</span>
        </template>
        <template #cell-actions="{ row }">
          <div v-if="canWrite" class="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" @click="openTest(asChannel(row))">{{ t('siteDetail.channels.test') }}</Button>
            <Button
              size="sm"
              variant="ghost"
              :loading="togglingId === asChannel(row).id"
              @click="toggleEnabled(asChannel(row))"
            >
              {{ asChannel(row).enabled ? t('siteDetail.channels.disabled') : t('siteDetail.channels.enabled') }}
            </Button>
            <Button size="sm" variant="ghost" @click="deleteTarget = asChannel(row)">{{ t('common.delete') }}</Button>
          </div>
          <span v-else class="text-xs text-muted/60">{{ t('siteDetail.readonly') }}</span>
        </template>
      </Table>
    </div>

    <!-- 测试渠道 -->
    <Modal :open="testTarget !== null" :title="t('siteDetail.channels.testTitle')" width="460px" @update:open="testTarget = null">
      <div v-if="testTarget" class="space-y-4">
        <p class="text-[13px] text-muted">
          {{ t('siteDetail.channels.testDescPre') }} <span class="font-mono text-text">{{ testTarget.name }}</span> {{ t('siteDetail.channels.testDescPost') }}
        </p>
        <Field :label="t('siteDetail.channels.testModelLabel')">
          <Select v-model="testModel" :options="testModelOptions" :placeholder="t('siteDetail.channels.testModelPlaceholder')" />
        </Field>
        <div
          v-if="testResult"
          class="rounded-lg border px-3 py-2.5 text-[13px]"
          :class="testResult.ok ? 'border-green/25 bg-green/8' : 'border-red/25 bg-red/8'"
        >
          <div class="flex items-center gap-2">
            <StatusDot :status="testResult.ok ? 'ok' : 'failed'" :label="testResult.ok ? t('siteDetail.channels.testOk') : t('siteDetail.channels.testFail')" />
            <span v-if="testResult.latencyMs !== undefined" class="tnum text-xs text-muted">
              {{ testResult.latencyMs }}ms
            </span>
            <span v-if="testResult.model" class="font-mono text-xs text-muted">{{ testResult.model }}</span>
          </div>
          <p v-if="testResult.error" class="mt-1.5 break-all text-xs text-red/90">{{ testResult.error }}</p>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="testTarget = null">{{ t('common.close') }}</Button>
        <Button variant="primary" :loading="testLoading" @click="doTest">
          <FlaskConical :size="14" /> {{ t('siteDetail.channels.testStart') }}
        </Button>
      </template>
    </Modal>

    <!-- 新建渠道 -->
    <Modal v-model:open="createOpen" :title="t('siteDetail.channels.createTitle')" width="560px">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field :label="t('siteDetail.channels.fName')" required>
          <Input v-model="cName" placeholder="openai-main" />
        </Field>
        <Field :label="t('siteDetail.channels.fProtocol')" required>
          <Select v-model="cProtocol" :options="protocolOptions" :placeholder="t('siteDetail.channels.fProtocolPlaceholder')" />
        </Field>
        <Field label="Base URL" required class="sm:col-span-2">
          <Input v-model="cBaseUrl" mono placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="API Key" :hint="t('siteDetail.channels.fApiKeyHint')" class="sm:col-span-2">
          <Input v-model="cApiKey" mono type="password" placeholder="sk-..." />
        </Field>
        <Field :label="t('siteDetail.channels.fModels')" :hint="t('siteDetail.channels.fModelsHint')" class="sm:col-span-2">
          <Input v-model="cModels" placeholder="gpt-4o, gpt-4o-mini" />
        </Field>
        <Field :label="t('siteDetail.channels.fPriority')" :hint="t('siteDetail.channels.fPriorityHint')">
          <Input v-model="cPriority" type="number" placeholder="0" />
        </Field>
      </div>
      <template #footer>
        <Button variant="ghost" @click="createOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="createLoading" @click="doCreate">{{ t('siteDetail.channels.createSubmit') }}</Button>
      </template>
    </Modal>

    <!-- 删除渠道 -->
    <ConfirmDanger
      :open="deleteTarget !== null"
      :title="t('siteDetail.channels.deleteTitle')"
      :confirm-text="deleteTarget?.name ?? ''"
      :message="t('siteDetail.channels.deleteMessage')"
      :action-label="t('siteDetail.channels.deleteAction')"
      :loading="deleteLoading"
      @update:open="deleteTarget = null"
      @confirm="doDelete"
    />
  </div>
</template>
