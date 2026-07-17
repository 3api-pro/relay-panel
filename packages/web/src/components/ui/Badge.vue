<script setup lang="ts">
import { computed } from 'vue';

/** 徽标：低饱和底 + 同色文字；mono 用于版本号/slug 等技术标识 */
const props = withDefaults(
  defineProps<{
    tone?: 'default' | 'accent' | 'green' | 'red' | 'amber' | 'muted';
    size?: 'sm' | 'md';
    mono?: boolean;
  }>(),
  { tone: 'default', size: 'md', mono: false },
);

const cls = computed(() => {
  const base = [
    'inline-flex items-center gap-1 rounded-md font-medium whitespace-nowrap',
    props.size === 'sm' ? 'px-1.5 py-px text-[10.5px]' : 'px-2 py-0.5 text-[11.5px]',
    props.mono ? 'font-mono tracking-tight' : '',
  ];
  switch (props.tone) {
    case 'accent':
      base.push('bg-accent/12 text-accent border border-accent/25');
      break;
    case 'green':
      base.push('bg-green/10 text-green border border-green/25');
      break;
    case 'red':
      base.push('bg-red/10 text-red border border-red/25');
      break;
    case 'amber':
      base.push('bg-amber/10 text-amber border border-amber/25');
      break;
    case 'muted':
      base.push('bg-panel-2 text-muted border border-border');
      break;
    default:
      base.push('bg-panel-2 text-text/85 border border-border-2/70');
  }
  return base.join(' ');
});
</script>

<template>
  <span :class="cls"><slot /></span>
</template>
