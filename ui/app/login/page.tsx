'use client';
/**
 * Top-level "/login" page. Host-aware (Task #17).
 *
 *   - Root marketing host (3api.pro)   → reseller admin login.
 *                                        Submits to /api/admin/login, server
 *                                        looks up tenant by email, sets cookie
 *                                        + returns JWT. Redirects to /admin.
 *   - Tenant subdomain (acme.3api.pro) → store end-user login.
 *
 * Resellers never need to visit the subdomain to manage their tenant; the
 * admin console lives entirely on the root domain.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';
import { StoreLogin } from '@/components/store/StoreLogin';
import { useTranslations } from '@/lib/i18n';

function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const t = useTranslations('admin.login');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await auth.adminLogin(email, password);
      const paused =
        typeof window !== 'undefined' &&
        localStorage.getItem('onboarding_done') !== '1' &&
        !!localStorage.getItem('onboarding_step');
      router.push(paused ? '/admin/onboarding' : '/admin');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4" data-admin-login>
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('no_account_prefix')} <Link href="/create" className="text-teal-600 hover:text-teal-700">{t('create_link')}</Link>
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1">{t('email_label')}</div>
            <input
              type="email" required value={email} onChange={(e)=>setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              placeholder={t('email_placeholder')}
            />
          </label>
          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1">{t('password_label')}</div>
            <input
              type="password" required value={password} onChange={(e)=>setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
            />
          </label>
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          <button
            type="submit" disabled={busy}
            className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50">
            {busy ? t('submitting') : t('submit')}
          </button>
        </form>
        <div className="mt-6 pt-4 border-t border-border/50 text-xs text-muted-foreground text-center">
          {t('store_visitor_hint')} <code className="px-1 py-0.5 bg-muted rounded">your-shop.3api.pro</code>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-background" />;
  return mode === 'store' ? <StoreLogin /> : <AdminLogin />;
}
