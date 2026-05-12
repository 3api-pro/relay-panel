'use client';
/**
 * Lightweight client-side i18n for the static-export Next.js panel.
 *
 * Why custom instead of next-intl:
 *   The UI is built with `output: 'export'` (see next.config.js), which
 *   bakes HTML at build time and rules out `getRequestConfig` server
 *   helpers that next-intl relies on. Every page that uses translations
 *   is already `'use client'`, so a tiny Context-based provider + a
 *   `useTranslations` hook gives us exactly what we need (~80 lines)
 *   without dragging a server-only dep into a fully-static build.
 *
 * Locale resolution (first hit wins):
 *   1. cookie `3api_locale` (set by LanguageSwitcher)
 *   2. localStorage `3api_locale` mirror (covers cookie-blocked browsers)
 *   3. document.documentElement.lang
 *   4. navigator.language ("en"-prefix → en, otherwise zh)
 *   5. DEFAULT_LOCALE
 *
 * Persisting:
 *   setLocale(l) writes BOTH cookie (so subsequent SSR-ish reloads would
 *   see it) and localStorage, then triggers a re-render. Real "page
 *   reload" optional — useful when third-party widgets render on first
 *   paint with the wrong locale (e.g. driver.js tour copy).
 */
import { createContext, createElement, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import zh from '../messages/zh.json';
import en from '../messages/en.json';

export type Locale = 'zh' | 'en';
export const SUPPORTED_LOCALES: Locale[] = ['zh', 'en'];
export const DEFAULT_LOCALE: Locale = 'zh';
export const COOKIE_NAME = '3api_locale';

type Messages = Record<string, any>;
const MESSAGES: Record<Locale, Messages> = { zh: zh as any, en: en as any };

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.substring(name.length + 1)) : null;
}

function writeCookie(name: string, value: string, days = 365): void {
  if (typeof document === 'undefined') return;
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

export function detectLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  // 1. cookie
  const ck = readCookie(COOKIE_NAME);
  if (ck === 'zh' || ck === 'en') return ck;
  // 2. localStorage mirror
  try {
    const ls = localStorage.getItem(COOKIE_NAME);
    if (ls === 'zh' || ls === 'en') return ls;
  } catch {}
  // 3. navigator.language ("zh-CN" → zh, "en-US" → en)
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('en')) return 'en';
  if (nav.startsWith('zh')) return 'zh';
  return DEFAULT_LOCALE;
}

/* ------------------------------------------------------------------ */
/* Context + hook                                                      */
/* ------------------------------------------------------------------ */

interface I18nCtx {
  locale: Locale;
  messages: Messages;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nCtx>({
  locale: DEFAULT_LOCALE,
  messages: MESSAGES[DEFAULT_LOCALE],
  setLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  // SSR / first paint: use DEFAULT_LOCALE to avoid hydration mismatches.
  // Real detection happens in the effect below.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const detected = detectLocale();
    if (detected !== locale) setLocaleState(detected);
    // Mirror the resolved locale onto <html lang=…> so screen readers /
    // a11y tools see the correct value.
    if (typeof document !== 'undefined') {
      document.documentElement.lang = detected === 'en' ? 'en' : 'zh-CN';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setLocale(next: Locale) {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    writeCookie(COOKIE_NAME, next);
    try { localStorage.setItem(COOKIE_NAME, next); } catch {}
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
    }
    setLocaleState(next);
  }

  const value = useMemo<I18nCtx>(
    () => ({ locale, messages: MESSAGES[locale], setLocale }),
    [locale],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export function useSetLocale(): (l: Locale) => void {
  return useContext(I18nContext).setLocale;
}

/* ------------------------------------------------------------------ */
/* useTranslations(namespace) — drop-in for next-intl signature        */
/* ------------------------------------------------------------------ */

function lookup(obj: any, path: string): any {
  if (obj == null) return undefined;
  const segments = path.split('.');
  let cur: any = obj;
  for (const s of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = params[k];
    return v == null ? `{${k}}` : String(v);
  });
}

export function useTranslations(namespace?: string) {
  const { messages, locale } = useContext(I18nContext);

  return function t(key: string, params?: Record<string, string | number>): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let v = lookup(messages, fullKey);
    if (typeof v !== 'string') {
      // Fall back to zh so we never render the raw key when en is missing.
      if (locale !== 'zh') {
        v = lookup(MESSAGES.zh, fullKey);
      }
    }
    if (typeof v !== 'string') {
      // Last resort — return the key itself so a missing string is visible.
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing key: ${fullKey} (${locale})`);
      }
      return fullKey;
    }
    return interpolate(v, params);
  };
}
