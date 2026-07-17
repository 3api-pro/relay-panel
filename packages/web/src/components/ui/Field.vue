<script setup lang="ts">
/** 表单字段包装：标签 + 控件插槽 + 提示/错误文案 */
const props = withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    error?: string;
    required?: boolean;
  }>(),
  { hint: '', error: '', required: false },
);
</script>

<template>
  <label class="block">
    <span class="mb-1.5 flex items-baseline gap-1 text-xs font-medium text-muted">
      {{ props.label }}
      <span v-if="props.required" class="text-red">*</span>
    </span>
    <slot />
    <p v-if="props.error" class="mt-1.5 text-xs text-red">{{ props.error }}</p>
    <p v-else-if="props.hint" class="mt-1.5 text-xs text-muted/80">{{ props.hint }}</p>
  </label>
</template>
