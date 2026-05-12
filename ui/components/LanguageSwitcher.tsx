'use client';
import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useLocale, useSetLocale, useTranslations, type Locale } from '@/lib/i18n';

const LOCALE_LABELS: Record<Locale, string> = {
  zh: '中文',
  en: 'English',
};

export function LanguageSwitcher() {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const t = useTranslations();

  function pick(next: Locale) {
    if (next === locale) return;
    setLocale(next);
    // Re-render on locale change is enough for client pages; we don't force
    // a full reload because all P0 strings live in React trees.
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('language_switcher.label')}
          className="h-9 w-9"
        >
          <Languages className="h-4 w-4" />
          <span className="sr-only">{LOCALE_LABELS[locale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuLabel>{t('language_switcher.current')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(['zh', 'en'] as Locale[]).map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => pick(l)}
            className={l === locale ? 'font-semibold text-primary' : ''}
          >
            {LOCALE_LABELS[l]}
            {l === locale && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
