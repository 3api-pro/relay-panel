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
  custom_domain?: string | null;
  slug?: string;
}

interface DomainVerify {
  ok: boolean;
  custom_domain?: string;
  expected_target?: string;
  resolved_cnames?: string[];
  hint?: string;
  reason?: string;
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
  const [domainDraft, setDomainDraft] = useState<string>('');
  const [verify, setVerify] = useState<DomainVerify | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);
  const [bindMode, setBindMode] = useState<'cf' | 'manual'>('cf');
  const [cfToken, setCfToken] = useState<string>('');
  const [cfProxied, setCfProxied] = useState<boolean>(false);
  const [cfBusy, setCfBusy] = useState<boolean>(false);
  const [cfResult, setCfResult] = useState<{ ok: boolean; zone?: string; target?: string; note?: string; error?: string } | null>(null);

  useEffect(() => {
    safe(api<Brand>('/admin/brand'), {}).then((b) => {
      setBrand(b || {});
      setDomainDraft((b as any)?.custom_domain || '');
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

  async function saveDomain() {
    setDomainBusy(true); setMsg(''); setErr('');
    try {
      const r = await api<{ ok: boolean; custom_domain: string | null }>('/admin/brand/custom-domain', {
        method: 'PATCH',
        body: JSON.stringify({ custom_domain: domainDraft }),
      });
      setBrand({ ...brand, custom_domain: r.custom_domain });
      setMsg('域名已保存。请确保 DNS CNAME 已配置，然后点击"验证 DNS"');
      setVerify(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDomainBusy(false);
    }
  }

  async function doCloudflareCname() {
    setCfBusy(true); setCfResult(null); setMsg(''); setErr('');
    try {
      const r = await api<{ ok: boolean; zone: string; target: string; note: string; custom_domain: string }>('/admin/brand/cloudflare-cname', {
        method: 'POST',
        body: JSON.stringify({
          cf_api_token: cfToken,
          custom_domain: domainDraft,
          proxied: cfProxied,
        }),
      });
      setCfResult({ ok: true, zone: r.zone, target: r.target, note: r.note });
      setBrand({ ...brand, custom_domain: r.custom_domain });
      setCfToken('');
    } catch (e: any) {
      setCfResult({ ok: false, error: e.message });
    } finally {
      setCfBusy(false);
    }
  }

  async function verifyDomain() {
    setVerifyBusy(true); setVerify(null);
    try {
      const r = await api<DomainVerify>('/admin/brand/verify-domain');
      setVerify(r);
    } catch (e: any) {
      setVerify({ ok: false, reason: e.message });
    } finally {
      setVerifyBusy(false);
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
    
      <div className="mt-8 bg-card border border-border rounded-xl p-6">
        <h2 className="text-base font-semibold mb-1">自定义域名 (CNAME 绑定)</h2>
        <p className="text-sm text-muted-foreground mb-4">
          客户访问你的品牌域名（如 <code className="text-xs bg-muted px-1 rounded">api.your-site.com</code>），不感知 3api。系统给你的默认子域名仅供你自己后台访问，不要公布给客户。
        </p>

        {!loaded ? (
          <div className="py-6 text-center text-sm text-muted-foreground"><span className="inline-block w-4 h-4 mr-2 align-middle border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />加载中…</div>
        ) : (
          <>
            <div className="mb-4 p-3 rounded-md bg-muted/40 text-xs">
              <div className="text-muted-foreground mb-1">你的默认子域名 (仅你自己用)</div>
              <code className="font-mono text-sm font-semibold">{brand.slug ? `${brand.slug}.3api.pro` : '—'}</code>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1.5">你的自定义域名 (不含 http://)</label>
                <input
                  type="text"
                  value={domainDraft}
                  placeholder="api.your-site.com"
                  onChange={(e) => setDomainDraft(e.target.value.trim().toLowerCase())}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                />
              </div>

              {/* Tab: CF one-click vs manual */}
              <div className="grid grid-cols-2 gap-2 p-1 bg-muted rounded-lg">
                <button type="button" onClick={() => setBindMode('cf')}
                  className={`py-2 rounded-md text-sm font-medium transition-all ${bindMode === 'cf' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  Cloudflare 一键
                </button>
                <button type="button" onClick={() => setBindMode('manual')}
                  className={`py-2 rounded-md text-sm font-medium transition-all ${bindMode === 'manual' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  其他 DNS (手动)
                </button>
              </div>

              {bindMode === 'cf' ? (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-medium mb-1.5">Cloudflare API Token</label>
                    <input
                      type="password"
                      value={cfToken}
                      placeholder="开通权限: Zone.DNS Edit"
                      onChange={(e) => setCfToken(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                    />
                    <p className="text-xs text-muted-foreground mt-1">在 <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener" className="text-teal-600 hover:underline">CF Dashboard → My Profile → API Tokens</a> 创建一个 token, 模板选 "Edit zone DNS" 限定到你的域名所在 zone。Token 仅本次使用, 不会被保存。</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <input type="checkbox" id="cf_proxied" checked={cfProxied}
                      onChange={(e) => setCfProxied(e.target.checked)}
                      className="w-3.5 h-3.5" />
                    <label htmlFor="cf_proxied">启用 CF Proxy (橙云朵) — CF 提供 SSL + DDoS。关闭则走平台 LE 证书。</label>
                  </div>
                  <button
                    onClick={doCloudflareCname}
                    disabled={cfBusy || !domainDraft || !cfToken}
                    className="w-full py-2.5 rounded-md bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white text-sm font-medium disabled:opacity-50"
                  >
                    {cfBusy ? '正在通过 CF API 创建 CNAME…' : '一键创建 CNAME (经 Cloudflare)'}
                  </button>
                </div>
              ) : (
                <div>
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={saveDomain}
                      disabled={domainBusy || domainDraft === (brand.custom_domain || '')}
                      className="px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50"
                    >
                      {domainBusy ? '保存中…' : '保存域名'}
                    </button>
                    {brand.custom_domain && (
                      <button
                        onClick={verifyDomain}
                        disabled={verifyBusy}
                        className="px-4 py-2 rounded-md border border-teal-500 text-teal-700 text-sm font-medium hover:bg-teal-50 disabled:opacity-50"
                      >
                        {verifyBusy ? '验证中…' : '验证 DNS'}
                      </button>
                    )}
                  </div>
                  <div className="p-3 rounded-md bg-muted/40 text-xs space-y-1">
                    <div className="font-medium">在你的 DNS 后台 (Aliyun/GoDaddy/Namecheap/…) 加这条记录:</div>
                    <div className="font-mono text-[11px] bg-card border border-border rounded p-2 mt-1">
                      <div><span className="text-muted-foreground">类型:</span> <strong>CNAME</strong></div>
                      <div><span className="text-muted-foreground">名称 / Host:</span> <strong>{domainDraft || 'api.your-site.com'}</strong> <span className="text-muted-foreground">(完整域名或主机名)</span></div>
                      <div><span className="text-muted-foreground">值 / Target:</span> <strong>{brand.slug ? `${brand.slug}.3api.pro` : '<等加载>'}</strong></div>
                      <div className="text-muted-foreground mt-1">TTL: Auto / 300</div>
                    </div>
                    <div className="text-muted-foreground">DNS 生效后 (通常 1-15 分钟), 点击"验证 DNS"按钮。验证通过后平台自动签 SSL。</div>
                  </div>
                </div>
              )}
            </div>

            {verify && (
              <div className={`mt-3 p-3 rounded-md text-sm ${verify.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
                {verify.ok ? '✓ DNS 验证通过, 平台正在准备 SSL' : '✗ DNS 还未生效'}
                {verify.hint && <div className="text-xs mt-1">{verify.hint}</div>}
                {verify.resolved_cnames && verify.resolved_cnames.length > 0 && (
                  <div className="text-xs mt-1 font-mono opacity-75">resolved: {verify.resolved_cnames.join(', ')}</div>
                )}
                {verify.expected_target && (
                  <div className="text-xs mt-1 font-mono opacity-75">expected: {verify.expected_target}</div>
                )}
              </div>
            )}

            {cfResult && (
              <div className={`mt-3 p-3 rounded-md text-sm ${cfResult.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'}`}>
                {cfResult.ok
                  ? <>✓ Cloudflare CNAME 已创建 (zone: <code>{cfResult.zone}</code>, target: <code>{cfResult.target}</code>)。{cfResult.note}</>
                  : <>✗ {cfResult.error || 'CF API 失败'}</>}
              </div>
            )}
          </>
        )}
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
