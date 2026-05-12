'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api, safe } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Brand {
  store_name?: string;
  logo_url?: string;
  primary_color?: string;
  announcement?: string;
  footer_html?: string;
  contact_email?: string;
}

const PRESETS = ['#0e9486', '#0ea5e9', '#6366f1', '#f59e0b', '#ef4444', '#10b981', '#1e293b'];

export default function BrandingPage() {
  const t = useTranslations('admin.branding');
  const tCommon = useTranslations('common');
  const [brand, setBrand] = useState<Brand>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    safe(api<Brand>('/admin/brand'), {}).then((b) => {
      setBrand(b || {});
      setLoaded(true);
    });
  }, []);

  function patch<K extends keyof Brand>(k: K, v: Brand[K]) {
    setBrand({ ...brand, [k]: v });
  }

  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      await api('/admin/brand', { method: 'PATCH', body: JSON.stringify(brand) });
      setMsg(t('saved_ok'));
    } catch (e: any) {
      setErr(`${t('save_failed_prefix')}${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const primary = brand.primary_color || '#0e9486';

  return (
    <AdminShell
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <button onClick={save} disabled={busy}
          className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700 disabled:opacity-50">
          {busy ? t('save_busy') : t('save')}
        </button>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live preview */}
        <section className="bg-card rounded-lg border border-border p-6 order-2 lg:order-1">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-3">{t('live_preview')}</div>
          <div className="rounded-md border border-border overflow-hidden">
            <header className="px-5 py-3 border-b border-border bg-card flex items-center justify-between">
              <div className="flex items-center gap-2">
                {brand.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={brand.logo_url} alt="logo" className="h-7 w-7 rounded object-contain" />
                ) : (
                  <div className="h-7 w-7 rounded" style={{ background: primary }} />
                )}
                <span className="font-semibold" style={{ color: primary }}>
                  {brand.store_name || t('preview_default_store_name')}
                </span>
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>{t('preview_nav_pricing')}</span><span>{t('preview_nav_login')}</span>
                <span className="px-2 py-0.5 rounded text-white text-xs" style={{ background: primary }}>{t('preview_nav_signup')}</span>
              </div>
            </header>
            <div className="px-5 py-8 text-center">
              {brand.announcement && (
                <div className="mb-4 text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  {brand.announcement}
                </div>
              )}
              <h2 className="text-2xl font-bold text-foreground">{t('preview_hero_title')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('preview_hero_subtitle')}</p>
              <button className="mt-4 px-5 py-2 rounded text-white text-sm" style={{ background: primary }}>
                {t('preview_hero_cta')}
              </button>
            </div>
            {brand.footer_html ? (
              <div className="px-5 py-3 border-t border-border text-xs text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: brand.footer_html }} />
            ) : (
              <div className="px-5 py-3 border-t border-border text-xs text-muted-foreground text-center">
                © {brand.store_name || t('preview_default_store_name')} · {brand.contact_email ?? t('preview_default_footer_contact')}
              </div>
            )}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            {t('preview_hint')}
          </div>
        </section>

        {/* Form */}
        <section className="bg-card rounded-lg border border-border p-6 order-1 lg:order-2">
          <div className="space-y-4">
            <Field label={t('field_store_name')}>
              <input type="text" value={brand.store_name ?? ''}
                onChange={(e) => patch('store_name', e.target.value)}
                placeholder={t('ph_store_name')}
                className="w-full px-3 py-2 rounded-md border border-input" />
            </Field>

            <Field label={t('field_logo')}>
              <input type="text" value={brand.logo_url ?? ''}
                onChange={(e) => patch('logo_url', e.target.value)}
                placeholder="https://your-cdn.com/logo.png"
                className="w-full px-3 py-2 rounded-md border border-input font-mono text-sm" />
              <div className="text-xs text-muted-foreground mt-1">
                {t('logo_hint')}
              </div>
            </Field>

            <Field label={t('field_primary')}>
              <div className="flex items-center gap-2 mb-2">
                <input type="color" value={primary}
                  onChange={(e) => patch('primary_color', e.target.value)}
                  className="h-9 w-12 rounded border border-input" />
                <input type="text" value={primary}
                  onChange={(e) => patch('primary_color', e.target.value)}
                  className="flex-1 px-3 py-2 rounded-md border border-input font-mono text-sm" />
              </div>
              <div className="flex gap-1.5">
                {PRESETS.map((c) => (
                  <button key={c} onClick={() => patch('primary_color', c)}
                    className="h-7 w-7 rounded border border-border hover:scale-110 transition"
                    style={{ background: c }}
                    aria-label={c} />
                ))}
              </div>
            </Field>

            <Field label={t('field_announcement')}>
              <textarea value={brand.announcement ?? ''}
                onChange={(e) => patch('announcement', e.target.value)}
                rows={3}
                placeholder={t('ph_announcement')}
                className="w-full px-3 py-2 rounded-md border border-input text-sm" />
            </Field>

            <Field label={t('field_footer')}>
              <textarea value={brand.footer_html ?? ''}
                onChange={(e) => patch('footer_html', e.target.value)}
                rows={2}
                placeholder={t('ph_footer')}
                className="w-full px-3 py-2 rounded-md border border-input text-xs font-mono" />
            </Field>

            <Field label={t('field_email')}>
              <input type="email" value={brand.contact_email ?? ''}
                onChange={(e) => patch('contact_email', e.target.value)}
                placeholder={t('ph_email')}
                className="w-full px-3 py-2 rounded-md border border-input" />
            </Field>

            <div className="text-sm pt-1">
              {msg && <span className="text-emerald-600">{msg}</span>}
              {err && <span className="text-amber-700">{err}</span>}
              {!loaded && <span className="text-muted-foreground">{tCommon('loading')}</span>}
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}
