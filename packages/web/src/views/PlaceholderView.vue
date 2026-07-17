<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Construction } from 'lucide-vue-next';

// 占位视图：H2 各 agent 用真实视图整文件替换对应路由
const route = useRoute();
const title = computed(() => (typeof route.meta.title === 'string' ? route.meta.title : '页面'));
</script>

<template>
  <div class="flex min-h-[60vh] items-center justify-center">
    <div class="rp-panel flex w-full max-w-[380px] flex-col items-center gap-3 p-10 text-center">
      <div class="rounded-xl border border-border bg-panel-2/60 p-3 text-amber">
        <Construction :size="22" />
      </div>
      <p class="text-sm font-semibold">{{ title }} · 施工中</p>
      <p class="text-xs leading-relaxed text-muted">该模块正在建设，敬请期待。</p>
    </div>
  </div>
</template>
