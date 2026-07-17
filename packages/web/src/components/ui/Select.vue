<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

/** 下拉选择：v-model；options 传值/文案对 */
export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number | null;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { placeholder: '请选择', disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [v: string | number] }>();

const current = computed(() => (props.modelValue === null ? '' : String(props.modelValue)));

function onChange(ev: Event): void {
  const raw = (ev.target as HTMLSelectElement).value;
  // 尽量还原原始类型（number 选项回 number）
  const match = props.options.find((o) => String(o.value) === raw);
  emit('update:modelValue', match ? match.value : raw);
}
</script>

<template>
  <div class="relative">
    <select
      :value="current"
      :disabled="props.disabled"
      class="h-8.5 w-full appearance-none rounded-lg border border-border bg-bg/60 pl-3 pr-8 text-[13px] text-text transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:pointer-events-none disabled:opacity-45"
      @change="onChange"
    >
      <option v-if="current === ''" value="" disabled>{{ props.placeholder }}</option>
      <option v-for="o in props.options" :key="String(o.value)" :value="String(o.value)" :disabled="o.disabled === true">
        {{ o.label }}
      </option>
    </select>
    <ChevronDown :size="14" class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
  </div>
</template>
