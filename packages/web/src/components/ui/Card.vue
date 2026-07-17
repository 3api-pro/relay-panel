<script setup lang="ts">
/**
 * 面板卡片：微渐变 + 细边框。
 * slots：title 覆盖标题区 / actions 右上角操作区 / default 内容 / footer 底部分隔区
 */
const props = withDefaults(
  defineProps<{
    title?: string;
    /** 内容区内边距（表格贴边场景传 false） */
    padded?: boolean;
    /** hover 边框提亮（可点卡片用） */
    hoverable?: boolean;
  }>(),
  { title: '', padded: true, hoverable: false },
);
</script>

<template>
  <section class="rp-panel overflow-hidden" :class="props.hoverable ? 'rp-panel-hover' : ''">
    <header
      v-if="props.title || $slots.title || $slots.actions"
      class="flex items-center justify-between gap-3 border-b border-border px-4 py-3"
    >
      <slot name="title">
        <h2 class="text-[13px] font-semibold">{{ props.title }}</h2>
      </slot>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="props.padded ? 'p-4' : ''">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="border-t border-border px-4 py-3">
      <slot name="footer" />
    </footer>
  </section>
</template>
