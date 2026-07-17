<script setup lang="ts">
/**
 * 标签页条（只负责切换条本身，内容由父级 v-if 切换）。
 * 用法：<Tabs v-model="tab" :tabs="[{key:'overview',label:'概览'},{key:'channels',label:'渠道',count:3}]" />
 */
export interface TabItem {
  key: string;
  label: string;
  /** 右侧小计数 */
  count?: number;
}

const props = defineProps<{
  tabs: TabItem[];
  modelValue: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [key: string] }>();
</script>

<template>
  <div class="flex items-center gap-1 border-b border-border" role="tablist">
    <button
      v-for="t in props.tabs"
      :key="t.key"
      type="button"
      role="tab"
      :aria-selected="t.key === props.modelValue"
      class="relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] transition-colors"
      :class="
        t.key === props.modelValue
          ? 'border-b-2 border-accent font-medium text-text'
          : 'border-b-2 border-transparent text-muted hover:text-text'
      "
      @click="emit('update:modelValue', t.key)"
    >
      {{ t.label }}
      <span
        v-if="t.count !== undefined"
        class="tnum rounded-md bg-panel-2 px-1.5 py-px text-[10.5px]"
        :class="t.key === props.modelValue ? 'text-accent' : 'text-muted'"
      >
        {{ t.count }}
      </span>
    </button>
  </div>
</template>
