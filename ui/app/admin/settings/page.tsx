'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api, safe, auth } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Me {
  admin?: { email: string };
  tenant?: { slug: string; saas_domain?: string | null };
}

export default function SettingsPage() {
  const t = useTranslations('admin.settings');
  const [me, setMe] = useState<Me | null>(null);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    safe(api<Me>('/admin/me'), { admin: { email: '' }, tenant: { slug: '' } }).then(setMe);
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwBusy(true); setPwMsg(''); setPwErr('');
    try {
      await api('/admin/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      setPwMsg(t('password_saved_ok'));
      setOldPw(''); setNewPw('');
    } catch (e: any) {
      setPwErr(`${t('password_failed_prefix')}${e.message}`);
    } finally {
      setPwBusy(false);
    }
  }

  function deleteAccount() {
    const slug = me?.tenant?.slug ?? '';
    const v = prompt(`${t('delete_confirm_prefix')}${slug}${t('delete_confirm_suffix')}`);
    if (v !== slug) {
      alert(t('delete_slug_mismatch'));
      return;
    }
    alert(t('delete_pending'));
  }

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="space-y-6 max-w-3xl">
        <Section title={t('section_account')}>
          <Row label={t('row_login_email')} value={me?.admin?.email ?? '—'} />
          <Row label={t('row_slug')} value={me?.tenant?.slug ?? '—'} mono />
          <Row label={t('row_custom_domain')} value={me?.tenant?.saas_domain ?? t('custom_domain_unset')} />
        </Section>

        <Section title={t('section_password')}>
          <form onSubmit={changePassword} className="space-y-3 text-sm">
            <input type="password" required placeholder={t('ph_current_pwd')} value={oldPw} onChange={(e) => setOldPw(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input" />
            <input type="password" required minLength={6} placeholder={t('ph_new_pwd')} value={newPw} onChange={(e) => setNewPw(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input" />
            <div className="flex items-center justify-between">
              <div className="text-xs">
                {pwMsg && <span className="text-emerald-600">{pwMsg}</span>}
                {pwErr && <span className="text-amber-700">{pwErr}</span>}
              </div>
              <button disabled={pwBusy}
                className="px-4 py-1.5 rounded-md bg-accent text-white text-sm hover:bg-foreground disabled:opacity-50">
                {pwBusy ? t('submit_password_busy') : t('submit_password')}
              </button>
            </div>
          </form>
        </Section>

        <Section title={t('section_2fa')}>
          <p className="text-sm text-muted-foreground">
            {t('twofa_body')}
          </p>
        </Section>

        <Section title={t('section_api')}>
          <div className="space-y-1.5 text-sm">
            <a href="/api/openapi" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
              {t('api_openapi_link')}
            </a>
            <div className="text-xs text-muted-foreground">
              {t('api_webhook_hint')}
            </div>
          </div>
        </Section>

        <Section title={t('section_danger')} danger>
          <p className="text-sm text-rose-700 mb-3">
            {t('danger_body')}
          </p>
          <button onClick={deleteAccount}
            className="px-4 py-1.5 rounded-md border border-rose-300 text-rose-700 text-sm hover:bg-rose-50">
            {t('delete_btn')}
          </button>
        </Section>
      </div>
    </AdminShell>
  );
}

function Section({ title, children, danger }: { title: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <section className={
      'bg-card rounded-lg border p-5 ' +
      (danger ? 'border-rose-200' : 'border-border')
    }>
      <h2 className={'font-semibold mb-3 ' + (danger ? 'text-rose-700' : 'text-foreground')}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center py-1.5 text-sm">
      <div className="w-28 text-muted-foreground">{label}</div>
      <div className={mono ? 'font-mono text-foreground' : 'text-foreground'}>{value}</div>
    </div>
  );
}
