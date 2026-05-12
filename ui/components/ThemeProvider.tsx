'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

interface Ctx {
  theme: Theme;
  resolved: Resolved;
  setTheme: (t: Theme) => void;
}
const ThemeCtx = createContext<Ctx | null>(null);

function resolveTheme(t: Theme): Resolved {
  if (t === 'system') {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t;
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'theme',
}: { children: ReactNode; defaultTheme?: Theme; storageKey?: string }) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [resolved, setResolved] = useState<Resolved>('light');

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey) as Theme | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        setThemeState(stored);
      }
    } catch {}
  }, [storageKey]);

  // Apply theme to <html> + persist + watch system pref
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const apply = () => {
      const r = resolveTheme(theme);
      setResolved(r);
      root.classList.remove('light', 'dark');
      root.classList.add(r);
    };
    apply();
    try { localStorage.setItem(storageKey, theme); } catch {}

    if (theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => apply();
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [theme, storageKey]);

  const setTheme = (t: Theme) => setThemeState(t);

  return <ThemeCtx.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeCtx);
  if (!ctx) {
    // Safe fallback so importers outside the provider tree don't crash
    return {
      theme: 'system',
      resolved: 'light',
      setTheme: () => {},
    };
  }
  return ctx;
}
