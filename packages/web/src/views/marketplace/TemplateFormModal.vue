<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ApiError, patch, post } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import type { ChannelProtocol, MarketplaceTemplate, TemplateSource, TemplateWriteBody } from '../../api/types';

/**
 * 模板新建 / 编辑（root）。key 仅新建可填（授权记账依赖其稳定，编辑锁定）。
 * models 用换行/逗号分隔输入。重复 key(409) 落在 key 字段错误；被引用删除由父视图处理。
 */
const props = defineProps<{
  open: boolean;
  /** null = 新建 */
  template: MarketplaceTemplate | null;
}>();

const emit = defineEmits<{ 'update:open': [boolean]; saved: [] }>();

const isEdit = computed(() => props.template !== null);

const PROTOCOLS: { value: ChannelProtocol; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'gemini', label: 'Gemini' },
];
const SOURCES: { value: TemplateSource; label: string }[] = [
  { value: 'byo', label: '自带上游（byo）' },
  { value: 'managed', label: '计量托管（managed）' },
];

const key = ref('');
const title = ref('');
const description = ref('');
const protocol = ref<ChannelProtocol>('anthropic');
const source = ref<TemplateSource>('byo');
const modelsText = ref('');
const ratio = ref<number | ''>('');
const enabled = ref(true);
const submitting = ref(false);
const errors = ref<{ key?: string; title?: string; models?: string; ratio?: string }>({});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    errors.value = {};
    submitting.value = false;
    const t = props.template;
    if (t) {
      key.value = t.key;
      title.value = t.title;
      description.value = t.description ?? '';
      protocol.value = (PROTOCOLS.find((p) => p.value === t.protocol)?.value ?? 'anthropic') as ChannelProtocol;
      source.value = (t.source === 'managed' ? 'managed' : 'byo') as TemplateSource;
      modelsText.value = t.models.join('\n');
      ratio.value = t.suggestedRatio != null ? t.suggestedRatio : '';
      enabled.value = t.enabled;
    } else {
      key.value = '';
      title.value = '';
      description.value = '';
      protocol.value = 'anthropic';
      source.value = 'byo';
      modelsText.value = '';
      ratio.value = '';
      enabled.value = true;
    }
  },
);

function parseModels(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of modelsText.value.split(/[\n,]/)) {
    const m = raw.trim();
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function validate(models: string[]): boolean {
  const e: typeof errors.value = {};
  if (!isEdit.value) {
    const k = key.value.trim();
    if (!k) e.key = '请填写模板 key';
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) e.key = '仅小写字母/数字/连字符，且以字母或数字开头';
    else if (k.length > 64) e.key = 'key 最长 64 字符';
  }
  if (!title.value.trim()) e.title = '请填写展示标题';
  if (models.length === 0) e.models = '至少填写一个模型';
  if (ratio.value !== '' && !(Number(ratio.value) > 0)) e.ratio = '倍率需为正数';
  errors.value = e;
  return Object.keys(e).length === 0;
}

function close(): void {
  if (submitting.value) return;
  emit('update:open', false);
}

async function submit(): Promise<void> {
  const models = parseModels();
  if (!validate(models)) return;
  submitting.value = true;
  const base: TemplateWriteBody = {
    title: title.value.trim(),
    description: description.value.trim() ? description.value.trim() : null,
    protocol: protocol.value,
    models,
    source: source.value,
    suggestedRatio: ratio.value === '' ? null : Number(ratio.value),
  };
  try {
    if (props.template) {
      await patch(`/api/marketplace/templates/${props.template.id}`, { ...base, enabled: enabled.value }, { silent: true });
      toast.success('模板已更新');
    } else {
      await post('/api/marketplace/templates', { ...base, key: key.value.trim(), enabled: enabled.value }, { silent: true });
      toast.success('模板已创建');
    }
    emit('saved');
    emit('update:open', false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      errors.value = { ...errors.value, key: '模板 key 已存在' };
    } else {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Modal
    :open="props.open"
    :title="isEdit ? '编辑模板' : '新建模板'"
    width="560px"
    :closable="!submitting"
    @update:open="close"
  >
    <div class="space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="模板 key" required :error="errors.key" :hint="isEdit ? 'key 不可修改' : '稳定唯一，用于授权记账'">
          <Input v-model="key" mono placeholder="my-channel" :disabled="isEdit || submitting" />
        </Field>
        <Field label="展示标题" required :error="errors.title" hint="对站长可见，勿含上游真名">
          <Input v-model="title" placeholder="示例渠道" :disabled="submitting" />
        </Field>
      </div>

      <Field label="描述（可选）">
        <Input v-model="description" placeholder="一句话说明该渠道特性" :disabled="submitting" />
      </Field>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="协议" required>
          <Select
            :model-value="protocol"
            :options="PROTOCOLS"
            :disabled="submitting"
            @update:model-value="(v) => (protocol = v as ChannelProtocol)"
          />
        </Field>
        <Field label="接入来源" required hint="byo=站长自带；managed=计量网关签发">
          <Select
            :model-value="source"
            :options="SOURCES"
            :disabled="submitting"
            @update:model-value="(v) => (source = v as TemplateSource)"
          />
        </Field>
      </div>

      <Field label="支持模型" required :error="errors.models" hint="每行一个，或用逗号分隔（对外模型名）">
        <textarea
          v-model="modelsText"
          rows="4"
          :disabled="submitting"
          placeholder="claude-3-5-sonnet&#10;gpt-4o"
          class="w-full resize-y rounded-lg border border-border bg-bg/60 px-3 py-2 font-mono text-xs tracking-tight text-text placeholder:text-muted/50 transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:pointer-events-none disabled:opacity-45"
        />
      </Field>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="建议倍率（可选）" :error="errors.ratio" hint="仅提示，实际由站点分组决定">
          <Input v-model="ratio" type="number" placeholder="1.5" :disabled="submitting" />
        </Field>
        <Field v-if="isEdit" label="启用状态">
          <button
            type="button"
            class="flex h-8.5 w-full items-center justify-between rounded-lg border border-border bg-bg/60 px-3 text-[13px] transition-colors hover:border-border-2 disabled:pointer-events-none disabled:opacity-45"
            :disabled="submitting"
            @click="enabled = !enabled"
          >
            <span :class="enabled ? 'text-text' : 'text-muted'">{{ enabled ? '已启用' : '已停用' }}</span>
            <span
              class="relative h-4 w-7 rounded-full transition-colors"
              :class="enabled ? 'bg-accent' : 'bg-panel-2'"
            >
              <span
                class="absolute top-0.5 size-3 rounded-full bg-white transition-all"
                :class="enabled ? 'left-3.5' : 'left-0.5'"
              />
            </span>
          </button>
        </Field>
      </div>
    </div>

    <template #footer>
      <Button variant="ghost" :disabled="submitting" @click="close">取消</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ isEdit ? '保存修改' : '创建模板' }}
      </Button>
    </template>
  </Modal>
</template>
