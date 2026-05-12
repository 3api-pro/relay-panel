'use client';
/**
 * Top-level "/signup" page. Host-aware (Task #17).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';
import { StoreSignup } from '@/components/store/StoreSignup';

function MarketingSignup() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await auth.signup(email, password, name);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4" data-marketing-signup>
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1">注册账号</h1>
        <p className="text-sm text-muted-foreground mb-6">已有账号? <Link href="/login" className="text-brand-600">登录</Link></p>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="邮箱" type="email" value={email} onChange={setEmail} required />
          <Field label="密码 (≥6 位)" type="password" value={password} onChange={setPassword} required minLength={6} />
          <Field label="昵称 (可选)" value={name} onChange={setName} />
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? '注册中…' : '注册'}
          </button>
        </form>
      </div>
    </main>
  );
}

type FieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  label: string;
  value: string;
  onChange: (v: string) => void;
};

function Field({ label, value, onChange, ...inputProps }: FieldProps) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-foreground mb-1">{label}</div>
      <input {...inputProps} value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none" />
    </label>
  );
}

export default function SignupPage() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-background" />;
  return mode === 'store' ? <StoreSignup /> : <MarketingSignup />;
}
