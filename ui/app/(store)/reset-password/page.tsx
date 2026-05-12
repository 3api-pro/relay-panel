'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { store } from '@/lib/store-api';
import { Button, Input, Alert } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

// NOTE(admin-ui agent 5/12): wrapped in Suspense to satisfy Next.js static-export
// requirement when calling useSearchParams(). Carry-over for storefront agent.
function ResetPasswordFallback() {
  const t = useTranslations('storefront.reset_password');
  return (
    <div className="min-h-[60vh] flex items-center justify-center text-muted-foreground text-sm">{t('loading_inline')}</div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordFallback />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const t = useTranslations('storefront.reset_password');
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
    if (password.length < 6) { setErr(t('validate_min_pwd')); return; }
    if (password !== confirm) { setErr(t('validate_mismatch')); return; }
    setBusy(true); setErr(null);
    try {
      await store.resetPassword(token, password);
      setOk(true);
      setTimeout(() => router.push('/login'), 1500);
    } catch (e: any) {
      setErr(e?.message || t('fail'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-card rounded-lg shadow-sm border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1 text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('back_pre')}<Link href="/forgot-password" className="hover:underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('back_link')}</Link>
        </p>
        {ok ? (
          <Alert kind="success">{t('success')}</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Input label={t('token_label')} required value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('ph_token')} />
            <Input label={t('password_label')} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} />
            <Input label={t('confirm_label')} type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} />
            {err && <Alert kind="error">{err}</Alert>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? t('submit_busy') : t('submit')}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
