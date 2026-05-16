'use client';
import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Copy, Check, AlertCircle, RefreshCw, Trash2, Eye, EyeOff } from 'lucide-react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Plan {
  id: number;
  name: string;
  slug: string;
  period_days: number;
  quota_tokens: number | null;
  price_cents: number;
  enabled: boolean;
  billing_type: string;
}

interface EndUser {
  id: number;
  email: string;
  display_name: string | null;
  status: string;
  quota_cents: number;
  used_quota_cents: number;
}

interface Token {
  id: number;
  end_user_id: number;
  end_user_email?: string;
  name: string;
  key_prefix: string;
  status: string;
  remain_quota_cents: number;
  unlimited_quota: boolean;
  used_quota_cents: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface SetupStatus {
  slug: string | null;
  default_domain: string | null;
  custom_domain: string | null;
}

const QUOTA_PRESETS = [
  { label: '¥10', cents: 1000 },
  { label: '¥50', cents: 5000 },
  { label: '¥100', cents: 10000 },
  { label: '¥500', cents: 50000 },
];

const EXPIRY_PRESETS = [
  { label: '30 天', days: 30 },
  { label: '90 天', days: 90 },
  { label: '180 天', days: 180 },
  { label: '永久', days: 0 },
];

export default function KeysPage() {
  const t = useTranslations('admin.keys');
  const tCommon = useTranslations('common');

  const [plans, setPlans] = useState<Plan[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [users, setUsers] = useState<EndUser[]>([]);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state
  const [label, setLabel] = useState('');
  const [planMode, setPlanMode] = useState<'plan' | 'custom'>('custom');
  const [planId, setPlanId] = useState<number | ''>('');
  const [unlimited, setUnlimited] = useState(false);
  const [quotaYuan, setQuotaYuan] = useState('50');
  const [expiryDays, setExpiryDays] = useState<number>(30);
  const [keyName, setKeyName] = useState('');
  const [busy, setBusy] = useState(false);

  // Result modal
  const [issued, setIssued] = useState<{ key: string; user_email: string; storefront_url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [p, u, s] = await Promise.all([
      safe(api<{ data: Plan[] }>('/admin/plans'), { data: [] }),
      safe(api<{ data: EndUser[] }>('/admin/end-users?limit=200'), { data: [] }),
      safe(api<SetupStatus>('/admin/setup-status'), null as any),
    ]);
    setPlans((p.data || []).filter((pl) => pl.enabled));
    setUsers(u.data || []);
    setStatus(s);

    // Load tokens for each user with at least one issued key.
    // We don't have a tenant-wide token list endpoint, so fan-out per user.
    const byUser = await Promise.all(
      (u.data || []).map((eu) =>
        safe(api<{ data: Token[] }>(`/admin/end-users/${eu.id}/tokens`), { data: [] }).then(
          (r) => (r.data || []).map((tk) => ({ ...tk, end_user_email: eu.email })),
        ),
      ),
    );
    const flat: Token[] = byUser.flat();
    flat.sort((a, b) => b.id - a.id);
    setTokens(flat);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  function pickPreset(cents: number) {
    setPlanMode('custom');
    setUnlimited(false);
    setQuotaYuan(String((cents / 100).toFixed(0)));
  }

  async function issueKey() {
    if (!label.trim()) {
      alert(t('err_label_required'));
      return;
    }
    setBusy(true);
    try {
      // 1) Coin a fake email if the label isn't already one. The reseller never
      //    needs the customer to sign in — the API key is the only handle.
      const email = label.includes('@')
        ? label.trim().toLowerCase()
        : `${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}@manual.local`;

      // Random password (the customer never sees this; backend requires it).
      const randomPw = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

      let initialQuotaCents = 0;
      let unlimitedKey = false;
      let allowedModels: string[] | undefined;

      if (planMode === 'plan' && planId) {
        const plan = plans.find((p) => p.id === planId);
        if (plan) {
          // Use the plan's wholesale value as the customer's quota envelope.
          initialQuotaCents = plan.quota_tokens || 0;
          // If plan has no quota (e.g. unlimited subscription), treat as unlimited.
          if (!initialQuotaCents) unlimitedKey = true;
        }
      } else if (unlimited) {
        unlimitedKey = true;
      } else {
        initialQuotaCents = Math.round(parseFloat(quotaYuan || '0') * 100);
        if (initialQuotaCents <= 0) {
          alert(t('err_quota_positive'));
          setBusy(false);
          return;
        }
      }

      // 2) Create the end_user (handles 409 by reusing existing user).
      let userId: number;
      try {
        const created = await api<{ id: number }>('/admin/end-users', {
          method: 'POST',
          body: JSON.stringify({
            email,
            password: randomPw,
            display_name: label.trim(),
            initial_quota_cents: initialQuotaCents,
          }),
        });
        userId = created.id;
      } catch (e: any) {
        if (String(e.message).includes('409') || String(e.message).includes('already exists')) {
          // Reuse — find existing user, top up quota delta.
          const existing = users.find((u) => u.email === email);
          if (!existing) throw new Error(t('err_user_exists_unfound'));
          userId = existing.id;
          if (initialQuotaCents > 0) {
            await api(`/admin/end-users/${existing.id}/topup`, {
              method: 'POST',
              body: JSON.stringify({ amount_cents: initialQuotaCents }),
            });
          }
        } else {
          throw e;
        }
      }

      // 3) Sign the token.
      const expiresAt =
        expiryDays > 0
          ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      const tk = await api<{ key: string }>(`/admin/end-users/${userId}/tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: keyName.trim() || t('default_key_name'),
          remain_quota_cents: initialQuotaCents,
          unlimited_quota: unlimitedKey,
          allowed_models: allowedModels,
          expires_at: expiresAt,
        }),
      });

      const storefrontUrl =
        (status?.custom_domain && `https://${status.custom_domain}/v1`) ||
        (status?.default_domain && `https://${status.default_domain}/v1`) ||
        '';

      setIssued({ key: tk.key, user_email: email, storefront_url: storefrontUrl });
      setRevealed(false);
      setCopied(false);

      // Reset form for the next customer.
      setLabel('');
      setKeyName('');
      // Refresh the list in the background.
      loadAll();
    } catch (e: any) {
      alert(`${t('err_issue_prefix')}${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tk: Token) {
    if (!confirm(t('confirm_revoke', { prefix: tk.key_prefix }))) return;
    try {
      await api(`/admin/tokens/${tk.id}/revoke`, { method: 'POST' });
      loadAll();
    } catch (e: any) {
      alert(`${t('err_revoke_prefix')}${e.message}`);
    }
  }

  function copy(text: string) {
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  const shareTemplate = useMemo(() => {
    if (!issued) return '';
    const url = issued.storefront_url || 'https://api.example.com/v1';
    return t('share_template', { key: issued.key, url });
  }, [issued, t]);

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Issue form */}
        <div className="lg:col-span-1">
          <div className="bg-card border border-border rounded-xl p-5 sticky top-4">
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="h-5 w-5 text-teal-700" />
              <h2 className="text-base font-semibold">{t('form_title')}</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{t('form_subtitle')}</p>

            <div className="space-y-4">
              <div>
                <Label htmlFor="label">{t('field_label')}</Label>
                <Input
                  id="label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('field_label_ph')}
                />
                <p className="text-xs text-muted-foreground mt-1">{t('field_label_hint')}</p>
              </div>

              <div>
                <Label>{t('field_quota')}</Label>
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-muted rounded-md mb-2">
                  <button
                    type="button"
                    onClick={() => setPlanMode('custom')}
                    className={
                      'py-1.5 rounded text-xs font-medium transition-colors ' +
                      (planMode === 'custom' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')
                    }
                  >
                    {t('quota_mode_custom')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlanMode('plan')}
                    disabled={plans.length === 0}
                    className={
                      'py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 ' +
                      (planMode === 'plan' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')
                    }
                  >
                    {t('quota_mode_plan')}
                  </button>
                </div>

                {planMode === 'custom' ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        id="unlimited"
                        checked={unlimited}
                        onChange={(e) => setUnlimited(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      <label htmlFor="unlimited" className="text-xs text-muted-foreground">
                        {t('unlimited_label')}
                      </label>
                    </div>
                    {!unlimited && (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">¥</span>
                          <Input
                            type="number"
                            value={quotaYuan}
                            onChange={(e) => setQuotaYuan(e.target.value)}
                            min={1}
                          />
                        </div>
                        <div className="flex gap-1.5 mt-2">
                          {QUOTA_PRESETS.map((p) => (
                            <button
                              key={p.cents}
                              type="button"
                              onClick={() => pickPreset(p.cents)}
                              className="px-2 py-0.5 rounded text-xs bg-muted hover:bg-accent text-muted-foreground hover:text-foreground"
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <select
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value ? parseInt(e.target.value, 10) : '')}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">{t('plan_pick_placeholder')}</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {fmtCNY(p.price_cents)}{p.period_days ? ` / ${p.period_days}d` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <Label>{t('field_expiry')}</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {EXPIRY_PRESETS.map((e) => (
                    <button
                      key={e.days}
                      type="button"
                      onClick={() => setExpiryDays(e.days)}
                      className={
                        'px-3 py-1.5 rounded-md text-xs transition-colors ' +
                        (expiryDays === e.days
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground')
                      }
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="key_name">{t('field_key_name')}</Label>
                <Input
                  id="key_name"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder={t('field_key_name_ph')}
                />
              </div>

              <Button
                onClick={issueKey}
                disabled={busy || !label.trim()}
                className="w-full bg-teal-600 hover:bg-teal-700 text-white"
              >
                {busy ? t('issuing') : t('issue_button')}
              </Button>
            </div>
          </div>
        </div>

        {/* List */}
        <div className="lg:col-span-2">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold">{t('list_title')}</h2>
                <p className="text-xs text-muted-foreground">{t('list_subtitle', { n: tokens.length })}</p>
              </div>
              <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
                <RefreshCw className={'h-3.5 w-3.5 mr-1 ' + (loading ? 'animate-spin' : '')} />
                {tCommon('retry')}
              </Button>
            </div>

            {loading ? (
              <div className="text-sm text-muted-foreground py-12 text-center">{tCommon('loading')}</div>
            ) : tokens.length === 0 ? (
              <div className="border-2 border-dashed border-border rounded-lg p-10 text-center">
                <KeyRound className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">{t('empty_title')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('empty_hint')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left font-medium py-2">{t('col_customer')}</th>
                      <th className="text-left font-medium py-2">{t('col_key')}</th>
                      <th className="text-left font-medium py-2">{t('col_balance')}</th>
                      <th className="text-left font-medium py-2">{t('col_expires')}</th>
                      <th className="text-left font-medium py-2">{t('col_status')}</th>
                      <th className="text-right font-medium py-2">{tCommon('actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((tk) => (
                      <tr key={tk.id} className="border-b border-border/50 last:border-b-0">
                        <td className="py-2.5">
                          <div className="text-foreground">{tk.end_user_email?.replace(/-\w+@manual\.local$/, '') || '-'}</div>
                          <div className="text-xs text-muted-foreground">{tk.name}</div>
                        </td>
                        <td className="py-2.5">
                          <code className="text-xs font-mono">{tk.key_prefix}…</code>
                        </td>
                        <td className="py-2.5 text-xs">
                          {tk.unlimited_quota ? (
                            <span className="text-violet-700">{t('unlimited_badge')}</span>
                          ) : (
                            <>
                              {fmtCNY(Math.max(0, tk.remain_quota_cents - tk.used_quota_cents))}
                              <span className="text-muted-foreground"> / {fmtCNY(tk.remain_quota_cents)}</span>
                            </>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground">
                          {tk.expires_at ? fmtDate(tk.expires_at) : t('forever')}
                        </td>
                        <td className="py-2.5">
                          <span
                            className={
                              'text-xs px-2 py-0.5 rounded ' +
                              (tk.status === 'active'
                                ? 'bg-emerald-500/10 text-emerald-700'
                                : 'bg-muted text-muted-foreground')
                            }
                          >
                            {tk.status}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          {tk.status === 'active' ? (
                            <button
                              onClick={() => revoke(tk)}
                              className="text-xs text-rose-600 hover:underline inline-flex items-center gap-1"
                            >
                              <Trash2 className="h-3 w-3" /> {t('revoke')}
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* No-domain hint */}
          {status && !status.custom_domain && (
            <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:border-amber-800/40 dark:text-amber-200 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                {t('no_domain_hint_pre')}{' '}
                <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">
                  https://{status.default_domain}/v1
                </code>
                {t('no_domain_hint_post')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Issued-key modal: show key once + share template */}
      <Modal
        open={!!issued}
        onClose={() => setIssued(null)}
        title={t('issued_title')}
      >
        {issued && (
          <div className="space-y-4">
            <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 rounded-md p-3 text-sm text-emerald-900 dark:text-emerald-200 flex items-start gap-2">
              <Check className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{t('issued_warn')}</div>
            </div>

            <div>
              <Label>{t('issued_key_label')}</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded break-all">
                  {revealed ? issued.key : issued.key.slice(0, 16) + '…' + '•'.repeat(16)}
                </code>
                <Button variant="outline" size="sm" onClick={() => setRevealed(!revealed)}>
                  {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" onClick={() => copy(issued.key)}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <div>
              <Label>{t('issued_share_label')}</Label>
              <textarea
                readOnly
                value={shareTemplate}
                className="w-full h-40 mt-1 font-mono text-xs bg-muted/40 border border-border rounded-md p-3 resize-none"
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => copy(shareTemplate)}
              >
                <Copy className="h-3.5 w-3.5 mr-1" /> {t('copy_share')}
              </Button>
            </div>

            <div className="flex justify-end pt-2">
              <Button onClick={() => setIssued(null)}>{tCommon('close')}</Button>
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
