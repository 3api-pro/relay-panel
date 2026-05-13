'use client';
/**
 * Top-level "/" page. Host-aware: subdomains see the brand store landing,
 * the root marketing domain sees the 3api marketing page. See HostAware.tsx
 * for the rationale (Task #17).
 */
import Link from 'next/link';
import { useHostMode } from '@/components/HostAware';
import { StoreLanding } from '@/components/store/StoreLanding';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTranslations } from '@/lib/i18n';

const GITHUB_REPO_URL = 'https://github.com/3api-pro/relay-panel';

function GithubMark({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Marketing() {
  const t = useTranslations('storefront.marketing_landing');
  return (
    <main className="min-h-screen flex flex-col bg-background" data-marketing-landing>
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="text-xl font-semibold text-brand-700">3API Panel</Link>
          <nav className="flex items-center gap-2 sm:gap-3 text-sm">
            <Link href="/pricing" className="px-2 py-1.5 text-foreground hover:text-brand-700">{t('nav_pricing')}</Link>
            <Link href="/login"   className="px-2 py-1.5 text-foreground hover:text-brand-700">{t('nav_login')}</Link>
            <Link href="/signup"  className="px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700">{t('nav_signup')}</Link>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('nav_github_label')}
              title={t('nav_github_label')}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <GithubMark />
            </a>
            <LanguageSwitcher />
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <section className="flex-1 flex items-center">
        <div className="max-w-4xl mx-auto px-6 py-20 text-center">
          <h1 className="text-5xl font-bold tracking-tight text-foreground">
            {t('hero_title')}
          </h1>
          <p className="mt-6 text-xl text-muted-foreground">
            {t('hero_subtitle')}
          </p>
          <div className="mt-10 flex justify-center gap-4 flex-wrap">
            <Link href="/signup"
              className="px-6 py-3 rounded-md bg-brand-600 text-white text-lg hover:bg-brand-700">
              {t('cta_signup')}
            </Link>
            <Link href="/pricing"
              className="px-6 py-3 rounded-md border border-input text-foreground text-lg hover:bg-accent">
              {t('cta_pricing')}
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 py-6 text-sm text-muted-foreground text-center">
          {t('footer')}
        </div>
      </footer>
    </main>
  );
}

export default function Landing() {
  const mode = useHostMode();
  if (mode === null) {
    // Pre-hydration: render a tiny neutral shell so neither variant flashes.
    return <main className="min-h-screen bg-background" />;
  }
  return mode === 'store' ? <StoreLanding /> : <Marketing />;
}
