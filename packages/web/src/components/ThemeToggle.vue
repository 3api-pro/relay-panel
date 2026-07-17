<script setup lang="ts">
import { Moon, Sun } from 'lucide-vue-next';
import { useTheme } from '../composables/useTheme';

/**
 * 主题切换：太阳/月亮玻璃 chip。点一下在 亮/暗 之间切换。
 * 图标随当前解析主题呈现（暗=月亮，亮=太阳）。
 */
const { isDark, toggleTheme } = useTheme();
</script>

<template>
  <button
    type="button"
    class="rp-chip-btn"
    :aria-label="isDark ? '切换到浅色主题' : '切换到深色主题'"
    :title="isDark ? '浅色主题' : '深色主题'"
    @click="toggleTheme"
  >
    <Transition name="rp-icon-swap" mode="out-in">
      <Moon v-if="isDark" :key="'moon'" :size="15" />
      <Sun v-else :key="'sun'" :size="15" />
    </Transition>
  </button>
</template>

<style scoped>
/* 玻璃 chip 按钮（与 LanguageSwitcher 触发器同款视觉） */
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
.rp-chip-btn:hover {
  color: var(--color-text);
  border-color: var(--glass-border-hover);
  background: color-mix(in oklab, var(--color-panel-2) 70%, transparent);
}

.rp-icon-swap-enter-active,
.rp-icon-swap-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.rp-icon-swap-enter-from {
  opacity: 0;
  transform: rotate(-45deg) scale(0.7);
}
.rp-icon-swap-leave-to {
  opacity: 0;
  transform: rotate(45deg) scale(0.7);
}
</style>
