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

function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1">站长登录</h1>
        <p className="text-sm text-slate-500 mb-6">
          还没开店? <Link href="/create" className="text-teal-600 hover:text-teal-700">免费开店 →</Link>
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">邮箱</div>
            <input
              type="email" required value={email} onChange={(e)=>setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">密码</div>
            <input
              type="password" required value={password} onChange={(e)=>setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
            />
          </label>
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          <button
            type="submit" disabled={busy}
            className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50">
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500 text-center">
          店铺访客? 请直接访问店铺的子域，例如 <code className="px-1 py-0.5 bg-slate-100 rounded">your-shop.3api.pro</code>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-slate-50" />;
  return mode === 'store' ? <StoreLogin /> : <AdminLogin />;
}
