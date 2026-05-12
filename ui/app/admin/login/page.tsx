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
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';

function RootAdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1">站长登录</h1>
        <p className="text-sm text-slate-500 mb-6">
          还没开店? <Link href="/create" className="text-teal-600 hover:text-teal-700">免费开店 →</Link>
        </p>
        <form onSubmit={submit} className="space-y-4">
          <input type="email" required placeholder="email" value={email} onChange={(e)=>setEmail(e.target.value)}
            autoComplete="email"
            className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
          <input type="password" required placeholder="password" value={password} onChange={(e)=>setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          <button disabled={busy} className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50">
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500 text-center">
          店铺访客? 请直接访问店铺子域，例如 <code className="px-1 py-0.5 bg-slate-100 rounded">your-shop.3api.pro</code>
        </div>
      </div>
    </main>
  );
}

function SubdomainAdminRedirect() {
  const [rootUrl, setRootUrl] = useState('https://3api.pro/login/');
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
    <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8 text-center">
        <h1 className="text-xl font-semibold mb-2">管理后台在 3api.pro</h1>
        <p className="text-sm text-slate-500 mb-6">
          这个域名是店铺地址（给客户访问的）。<br/>
          站长管理后台请前往 <strong className="text-slate-700">3api.pro/admin</strong>。
        </p>
        <a
          href={rootUrl}
          className="inline-block w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium"
        >
          前往 3api.pro 登录 →
        </a>
        <div className="mt-4 text-xs text-slate-400">
          要登录这个店铺账户? <Link href="/login" className="text-teal-600 hover:text-teal-700">点这里</Link>
        </div>
      </div>
    </main>
  );
}

export default function AdminLogin() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-slate-50" />;
  return mode === 'store' ? <SubdomainAdminRedirect /> : <RootAdminLogin />;
}
