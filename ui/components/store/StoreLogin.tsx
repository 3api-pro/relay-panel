'use client';
/**
 * Store-mode login — talks to /api/storefront/auth/login. Wrapped in
 * BrandProvider so subdomain users see store branding instead of 3api's.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { store } from '@/lib/store-api';
import { BrandProvider, useBrand } from './BrandContext';
import { Header } from './Header';
import { Footer } from './Footer';
import { useTranslations } from '@/lib/i18n';

function Form() {
  const t = useTranslations('storefront.store_login');
  const router = useRouter();
  const brand = useBrand();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await store.login(email, password);
      router.push('/dashboard/keys');
    } catch (e: any) {
      setErr(e?.message || t('fail'));
    } finally {
      setBusy(false);
    }
  }

  const primary = brand.primary_color || '#0e9486';
  return (
    <main className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1" data-store-login>{t('title_prefix')}{brand.store_name || ''}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('no_account_prefix')}<Link href="/signup" className="hover:underline" style={{ color: primary }}>{t('signup_link')}</Link>
          <span className="mx-2 text-muted-foreground">|</span>
          <Link href="/forgot-password" className="hover:underline" style={{ color: primary }}>{t('forgot_link')}</Link>
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1">{t('email_label')}</div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input focus:outline-none focus:ring-1"
            />
          </label>
          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1">{t('password_label')}</div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input focus:outline-none focus:ring-1"
            />
          </label>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-md text-white disabled:opacity-50 hover:opacity-90"
            style={{ background: primary }}
          >
            {busy ? t('submit_busy') : t('submit')}
          </button>
        </form>
      </div>
    </main>
  );
}

export function StoreLogin() {
  return (
    <BrandProvider>
      <div className="min-h-screen flex flex-col bg-background">
        <Header />
        <Form />
        <Footer />
      </div>
    </BrandProvider>
  );
}
