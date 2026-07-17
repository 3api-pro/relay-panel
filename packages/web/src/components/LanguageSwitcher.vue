<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Check, Globe } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { LOCALE_OPTIONS, setLocale, type Locale } from '../i18n';

/**
 * 语言切换：地球玻璃 chip + 下拉（10 种语言，见 i18n LOCALE_OPTIONS）。
 * 列表静态列全 10 种；缺失 locale 文件由 vue-i18n 自动回退 en。
 * 切换调 i18n setLocale（持久化）。当前语言高亮。点击外部 / ESC 关闭。
 */
const { locale } = useI18n();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

function choose(v: Locale): void {
  setLocale(v);
  open.value = false;
}

function onDocClick(ev: MouseEvent): void {
  if (root.value && !root.value.contains(ev.target as Node)) open.value = false;
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="rp-chip-btn"
      :class="{ 'rp-chip-btn--active': open }"
      aria-label="切换语言"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Globe :size="15" />
    </button>

    <Transition name="rp-pop">
      <div
        v-if="open"
        class="rp-glass rp-glass-strong absolute right-0 top-[calc(100%+8px)] z-50 min-w-[152px] overflow-hidden p-1"
        role="menu"
      >
        <button
          v-for="opt in LOCALE_OPTIONS"
          :key="opt.value"
          type="button"
          role="menuitemradio"
          :aria-checked="locale === opt.value"
          class="flex w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-1.5 text-[13px] transition-colors"
          :class="
            locale === opt.value
              ? 'bg-accent/12 font-medium text-text'
              : 'text-muted hover:bg-panel-2/60 hover:text-text'
          "
          @click="choose(opt.value)"
        >
          {{ opt.label }}
          <Check v-if="locale === opt.value" :size="14" class="text-accent" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.rp-chip-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  color: var(--color-muted);
  background: color-mix(in oklab, var(--color-panel-2) 40%, transparent);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 0 var(--glass-highlight);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
}
.rp-chip-btn:hover,
.rp-chip-btn--active {
  color: var(--color-text);
  border-color: var(--glass-border-hover);
  background: color-mix(in oklab, var(--color-panel-2) 70%, transparent);
}
</style>
