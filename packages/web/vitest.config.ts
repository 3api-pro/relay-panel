import { defineConfig } from 'vitest/config';

/**
 * web 纯逻辑单测配置（不加载 vue/tailwind 插件，node 环境）：
 * 只覆盖从 SFC 抽出的纯函数（如 billing-renew），不做组件挂载，零新依赖。
 * 组件渲染仍由 vue-tsc 类型检查 + vite build 保证。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
