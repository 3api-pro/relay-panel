import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// dev 时 /api 代理到本机 orchestrator（默认 7100）；构建产物由 orchestrator 静态托管
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7100',
    },
  },
});
