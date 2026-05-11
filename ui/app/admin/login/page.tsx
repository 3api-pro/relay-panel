'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';

export default function AdminLogin() {
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
      // Route to new admin home (/admin). If onboarding was paused mid-way, resume it.
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
        <h1 className="text-2xl font-semibold mb-6">站长登录</h1>
        <form onSubmit={submit} className="space-y-4">
          <input type="email" required placeholder="email" value={email} onChange={(e)=>setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-slate-300" />
          <input type="password" required placeholder="password" value={password} onChange={(e)=>setPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-slate-300" />
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button disabled={busy} className="w-full py-2.5 rounded-md bg-slate-800 text-white hover:bg-slate-900">
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </main>
  );
}
