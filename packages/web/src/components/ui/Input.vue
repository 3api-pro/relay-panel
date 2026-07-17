<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';

/** 文本输入：v-model；type=number 时 v-model 收 number */
const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    type?: 'text' | 'password' | 'email' | 'number' | 'url';
    placeholder?: string;
    disabled?: boolean;
    /** 等宽字体（slug/token 前缀等） */
    mono?: boolean;
    autofocus?: boolean;
    autocomplete?: string;
  }>(),
  { type: 'text', placeholder: '', disabled: false, mono: false, autofocus: false, autocomplete: 'off' },
);

const emit = defineEmits<{ 'update:modelValue': [v: string | number] }>();

const el = ref<HTMLInputElement | null>(null);

onMounted(() => {
  if (props.autofocus) el.value?.focus();
});

const cls = computed(() =>
  [
    'h-8.5 w-full rounded-lg border border-border bg-bg/60 px-3 text-[13px] text-text',
    'placeholder:text-muted/50 transition-colors',
    'hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20',
    'disabled:pointer-events-none disabled:opacity-45',
    props.mono ? 'font-mono text-xs tracking-tight' : '',
  ].join(' '),
);

function onInput(ev: Event): void {
  const raw = (ev.target as HTMLInputElement).value;
  emit('update:modelValue', props.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
}
</script>

<template>
  <input
    ref="el"
    :type="props.type"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :autocomplete="props.autocomplete"
    :class="cls"
    @input="onInput"
  />
</template>
