'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { store } from '@/lib/store-api';
import { Button, Input, Alert } from '@/components/store/ui';

// NOTE(admin-ui agent 5/12): wrapped in Suspense to satisfy Next.js static-export
// requirement when calling useSearchParams(). Carry-over for storefront agent.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh] flex items-center justify-center text-slate-400 text-sm">加载中…</div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const t = sp?.get('token');
    if (t) setToken(t);
  }, [sp]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) { setErr('密码至少 6 位'); return; }
    if (password !== confirm) { setErr('两次输入不一致'); return; }
    setBusy(true); setErr(null);
    try {
      await store.resetPassword(token, password);
      setOk(true);
      setTimeout(() => router.push('/login'), 1500);
    } catch (e: any) {
      setErr(e?.message || '重置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1 text-slate-900">设置新密码</h1>
        <p className="text-sm text-slate-500 mb-6">
          没收到链接? <Link href="/forgot-password" className="hover:underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>重新发送</Link>
        </p>
        {ok ? (
          <Alert kind="success">密码已重置, 即将跳转登录…</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Input label="重置 token" required value={token} onChange={(e) => setToken(e.target.value)} placeholder="从邮件链接获取" />
            <Input label="新密码" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} />
            <Input label="确认密码" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} />
            {err && <Alert kind="error">{err}</Alert>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? '提交中…' : '重置密码'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
