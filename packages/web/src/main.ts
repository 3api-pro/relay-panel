import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { i18n } from './i18n';
import { initTheme } from './composables/useTheme';
import './styles.css';

// 挂载前同步初始化主题：把 data-theme 写到 <html>，避免首帧闪白（FOUC）
initTheme();

createApp(App).use(router).use(i18n).mount('#app');
