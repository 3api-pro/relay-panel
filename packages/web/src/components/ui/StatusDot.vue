<script setup lang="ts">
import { computed } from 'vue';

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
  text: string;
}

/** 站点 status / 任务 status / 通用词的映射表 */
function mapStatus(s: string): Mapped {
  if (s.startsWith('failed')) return { tone: 'red', pulse: false, text: '失败' };
  switch (s) {
    case 'active':
    case 'ok':
    case 'succeeded':
    case 'resolved':
      return { tone: 'green', pulse: false, text: s === 'succeeded' ? '成功' : s === 'resolved' ? '已解决' : '运行中' };
    case 'running':
      return { tone: 'accent', pulse: true, text: '执行中' };
    case 'provisioning':
    case 'pending':
    case 'queued':
      return { tone: 'amber', pulse: true, text: s === 'queued' ? '排队中' : '准备中' };
    case 'stopped':
    case 'cancelled':
      return { tone: 'muted', pulse: false, text: s === 'cancelled' ? '已取消' : '已停止' };
    case 'destroyed':
      return { tone: 'muted', pulse: false, text: '已销毁' };
    case 'down':
    case 'error':
      return { tone: 'red', pulse: false, text: '不可达' };
    case 'open':
      return { tone: 'red', pulse: true, text: '未解决' };
    default:
      return { tone: 'muted', pulse: false, text: s };
  }
}

const mapped = computed<Mapped>(() => mapStatus(props.status));
const tone = computed(() => props.tone ?? mapped.value.tone);
const pulse = computed(() => props.pulse ?? mapped.value.pulse);
const text = computed(() => props.label || (props.status ? mapped.value.text : ''));

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
