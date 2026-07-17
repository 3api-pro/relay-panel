import { ref, readonly, computed } from 'vue';

/**
 * 主题管理（液态玻璃明暗双主题）。
 * ------------------------------------------------------------------
 * - 偏好三态：'dark' | 'light' | 'system'，持久化到 localStorage 'rp-theme'。
 * - system → 读 prefers-color-scheme，并随系统切换实时跟随。
 * - 最终解析出的具体主题（dark|light）写到 <html data-theme>，
 *   CSS 只需 :root[data-theme="dark"] / [data-theme="light"] 两套。
 * - initTheme() 需在挂载前（main.ts 顶部）同步调用，避免首帧闪白。
 *
 * 模块级单例：任意组件 useTheme() 拿到同一份 ref。
 */

export type ThemePref = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'rp-theme';

const pref = ref<ThemePref>('system');
const resolved = ref<ResolvedTheme>('dark');

let mql: MediaQueryList | null = null;

/** 读系统偏好 */
function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/** 把 pref 解析为具体主题并落到 <html data-theme> + <meta theme-color> */
function apply(): void {
  const next: ResolvedTheme = pref.value === 'system' ? systemTheme() : pref.value;
  resolved.value = next;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#e9edf4' : '#06070a');
  }
}

/** 读 localStorage 里的偏好（非法值回落 system） */
function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* 隐私模式 localStorage 不可用时忽略 */
  }
  return 'system';
}

/**
 * 初始化：main.ts 挂载前同步调用一次。
 * 幂等——重复调用只重新解析，不重复绑定监听。
 */
export function initTheme(): void {
  pref.value = readPref();
  apply();
  if (typeof window !== 'undefined' && !mql) {
    mql = window.matchMedia('(prefers-color-scheme: light)');
    mql.addEventListener('change', () => {
      if (pref.value === 'system') apply();
    });
  }
}

/** 设置偏好并持久化 */
export function setTheme(value: ThemePref): void {
  pref.value = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  apply();
}

/** 在 亮/暗 之间切换（当前 system 时以解析结果为基准取反，并落为具体值） */
export function toggleTheme(): void {
  setTheme(resolved.value === 'dark' ? 'light' : 'dark');
}

export function useTheme() {
  return {
    /** 用户偏好（dark|light|system） */
    theme: readonly(pref),
    /** 实际生效主题（dark|light） */
    resolvedTheme: readonly(resolved),
    isDark: computed(() => resolved.value === 'dark'),
    setTheme,
    toggleTheme,
  };
}
