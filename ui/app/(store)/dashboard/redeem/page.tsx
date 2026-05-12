'use client';
import { useState } from 'react';
import { storeFetch, StoreApiError, fmtCents } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Input, Alert } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

interface RedeemResp { added_cents: number }

export default function RedeemPage() {
  const t = useTranslations('storefront.redeem');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<RedeemResp | null>(null);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c) {
      setErr(t('err_empty'));
      return;
    }
    setBusy(true); setErr(''); setOk(null);
    try {
      const r = await storeFetch<RedeemResp>('/customer/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: c }),
      });
      setOk(r);
      setCode('');
    } catch (e: any) {
      if (e instanceof StoreApiError) {
        if (e.status === 404) setErr(t('err_not_found'));
        else if (e.status === 409) setErr(t('err_already_used'));
        else if (e.status === 410) setErr(t('err_expired'));
        else setErr(e.message);
      } else {
        setErr(String(e?.message || e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight mb-6">{t('title')}</h1>
        <div className="grid sm:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <div className="space-y-4">
            <Card>
              <h2 className="text-base font-semibold mb-1">{t('card_title')}</h2>
              <p className="text-sm text-muted-foreground mb-4">{t('card_subtitle')}</p>
              <form onSubmit={submit} className="space-y-3 max-w-md">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  disabled={busy}
                  className="font-mono"
                />
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={busy || !code.trim()}>
                    {busy ? t('submitting') : t('submit')}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t('help')}</span>
                </div>
              </form>

              {ok && (
                <div className="mt-4">
                  <Alert kind="success">
                    {t('success_prefix')}<strong className="font-semibold">{fmtCents(ok.added_cents)}</strong>{t('success_suffix')}
                  </Alert>
                </div>
              )}
              {err && (
                <div className="mt-4">
                  <Alert kind="error">{err}</Alert>
                </div>
              )}
            </Card>

            <Card>
              <h2 className="text-base font-semibold mb-1">{t('faq_title')}</h2>
              <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-5">
                <li>{t('faq_q1')}</li>
                <li>{t('faq_q2')}</li>
                <li>{t('faq_q3')}</li>
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
