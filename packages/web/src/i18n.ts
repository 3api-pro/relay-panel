import { createI18n } from 'vue-i18n';

/**
 * i18n 脚手架（vue-i18n@10，composition 模式，legacy:false）。
 * ------------------------------------------------------------------
 * 命名空间约定：
 *   locales/<lang>/<ns>.json → messages[lang][ns]
 *   文件名即命名空间。视图内用 t('<ns>.<key>')，如 t('nav.overview')、t('common.save')。
 *   每个 L2 视图自建自己的命名空间：locales/{en,zh,ja}/<viewName>.json。
 *
 * 语言：默认读 localStorage 'rp-locale'，否则归一 navigator.language 到 10 种支持语言；
 *   fallback 统一 'en'。setLocale() 切换并持久化 + 同步 <html lang>。
 *   locale JSON 文件由别的流程生成，缺失语言 vue-i18n 自动回退 fallbackLocale('en')。
 */

export type Locale =
  | 'en'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'pt-BR'
  | 'it'
  | 'id';

const SUPPORTED: Locale[] = ['en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR', 'it', 'id'];
const STORAGE_KEY = 'rp-locale';

// 编译期收集所有 locale JSON：{ './locales/zh/common.json': {...}, ... }
const modules = import.meta.glob<Record<string, unknown>>('./locales/*/*.json', { eager: true });

type NsMessages = Record<string, unknown>;
type LangMessages = Record<string, NsMessages>;

/** 由文件路径构建 messages = { [lang]: { [ns]: {...} } } */
function buildMessages(): Record<string, LangMessages> {
  const out: Record<string, LangMessages> = {};
  for (const [path, mod] of Object.entries(modules)) {
    const m = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!m) continue;
    const lang = m[1] as string;
    const ns = m[2] as string;
    // eager glob 下 default 即 JSON 内容
    const content = ((mod as { default?: NsMessages }).default ?? mod) as NsMessages;
    (out[lang] ??= {})[ns] = content;
  }
  return out;
}

/** navigator.language / 存储值 → 支持的 Locale */
function normalize(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // 归一到区域变体
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('es')) return 'es';
  // 其余按前缀匹配
  const PREFIX: Locale[] = ['en', 'ja', 'ko', 'fr', 'de', 'it', 'id'];
  for (const p of PREFIX) {
    if (lower.startsWith(p)) return p;
  }
  return null;
}

function initialLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return (
    normalize(stored) ??
    normalize(typeof navigator !== 'undefined' ? navigator.language : null) ??
    'en'
  );
}

const startLocale = initialLocale();

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: startLocale,
  fallbackLocale: 'en',
  messages: buildMessages(),
});

// 同步 <html lang>
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('lang', startLocale);
}

/** 切换语言 + 持久化 + 同步 <html lang> */
export function setLocale(locale: Locale): void {
  if (!SUPPORTED.includes(locale)) return;
  i18n.global.locale.value = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', locale);
}

export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}

/** 供 LanguageSwitcher 渲染的语言清单 */
export const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'it', label: 'Italiano' },
  { value: 'id', label: 'Bahasa Indonesia' },
];
