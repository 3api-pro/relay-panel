'use client';
/**
 * Top-level "/login" page. Host-aware (Task #17).
 *   - root marketing host  → 3api customer/admin login (uses /api/customer)
 *   - tenant subdomain     → store login (uses /api/storefront/auth)
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';
import { StoreLogin } from '@/components/store/StoreLogin';

function MarketingLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await auth.login(email, password);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4" data-marketing-login>
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1">登录</h1>
        <p className="text-sm text-slate-500 mb-6">没账号? <Link href="/signup" className="text-brand-600">注册</Link></p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">邮箱</div>
            <input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-brand-500 focus:outline-none" />
          </label>
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">密码</div>
            <input type="password" required value={password} onChange={(e)=>setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-brand-500 focus:outline-none" />
          </label>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? '登录中…' : '登录'}
          </button>
          <div className="text-center text-sm text-slate-500 pt-2">
            <Link href="/admin/login" className="hover:text-brand-700">站长登录 →</Link>
          </div>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-slate-50" />;
  return mode === 'store' ? <StoreLogin /> : <MarketingLogin />;
}
