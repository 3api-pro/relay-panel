<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, patch, post } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import type { ChannelProtocol, MarketplaceTemplate, TemplateSource, TemplateWriteBody } from '../../api/types';

const { t } = useI18n();

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

const PROTOCOLS = computed<{ value: ChannelProtocol; label: string }[]>(() => [
  { value: 'anthropic', label: t('marketplace.form.protoAnthropic') },
  { value: 'openai', label: t('marketplace.form.protoOpenai') },
  { value: 'openai-responses', label: t('marketplace.form.protoOpenaiResponses') },
  { value: 'gemini', label: t('marketplace.form.protoGemini') },
]);
const SOURCES = computed<{ value: TemplateSource; label: string }[]>(() => [
  { value: 'byo', label: t('marketplace.form.sourceByo') },
  { value: 'managed', label: t('marketplace.form.sourceManaged') },
]);

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
    const tpl = props.template;
    if (tpl) {
      key.value = tpl.key;
      title.value = tpl.title;
      description.value = tpl.description ?? '';
      protocol.value = (PROTOCOLS.value.find((p) => p.value === tpl.protocol)?.value ?? 'anthropic') as ChannelProtocol;
      source.value = (tpl.source === 'managed' ? 'managed' : 'byo') as TemplateSource;
      modelsText.value = tpl.models.join('\n');
      ratio.value = tpl.suggestedRatio != null ? tpl.suggestedRatio : '';
      enabled.value = tpl.enabled;
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
    if (!k) e.key = t('marketplace.form.errKey');
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) e.key = t('marketplace.form.errKeyFormat');
    else if (k.length > 64) e.key = t('marketplace.form.errKeyLen');
  }
  if (!title.value.trim()) e.title = t('marketplace.form.errTitle');
  if (models.length === 0) e.models = t('marketplace.form.errModels');
  if (ratio.value !== '' && !(Number(ratio.value) > 0)) e.ratio = t('marketplace.form.errRatio');
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
      toast.success(t('marketplace.toast.templateUpdated'));
    } else {
      await post('/api/marketplace/templates', { ...base, key: key.value.trim(), enabled: enabled.value }, { silent: true });
      toast.success(t('marketplace.toast.templateCreated'));
    }
    emit('saved');
    emit('update:open', false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      errors.value = { ...errors.value, key: t('marketplace.form.keyExists') };
    } else {
      toast.error(err instanceof Error ? err.message : t('marketplace.toast.saveFailed'));
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Modal
    :open="props.open"
    :title="isEdit ? t('marketplace.form.titleEdit') : t('marketplace.form.titleCreate')"
    width="560px"
    :closable="!submitting"
    @update:open="close"
  >
    <div class="space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          :label="t('marketplace.form.key')"
          required
          :error="errors.key"
          :hint="isEdit ? t('marketplace.form.keyHintEdit') : t('marketplace.form.keyHintCreate')"
        >
          <Input v-model="key" mono placeholder="my-channel" :disabled="isEdit || submitting" />
        </Field>
        <Field
          :label="t('marketplace.form.titleField')"
          required
          :error="errors.title"
          :hint="t('marketplace.form.titleHint')"
        >
          <Input v-model="title" :placeholder="t('marketplace.form.titlePlaceholder')" :disabled="submitting" />
        </Field>
      </div>

      <Field :label="t('marketplace.form.description')">
        <Input v-model="description" :placeholder="t('marketplace.form.descriptionPlaceholder')" :disabled="submitting" />
      </Field>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field :label="t('marketplace.form.protocol')" required>
          <Select
            :model-value="protocol"
            :options="PROTOCOLS"
            :disabled="submitting"
            @update:model-value="(v) => (protocol = v as ChannelProtocol)"
          />
        </Field>
        <Field :label="t('marketplace.form.sourceLabel')" required :hint="t('marketplace.form.sourceHint')">
          <Select
            :model-value="source"
            :options="SOURCES"
            :disabled="submitting"
            @update:model-value="(v) => (source = v as TemplateSource)"
          />
        </Field>
      </div>

      <Field
        :label="t('marketplace.form.models')"
        required
        :error="errors.models"
        :hint="t('marketplace.form.modelsHint')"
      >
        <textarea
          v-model="modelsText"
          rows="4"
          :disabled="submitting"
          placeholder="claude-3-5-sonnet&#10;gpt-4o"
          class="w-full resize-y rounded-lg border border-border bg-bg/60 px-3 py-2 font-mono text-xs tracking-tight text-text placeholder:text-muted/50 transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:pointer-events-none disabled:opacity-45"
        />
      </Field>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field :label="t('marketplace.form.ratio')" :error="errors.ratio" :hint="t('marketplace.form.ratioHint')">
          <Input v-model="ratio" type="number" placeholder="1.5" :disabled="submitting" />
        </Field>
        <Field v-if="isEdit" :label="t('marketplace.form.enabledStatus')">
          <button
            type="button"
            class="flex h-8.5 w-full items-center justify-between rounded-lg border border-border bg-bg/60 px-3 text-[13px] transition-colors hover:border-border-2 disabled:pointer-events-none disabled:opacity-45"
            :disabled="submitting"
            @click="enabled = !enabled"
          >
            <span :class="enabled ? 'text-text' : 'text-muted'">
              {{ enabled ? t('marketplace.form.enabledOn') : t('marketplace.form.enabledOff') }}
            </span>
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
      <Button variant="ghost" :disabled="submitting" @click="close">{{ t('common.cancel') }}</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ isEdit ? t('marketplace.form.saveEdit') : t('marketplace.form.saveCreate') }}
      </Button>
    </template>
  </Modal>
</template>
