import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * Node 环境覆盖纯逻辑及 SFC 初始渲染；复用现有 Vue 插件，不加载 Tailwind。
 * 交互和布局另由管理员浏览器验收。
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
