'use client';
/**
 * /admin/login — host-aware:
 *
 *   - Root domain (3api.pro)              → admin login form.
 *   - Tenant subdomain (acme.3api.pro)    → notice "管理后台在 3api.pro/admin"
 *                                           with a button to the root login.
 *
 * Resellers always log in on the root domain. Subdomains are storefronts for
 * end users; we never want a reseller to authenticate via a subdomain because
 * the subdomain is branded as the customer's shop.
 *
 * v0.4 — adds a "Forgot my shop address?" lookup modal that calls
 * /api/admin/login-lookup and tells the user which subdomain owns the
 * given email (helps resellers who forgot whether their store is
 * `acme.3api.pro` or `lucky-eagle-…3api.pro`).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';
import { useTranslations } from '@/lib/i18n';

function RootAdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showLookup, setShowLookup] = useState(false);
  const t = useTranslations('admin.login');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await auth.adminLogin(email, password);
      const paused =
        typeof window !== 'undefined' &&
        localStorage.getItem('onboarding_done') !== '1' &&
        !!localStorage.getItem('onboarding_step');
      router.push(paused ? '/admin/onboarding' : '/admin');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('no_account_prefix')} <Link href="/create" className="text-teal-600 hover:text-teal-700">{t('create_link')}</Link>
        </p>
        <form onSubmit={submit} className="space-y-4">
          <input type="email" required placeholder={t('email_placeholder')} value={email} onChange={(e)=>setEmail(e.target.value)}
            autoComplete="email"
            className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
          <input type="password" required placeholder={t('password_label').toLowerCase()} value={password} onChange={(e)=>setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          <button disabled={busy} className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50">
            {busy ? t('submitting') : t('submit')}
          </button>
        </form>
        <div className="my-4 flex items-center gap-3">
          <div className="flex-1 h-px bg-border"></div>
          <span className="text-xs text-muted-foreground">或</span>
          <div className="flex-1 h-px bg-border"></div>
        </div>
        <a
          href="/admin/auth/google"
          className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-md border border-input bg-card hover:bg-muted text-sm font-medium text-foreground transition-colors"
        >
          <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
            <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          <span>使用 Google 登录</span>
        </a>
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setShowLookup(true)}
            className="text-xs text-teal-600 hover:text-teal-700 underline"
          >
            {t('forgot_shop_link')}
          </button>
        </div>
        <div className="mt-6 pt-4 border-t border-border/50 text-xs text-muted-foreground text-center">
          {t('store_visitor_hint')} <code className="px-1 py-0.5 bg-muted rounded">your-shop.3api.pro</code>
        </div>
      </div>
      {showLookup && <LookupModal onClose={() => setShowLookup(false)} initialEmail={email} />}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Tenant-lookup modal (carry-over #21)                                 */
/* ------------------------------------------------------------------ */

function LookupModal({ onClose, initialEmail }: { onClose: () => void; initialEmail: string }) {
  const t = useTranslations('admin.login');
  const tCommon = useTranslations('common');
  const [lookupEmail, setLookupEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tenant_slug: string | null } | null>(null);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupEmail) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const res = await fetch('/api/admin/login-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: lookupEmail }),
      });
      if (res.status === 429) {
        setErr(t('lookup_rate_limited'));
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setErr(data?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setResult({ tenant_slug: data.tenant_slug });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="w-full max-w-md bg-card rounded-lg shadow-lg border border-border p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">{t('lookup_modal_title')}</h2>
        <p className="text-xs text-muted-foreground mb-4">{t('lookup_modal_desc')}</p>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            placeholder={t('email_placeholder')}
            value={lookupEmail}
            onChange={(e) => setLookupEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none text-sm"
            autoComplete="email"
          />
          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          {result && (
            result.tenant_slug ? (
              <div className="text-sm bg-emerald-50 border border-emerald-200 rounded-md px-3 py-3 text-emerald-800">
                <div className="font-medium mb-1">{t('lookup_found')}</div>
                <code className="block break-all bg-white border border-emerald-200 rounded px-2 py-1 font-mono text-xs">
                  {result.tenant_slug}.3api.pro
                </code>
              </div>
            ) : (
              <div className="text-sm bg-amber-50 border border-amber-200 rounded-md px-3 py-3 text-amber-800">
                {t('lookup_not_found')}
              </div>
            )
          )}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose}
              className="px-4 py-1.5 rounded-md border border-input text-sm hover:bg-muted">
              {tCommon('close')}
            </button>
            <button type="submit" disabled={busy || !lookupEmail}
              className="px-4 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm disabled:opacity-50">
              {busy ? t('lookup_submitting') : t('lookup_submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SubdomainAdminRedirect() {
  const [rootUrl, setRootUrl] = useState('https://3api.pro/login/');
  const t = useTranslations('admin.login');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Derive the root domain by stripping the leftmost label.
    const host = window.location.host;
    const parts = host.split('.');
    if (parts.length > 2) {
      const root = parts.slice(1).join('.');
      setRootUrl(`${window.location.protocol}//${root}/login/`);
    }
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-muted">
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8 text-center">
        <h1 className="text-xl font-semibold mb-2">{t('subdomain_title')}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('subdomain_body_1')}<br/>
          {t('subdomain_body_2')} <strong className="text-foreground">3api.pro/admin</strong>。
        </p>
        <a
          href={rootUrl}
          className="inline-block w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium"
        >
          {t('subdomain_cta')}
        </a>
        <div className="mt-4 text-xs text-muted-foreground">
          {t('subdomain_store_visitor_prefix')} <Link href="/login" className="text-teal-600 hover:text-teal-700">{t('subdomain_store_visitor_link')}</Link>
        </div>
      </div>
    </main>
  );
}

export default function AdminLogin() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-muted" />;
  return mode === 'store' ? <SubdomainAdminRedirect /> : <RootAdminLogin />;
}
