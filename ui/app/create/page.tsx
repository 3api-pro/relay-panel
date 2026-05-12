'use client';
/**
 * Public tenant self-signup page. Auto-generates a slug (market convention —
 * Vercel/Supabase/Netlify style). Operators can rename later from /admin/settings.
 *
 * On success the server has already minted an admin JWT (HttpOnly cookie) and
 * we stash the token in localStorage for the Bearer-header path, then redirect
 * straight into /admin on the root domain. No subdomain hop needed.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Info {
  enabled: boolean;
  saas_domain: string | null;
  slug_auto_assigned: boolean;
}

interface Done {
  tenant_slug: string;
  store_url: string;
  redirect_to: string;
}

export default function CreatePanelPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);
  // Affiliate referral code from URL ?ref=<aff_code> (v0.4 P2 #18). Captured
  // once on mount so reloads don't lose it; passed through to the signup body.
  const [refCode, setRefCode] = useState<string>('');
  const t = useTranslations('admin.create_panel');
  const tCommon = useTranslations('common');

  useEffect(() => {
    fetch('/api/signup-tenant/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
    try {
      const params = new URLSearchParams(window.location.search);
      const r = (params.get('ref') || '').trim().toLowerCase();
      if (r && r.length >= 4 && r.length <= 16 && /^[a-z0-9_-]+$/.test(r)) {
        setRefCode(r);
      }
    } catch {}
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const payload: Record<string, string> = { admin_email: email, admin_password: password };
      if (refCode) payload.ref = refCode;
      const res = await fetch('/api/signup-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      // Server set the HttpOnly cookie. We also stash the token in
      // localStorage so the SDK-style Bearer path works for the
      // dashboard's existing fetchers.
      if (data.token) auth.setToken(data.token);
      setDone({
        tenant_slug: data.tenant.slug,
        store_url: data.store_url,
        redirect_to: data.redirect_to || '/admin',
      });
      // Auto-redirect into /admin after a brief success peek.
      setTimeout(() => {
        router.push(data.redirect_to || '/admin');
      }, 1500);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  if (info && !info.enabled) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-background">
        <div className="max-w-md w-full bg-card rounded-lg border border-border p-8 text-center">
          <h1 className="text-xl font-semibold mb-2">{t('disabled_title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('disabled_body_pre')}<code className="px-1.5 py-0.5 bg-muted rounded">TENANT_SELF_SIGNUP=on</code> {t('disabled_body_post')}
          </p>
          <Link href="/" className="inline-block mt-6 text-sm text-teal-600 hover:text-teal-700">{t('back_home')}</Link>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-background">
        <div className="max-w-lg w-full bg-card rounded-lg border border-border p-8">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded-full bg-teal-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-teal-600" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.4 7.4a1 1 0 0 1-1.4 0L3.3 9.5a1 1 0 1 1 1.4-1.4l3.2 3.2 6.7-6.7a1 1 0 0 1 1.4 0z" clipRule="evenodd"/>
              </svg>
            </div>
            <h1 className="text-xl font-semibold">{t('done_title')}</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-6">{t('done_subtitle')}</p>

          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{t('done_url_label')}</div>
              <div className="flex items-center gap-2 px-3 py-2.5 bg-background rounded-md border border-border">
                <code className="flex-1 text-sm font-mono text-foreground truncate">{done.store_url}</code>
                <button onClick={() => copy(done.store_url)} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                  {copied ? tCommon('copied') : tCommon('copy')}
                </button>
              </div>
            </div>

            <div>
              <a
                href={done.redirect_to}
                className="block w-full py-2.5 text-center rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium"
              >
                {t('done_enter_admin')}
              </a>
            </div>

            <div className="pt-4 border-t border-border/50 text-xs text-muted-foreground space-y-1">
              <p>{t('done_note_1_pre')}<strong className="text-foreground">3api.pro/admin</strong>{t('done_note_1_post')}</p>
              <p>{t('done_note_2_pre')}<strong className="text-foreground">{done.tenant_slug}.3api.pro</strong>{t('done_note_2_post')}</p>
              <p>{t('done_note_3')}</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="max-w-md w-full bg-card rounded-lg border border-border p-8">
        <h1 className="text-2xl font-semibold mb-1">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('already_account_prefix')} <Link href="/login/" className="text-teal-600 hover:text-teal-700">{t('login_link')}</Link>
        </p>

        {refCode && (
          <div className="mb-4 px-3 py-2 rounded-md border border-teal-500/40 bg-teal-500/5 text-teal-700 dark:text-teal-400 text-xs">
            通过站长邀请码 <code className="font-mono">{refCode}</code> 注册 · 邀请人将获得后续订单 10% 终身分成
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1.5">{t('email_label')}</div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              placeholder={t('email_placeholder')}
            />
          </label>

          <label className="block">
            <div className="text-sm font-medium text-foreground mb-1.5">{t('password_label')} <span className="text-muted-foreground font-normal">{t('password_hint')}</span></div>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full px-3 py-2 rounded-md border border-input focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
            />
          </label>

          <div className="text-xs text-muted-foreground bg-background border border-border rounded-md px-3 py-2.5 leading-relaxed">
            <div className="font-medium text-foreground mb-0.5">{t('auto_subdomain_title')}</div>
            {t('auto_subdomain_desc')}
          </div>

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? t('submit_busy') : t('submit')}
          </button>
        </form>

        <p className="text-xs text-muted-foreground mt-6 text-center">
          {t('tos_prefix')}<Link href="/" className="underline">{t('tos_link')}</Link>
        </p>
      </div>
    </main>
  );
}
