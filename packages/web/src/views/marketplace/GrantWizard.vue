<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { KeyRound, ShieldCheck } from 'lucide-vue-next';
import { get, post } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Badge, Button, Field, Input, Modal, Select } from '../../components/ui';
import type {
  GrantCreateBody,
  MarketplaceGrant,
  MarketplaceTemplate,
  SiteGroupOption,
  SiteView,
} from '../../api/types';

/**
 * 启用向导：把某模板注入到目标站点。
 * byo 模板需填自带上游 baseUrl+apiKey（apiKey type=password，提交后不回显）；
 * managed 模板由计量网关签发接入参数，无需填凭据。
 */
const props = defineProps<{
  open: boolean;
  template: MarketplaceTemplate | null;
  sites: SiteView[];
}>();

const emit = defineEmits<{ 'update:open': [boolean]; created: [MarketplaceGrant] }>();

const siteSlug = ref('');
const channelName = ref('');
const baseUrl = ref('');
const apiKey = ref('');
const priority = ref<number | ''>('');
const selectedGroups = ref<string[]>([]);
const groups = ref<SiteGroupOption[]>([]);
const groupsLoading = ref(false);
const submitting = ref(false);
const errors = ref<{ site?: string; baseUrl?: string; apiKey?: string }>({});

const isByo = computed(() => props.template?.source === 'byo');

/** 只列可注入站点（排除已销毁） */
const siteOptions = computed(() =>
  props.sites
    .filter((s) => s.status !== 'destroyed')
    .map((s) => ({ value: s.slug, label: `${s.label} · ${s.slug}` })),
);

function reset(): void {
  siteSlug.value = '';
  channelName.value = '';
  baseUrl.value = '';
  apiKey.value = '';
  priority.value = '';
  selectedGroups.value = [];
  groups.value = [];
  errors.value = {};
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);

// 站点切换时拉取该站分组（可选特性，失败静默）
watch(siteSlug, async (slug) => {
  selectedGroups.value = [];
  groups.value = [];
  if (!slug) return;
  groupsLoading.value = true;
  try {
    const res = await get<{ groups: SiteGroupOption[] }>(`/api/sites/${slug}/groups`, { silent: true });
    groups.value = Array.isArray(res?.groups) ? res.groups : [];
  } catch {
    groups.value = [];
  } finally {
    groupsLoading.value = false;
  }
});

function toggleGroup(id: string): void {
  const i = selectedGroups.value.indexOf(id);
  if (i >= 0) selectedGroups.value.splice(i, 1);
  else selectedGroups.value.push(id);
}

function close(): void {
  if (submitting.value) return;
  emit('update:open', false);
}

function validate(): boolean {
  const e: typeof errors.value = {};
  if (!siteSlug.value) e.site = '请选择目标站点';
  if (isByo.value) {
    if (!baseUrl.value.trim()) e.baseUrl = '请填写上游 Base URL';
    else if (!/^https?:\/\//i.test(baseUrl.value.trim())) e.baseUrl = '需为 http(s) 开头的完整地址';
    if (!apiKey.value) e.apiKey = '请填写上游 API Key';
  }
  errors.value = e;
  return Object.keys(e).length === 0;
}

async function submit(): Promise<void> {
  if (!props.template) return;
  if (!validate()) return;
  submitting.value = true;
  const body: GrantCreateBody = {
    siteSlug: siteSlug.value,
    templateKey: props.template.key,
    ...(channelName.value.trim() ? { channelName: channelName.value.trim() } : {}),
    ...(isByo.value ? { byo: { baseUrl: baseUrl.value.trim(), apiKey: apiKey.value } } : {}),
    ...(selectedGroups.value.length ? { groupIds: [...selectedGroups.value] } : {}),
    ...(priority.value !== '' ? { priority: Number(priority.value) } : {}),
  };
  try {
    const grant = await post<MarketplaceGrant>('/api/marketplace/grants', body);
    toast.success(`已启用到「${grant.siteLabel}」`);
    apiKey.value = '';
    emit('created', grant);
    emit('update:open', false);
  } catch {
    // client 已弹后端中文错误 toast（模板停用 / 网关未配置 / 注入失败等）
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Modal
    :open="props.open"
    :title="template ? `启用模板 · ${template.title}` : '启用模板'"
    width="560px"
    :closable="!submitting"
    @update:open="close"
  >
    <div v-if="template" class="space-y-4">
      <!-- 模板摘要 -->
      <div class="rp-panel flex items-center gap-2 bg-panel-2/40 px-3 py-2.5">
        <Badge :tone="isByo ? 'default' : 'accent'" size="sm">{{ isByo ? '自带上游' : '计量托管' }}</Badge>
        <Badge tone="muted" size="sm" mono>{{ template.protocol }}</Badge>
        <span class="text-xs text-muted">{{ template.models.length }} 个模型</span>
        <span v-if="template.suggestedRatio != null" class="tnum text-xs text-muted">
          · 建议倍率 ×{{ template.suggestedRatio }}
        </span>
      </div>

      <Field label="目标站点" required :error="errors.site">
        <Select
          :model-value="siteSlug"
          :options="siteOptions"
          placeholder="选择要注入渠道的站点"
          :disabled="submitting"
          @update:model-value="(v) => (siteSlug = String(v))"
        />
      </Field>

      <!-- byo：自带上游凭据 -->
      <template v-if="isByo">
        <Field label="上游 Base URL" required :error="errors.baseUrl" hint="站长自带上游的 API 地址">
          <Input
            v-model="baseUrl"
            type="url"
            mono
            placeholder="https://api.example.com/v1"
            :disabled="submitting"
          />
        </Field>
        <Field label="上游 API Key" required :error="errors.apiKey" hint="仅注入目标站引擎，提交后不回显、不入库">
          <Input v-model="apiKey" type="password" mono placeholder="sk-..." :disabled="submitting" />
        </Field>
      </template>

      <!-- managed：网关签发 -->
      <div
        v-else
        class="flex items-start gap-2.5 rounded-lg border border-accent/25 bg-accent/8 px-3 py-2.5 text-[13px]"
      >
        <ShieldCheck :size="16" class="mt-0.5 shrink-0 text-accent" />
        <p class="leading-relaxed text-muted">
          该模板为托管计量渠道，将通过计量网关为本站签发专属接入凭据，无需填写上游 Key。用量由网关回传用于分账。
        </p>
      </div>

      <!-- 可选项 -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="渠道名（可选）" hint="留空使用模板标题">
          <Input v-model="channelName" :placeholder="template.title" :disabled="submitting" />
        </Field>
        <Field label="优先级（可选）" hint="数字越大越优先">
          <Input v-model="priority" type="number" placeholder="0" :disabled="submitting" />
        </Field>
      </div>

      <!-- 分组注入（可选，取决于站点分组） -->
      <Field label="注入到分组（可选）" hint="不选则按引擎默认分组生效">
        <div v-if="groupsLoading" class="text-xs text-muted/70">加载分组…</div>
        <div v-else-if="groups.length === 0" class="text-xs text-muted/70">
          {{ siteSlug ? '该站点暂无可选分组' : '选择站点后加载分组' }}
        </div>
        <div v-else class="flex flex-wrap gap-1.5">
          <button
            v-for="g in groups"
            :key="g.id"
            type="button"
            class="rounded-lg border px-2.5 py-1 text-xs transition-colors"
            :class="
              selectedGroups.includes(g.id)
                ? 'border-accent/50 bg-accent/12 text-accent'
                : 'border-border bg-panel-2/50 text-muted hover:border-border-2 hover:text-text'
            "
            :disabled="submitting"
            @click="toggleGroup(g.id)"
          >
            {{ g.name }}
            <span v-if="g.ratio != null" class="tnum opacity-70">·×{{ g.ratio }}</span>
          </button>
        </div>
      </Field>
    </div>

    <template #footer>
      <Button variant="ghost" :disabled="submitting" @click="close">取消</Button>
      <Button variant="primary" :loading="submitting" :disabled="!template" @click="submit">
        <KeyRound :size="14" />确认启用
      </Button>
    </template>
  </Modal>
</template>
