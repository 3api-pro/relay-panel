<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

/**
 * 状态点：传 status（站点/任务/告警通用词表自动映射色与呼吸动画），
 * 或直接传 tone/pulse 覆盖。label 传入时点旁显示文字（状态不允许只靠颜色表达）。
 */
const props = withDefaults(
  defineProps<{
    status?: string;
    tone?: 'green' | 'red' | 'amber' | 'accent' | 'muted';
    pulse?: boolean;
    label?: string;
  }>(),
  { status: '', tone: undefined, pulse: undefined, label: '' },
);

interface Mapped {
  tone: NonNullable<typeof props.tone>;
  pulse: boolean;
  /** common.status.<key>；空串表示回退到原始 status 文本 */
  key: string;
}

/** 站点 status / 任务 status / 通用词的映射表 */
function mapStatus(s: string): Mapped {
  if (s.startsWith('failed')) return { tone: 'red', pulse: false, key: 'failed' };
  switch (s) {
    case 'active':
    case 'ok':
      return { tone: 'green', pulse: false, key: 'active' };
    case 'succeeded':
      return { tone: 'green', pulse: false, key: 'succeeded' };
    case 'resolved':
      return { tone: 'green', pulse: false, key: 'resolved' };
    case 'running':
      return { tone: 'accent', pulse: true, key: 'running' };
    case 'provisioning':
    case 'pending':
      return { tone: 'amber', pulse: true, key: 'pending' };
    case 'queued':
      return { tone: 'amber', pulse: true, key: 'queued' };
    case 'stopped':
      return { tone: 'muted', pulse: false, key: 'stopped' };
    case 'cancelled':
      return { tone: 'muted', pulse: false, key: 'cancelled' };
    case 'destroyed':
      return { tone: 'muted', pulse: false, key: 'destroyed' };
    case 'down':
    case 'error':
      return { tone: 'red', pulse: false, key: 'unreachable' };
    case 'open':
      return { tone: 'red', pulse: true, key: 'unresolved' };
    default:
      return { tone: 'muted', pulse: false, key: '' };
  }
}

const mapped = computed<Mapped>(() => mapStatus(props.status));
const tone = computed(() => props.tone ?? mapped.value.tone);
const pulse = computed(() => props.pulse ?? mapped.value.pulse);
const text = computed(() => {
  if (props.label) return props.label;
  if (!props.status) return '';
  return mapped.value.key ? t(`common.status.${mapped.value.key}`) : props.status;
});

const dotClass = computed(() => {
  switch (tone.value) {
    case 'green':
      return 'bg-green shadow-[0_0_6px_rgb(67_209_127/0.55)]';
    case 'red':
      return 'bg-red shadow-[0_0_6px_rgb(255_92_108/0.55)]';
    case 'amber':
      return 'bg-amber shadow-[0_0_6px_rgb(240_183_74/0.5)]';
    case 'accent':
      return 'bg-accent shadow-[0_0_6px_rgb(109_139_255/0.55)]';
    default:
      return 'bg-muted/60';
  }
});
</script>

<template>
  <span class="inline-flex items-center gap-1.5">
    <span class="relative inline-flex size-2 shrink-0">
      <span v-if="pulse" class="absolute inline-flex size-full animate-ping rounded-full opacity-50" :class="dotClass" />
      <span class="relative inline-flex size-2 rounded-full" :class="dotClass" />
    </span>
    <span v-if="text" class="text-xs text-muted">{{ text }}</span>
  </span>
</template>
