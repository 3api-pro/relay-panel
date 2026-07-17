<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle } from 'lucide-vue-next';

/**
 * 通用按钮。variant：
 *  primary  强调操作（accent 渐变）
 *  outline  次级操作（边框）
 *  ghost    行内弱操作（无边框）
 *  danger   破坏性操作（红）
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'outline' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    type?: 'button' | 'submit';
    disabled?: boolean;
    loading?: boolean;
    /** 占满整行（登录表单等） */
    block?: boolean;
  }>(),
  { variant: 'outline', size: 'md', type: 'button', disabled: false, loading: false, block: false },
);

const emit = defineEmits<{ click: [ev: MouseEvent] }>();

const cls = computed(() => {
  const base = [
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium select-none',
    'transition-all duration-150 active:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-45',
    props.block ? 'w-full' : '',
    props.size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8.5 px-3.5 text-[13px]',
  ];
  switch (props.variant) {
    case 'primary':
      base.push(
        'bg-gradient-to-b from-accent to-accent-dim text-white',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.4)]',
        'hover:brightness-110',
      );
      break;
    case 'danger':
      base.push('border border-red/35 bg-red/10 text-red', 'hover:border-red/60 hover:bg-red/15');
      break;
    case 'ghost':
      base.push('text-muted hover:bg-panel-2 hover:text-text');
      break;
    default:
      base.push(
        'border border-[var(--glass-border)] bg-panel-2/50 text-text',
        'shadow-[inset_0_1px_0_var(--glass-highlight)] backdrop-blur-sm',
        'hover:border-[var(--glass-border-hover)] hover:bg-panel-2/80',
      );
  }
  return base.join(' ');
});
</script>

<template>
  <button
    :type="props.type"
    :class="cls"
    :disabled="props.disabled || props.loading"
    @click="(ev) => emit('click', ev)"
  >
    <LoaderCircle v-if="props.loading" :size="14" class="animate-spin" />
    <slot />
  </button>
</template>
