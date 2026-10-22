<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { capabilityKeys, contentLabels, type KnowledgeContent } from './content';
const props = defineProps<{ content: KnowledgeContent }>();
const { locale } = useI18n();
const l = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const label = (key: string) => contentLabels[key] ? l(...contentLabels[key]) : key;
const stale = computed(() => props.content.compatibility?.testedOn && Date.now() - Date.parse(props.content.compatibility.testedOn + 'T00:00:00+08:00') > 30 * 86400000);
</script>
<template>
  <article class="min-w-0 space-y-4 break-words" data-testid="knowledge-preview">
    <p class="text-xs text-muted">{{ label(content.kind) }} · {{ content.category }}</p>
    <h2 class="text-lg font-semibold">{{ content.title }}</h2><p class="text-sm text-muted">{{ content.summary }}</p>
    <pre class="whitespace-pre-wrap rounded-lg border border-border p-4 font-sans text-sm leading-7 [overflow-wrap:anywhere]">{{ content.body }}</pre>
    <template v-if="content.compatibility">
      <h3 class="font-semibold">{{ l('模型能力记录', 'Model capability record') }}</h3>
      <p class="text-sm">{{ content.compatibility.model }} · {{ content.compatibility.protocol }}</p>
      <p class="text-xs text-muted">{{ l('引擎版本', 'Engine version') }}: {{ content.compatibility.engineVersion || '—' }} · {{ l('验证日期', 'Verification date') }}: {{ content.compatibility.testedOn || l('未验证', 'Unverified') }}</p>
      <p class="text-sm text-muted">{{ l('能力结论由站长提供；面板没有发送探测请求，也不提供兼容性认证。', 'Capability claims are provided by the site owner. The panel does not run probes or certify compatibility.') }}</p>
      <p v-if="stale" class="text-sm text-amber">{{ l('记录已超过 30 天，请确认当前兼容性。', 'This record is over 30 days old. Confirm current compatibility.') }}</p>
      <dl class="grid gap-2 sm:grid-cols-2"><div v-for="key in capabilityKeys" :key="key" class="rounded border border-border p-3"><dt class="text-xs text-muted">{{ label(key) }}</dt><dd class="mt-1 text-sm">{{ label(content.compatibility.capabilities[key]) }}</dd></div></dl>
      <h3 class="text-sm font-semibold">{{ l('验证依据与限制', 'Evidence and limitations') }}</h3><p class="whitespace-pre-wrap text-sm leading-6">{{ content.compatibility.evidence || l('未提供', 'Not provided') }}</p>
    </template>
  </article>
</template>
