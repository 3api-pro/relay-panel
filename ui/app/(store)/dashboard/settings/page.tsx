'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearToken, storeFetch } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Input, Alert, Modal, Spinner } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

export default function SettingsPage() {
  const t = useTranslations('storefront.dashboard_settings');
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">{t('title')}</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <SettingsInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function SettingsInner() {
  const t = useTranslations('storefront.dashboard_settings');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [me, setMe] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [openDelete, setOpenDelete] = useState(false);

  useEffect(() => {
    // best-effort fetch — endpoint might be /me or /auth/me
    (async () => {
      try {
        const r = await storeFetch<any>('/me');
        setMe(r);
      } catch {
        try {
          const r = await storeFetch<any>('/auth/me');
          setMe(r);
        } catch {
          setMe({ email: '—' });
        }
      }
    })();
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    if (newPwd.length < 6) { setErr(t('validate_min_pwd')); return; }
    if (newPwd !== newPwd2) { setErr(t('validate_mismatch')); return; }
    setBusy(true);
    try {
      await storeFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      setMsg(t('pwd_saved_ok'));
      setOldPwd(''); setNewPwd(''); setNewPwd2('');
    } catch (e: any) {
      if (e?.status === 404) setErr(t('endpoint_pwd_404'));
      else setErr(e?.message || t('fail_change'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setBusy(true); setErr(null);
    try {
      await storeFetch('/auth/delete-account', { method: 'POST' });
      clearToken();
      router.push('/');
    } catch (e: any) {
      if (e?.status === 404) {
        setErr(t('endpoint_del_404'));
      } else {
        setErr(e?.message || t('fail_delete'));
      }
    } finally {
      setBusy(false);
      setOpenDelete(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title={t('card_account')}>
        {!me ? (
          <div className="flex items-center text-muted-foreground text-sm"><Spinner /> <span className="ml-2">{t('loading_inline')}</span></div>
        ) : (
          <dl className="text-sm space-y-2">
            <div className="flex">
              <dt className="w-24 text-muted-foreground">{t('row_email')}</dt>
              <dd className="text-foreground">{me.email || '—'}</dd>
            </div>
            {me.created_at && (
              <div className="flex">
                <dt className="w-24 text-muted-foreground">{t('row_created')}</dt>
                <dd className="text-foreground">{me.created_at}</dd>
              </div>
            )}
            {me.aff_code && (
              <div className="flex">
                <dt className="w-24 text-muted-foreground">{t('row_aff_code')}</dt>
                <dd><code className="text-xs bg-muted px-2 py-0.5 rounded">{me.aff_code}</code></dd>
              </div>
            )}
          </dl>
        )}
        <div className="text-xs text-muted-foreground mt-3">{t('email_locked_note')}</div>
      </Card>

      <Card title={t('card_password')}>
        <form onSubmit={changePassword} className="space-y-3 max-w-md">
          <Input label={t('field_current_pwd')} type="password" required value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} />
          <Input label={t('field_new_pwd')} type="password" required value={newPwd} onChange={(e) => setNewPwd(e.target.value)} minLength={6} />
          <Input label={t('field_confirm_pwd')} type="password" required value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)} minLength={6} />
          {err && <Alert kind="error">{err}</Alert>}
          {msg && <Alert kind="success">{msg}</Alert>}
          <Button type="submit" disabled={busy}>{busy ? t('submit_pwd_busy') : t('submit_pwd')}</Button>
        </form>
      </Card>

      <Card title={t('card_danger')}>
        <div className="text-sm text-muted-foreground mb-3">{t('danger_body')}</div>
        <Button variant="danger" onClick={() => setOpenDelete(true)}>{t('delete_btn')}</Button>
      </Card>

      <Modal open={openDelete} onClose={() => !busy && setOpenDelete(false)}
        title={t('modal_title')}
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setOpenDelete(false)}>{tCommon('cancel')}</Button>
          <Button variant="danger" onClick={deleteAccount} disabled={busy}>{busy ? t('modal_confirm_busy') : t('modal_confirm')}</Button>
        </>}>
        <p className="text-sm text-muted-foreground">{t('modal_body')}</p>
      </Modal>
    </div>
  );
}
