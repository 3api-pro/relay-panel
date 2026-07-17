<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Boxes, Pencil, PowerOff, Power, Trash2 } from 'lucide-vue-next';
import { Badge, Button } from '../../components/ui';
import type { MarketplaceTemplate } from '../../api/types';

const { t } = useI18n();

/**
 * 渠道模板卡：展示模板元信息 + 写操作入口（启用到站点 / root 管理）。
 * 纯展示，所有动作 emit 给父视图统一编排。停用态整卡灰显。
 */
const props = defineProps<{
  template: MarketplaceTemplate;
  canWrite: boolean;
  isRoot: boolean;
}>();

const emit = defineEmits<{
  enable: [MarketplaceTemplate];
  edit: [MarketplaceTemplate];
  toggle: [MarketplaceTemplate];
  remove: [MarketplaceTemplate];
}>();

const sourceMeta = computed<{ text: string; tone: 'accent' | 'default' }>(() =>
  props.template.source === 'managed'
    ? { text: t('marketplace.source.managed'), tone: 'accent' }
    : { text: t('marketplace.source.byo'), tone: 'default' },
);

const ratioText = computed(() =>
  props.template.suggestedRatio != null ? `×${props.template.suggestedRatio}` : '—',
);

const modelPreview = computed(() => props.template.models.slice(0, 4));
const modelRest = computed(() => Math.max(0, props.template.models.length - 4));
</script>

<template>
  <article
    class="rp-panel flex flex-col p-4 transition-opacity"
    :class="template.enabled ? '' : 'opacity-55'"
  >
    <!-- 头部：标题 + 徽标 -->
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h3 class="truncate text-[14px] font-semibold">{{ template.title }}</h3>
          <Badge v-if="!template.enabled" tone="muted" size="sm">{{ t('marketplace.card.disabled') }}</Badge>
        </div>
        <p class="mt-0.5 truncate font-mono text-xs text-muted">{{ template.key }}</p>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1">
        <Badge :tone="sourceMeta.tone" size="sm">{{ sourceMeta.text }}</Badge>
        <Badge tone="muted" size="sm" mono>{{ template.protocol }}</Badge>
      </div>
    </div>

    <!-- 描述 -->
    <p v-if="template.description" class="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
      {{ template.description }}
    </p>

    <!-- 指标行 -->
    <div class="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
      <div>
        <p class="text-[10.5px] text-muted/80">{{ t('marketplace.card.modelCount') }}</p>
        <p class="tnum flex items-center gap-1 text-[13px] font-medium">
          <Boxes :size="13" class="text-muted/70" />{{ template.models.length }}
        </p>
      </div>
      <div>
        <p class="text-[10.5px] text-muted/80">{{ t('marketplace.card.suggestedRatio') }}</p>
        <p class="tnum text-[13px] font-medium">{{ ratioText }}</p>
      </div>
    </div>

    <!-- 模型预览 -->
    <div v-if="modelPreview.length" class="mt-2.5 flex flex-wrap gap-1">
      <span
        v-for="m in modelPreview"
        :key="m"
        class="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
      >
        {{ m }}
      </span>
      <span v-if="modelRest" class="rounded-md px-1 py-0.5 text-[10.5px] text-muted/70">
        +{{ modelRest }}
      </span>
    </div>

    <!-- 操作区 -->
    <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
      <Button
        v-if="canWrite && template.enabled"
        variant="primary"
        size="sm"
        @click="emit('enable', template)"
      >
        {{ t('marketplace.card.enableToSite') }}
      </Button>
      <span v-else-if="canWrite" class="text-xs text-muted/70">{{ t('marketplace.card.disabledCannotEnable') }}</span>

      <template v-if="isRoot">
        <div class="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="emit('edit', template)">
            <Pencil :size="13" />{{ t('common.edit') }}
          </Button>
          <Button variant="ghost" size="sm" @click="emit('toggle', template)">
            <component :is="template.enabled ? PowerOff : Power" :size="13" />
            {{ template.enabled ? t('marketplace.card.disable') : t('marketplace.card.enable') }}
          </Button>
          <Button variant="ghost" size="sm" @click="emit('remove', template)">
            <Trash2 :size="13" />{{ t('common.delete') }}
          </Button>
        </div>
      </template>
    </div>
  </article>
</template>
