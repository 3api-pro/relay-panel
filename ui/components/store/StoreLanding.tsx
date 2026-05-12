'use client';
/**
 * Store landing page — rendered at `/` on a tenant subdomain.
 *
 * Wraps itself in BrandProvider so the storefront chrome (Header / Footer /
 * announcement bar) shows brand colors and store_name. The CTAs route the
 * end user into the Pricing / Signup flow.
 */
import Link from 'next/link';
import { BrandProvider, useBrand } from './BrandContext';
import { Header } from './Header';
import { Footer } from './Footer';
import { AnnouncementBar } from './AnnouncementBar';
import { useTranslations } from '@/lib/i18n';

function Hero() {
  const t = useTranslations('storefront.landing');
  const brand = useBrand();
  const storeName = brand.store_name || t('default_shop_name');
  return (
    <section className="flex-1 flex items-center">
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24 text-center">
        <h1
          className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground"
          data-store-landing
        >
          {t('welcome_prefix')}{storeName}
        </h1>
        <p className="mt-5 text-lg sm:text-xl text-muted-foreground">
          {t('subtitle')}
        </p>
        <div className="mt-10 flex justify-center gap-4 flex-wrap">
          <Link
            href="/signup"
            className="px-6 py-3 rounded-md text-white text-lg hover:opacity-90"
            style={{ background: 'var(--brand-primary, #0e9486)' }}
          >
            {t('cta_signup')}
          </Link>
          <Link
            href="/pricing"
            className="px-6 py-3 rounded-md border border-input text-foreground text-lg hover:bg-background"
          >
            {t('cta_pricing')}
          </Link>
        </div>
      </div>
    </section>
  );
}

export function StoreLanding() {
  return (
    <BrandProvider>
      <div className="min-h-screen flex flex-col bg-background">
        <AnnouncementBar />
        <Header />
        <Hero />
        <Footer />
      </div>
    </BrandProvider>
  );
}
