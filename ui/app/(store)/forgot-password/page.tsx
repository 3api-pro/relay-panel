'use client';
import { useState } from 'react';
import Link from 'next/link';
import { store } from '@/lib/store-api';
import { Button, Input, Alert } from '@/components/store/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await store.forgotPassword(email);
      setDone(true);
    } catch (e: any) {
      setErr(e?.message || '提交失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1 text-slate-900">忘记密码</h1>
        <p className="text-sm text-slate-500 mb-6">
          想起来了? <Link href="/login" className="hover:underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>返回登录</Link>
        </p>
        {done ? (
          <Alert kind="success">如果该邮箱已注册, 重置链接已发送, 请查收。</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Input label="邮箱" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            {err && <Alert kind="error">{err}</Alert>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? '提交中…' : '发送重置链接'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
