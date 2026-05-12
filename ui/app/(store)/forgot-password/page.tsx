'use client';
import { useState } from 'react';
import Link from 'next/link';
import { store } from '@/lib/store-api';
import { Button, Input, Alert } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const t = useTranslations('storefront.forgot_password');
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
          {t('back_pre')}<Link href="/login" className="hover:underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('back_link')}</Link>
        </p>
        {done ? (
          <Alert kind="success">{t('success')}</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Input label={t('email_label')} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('ph_email')} />
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
