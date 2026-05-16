'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Check, Circle, Plug, Package, Palette, Globe, Wallet, Sparkles,
  ChevronRight, KeyRound, Ticket, ArrowRight, Copy, ExternalLink,
} from 'lucide-react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api, safe } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface SetupStatus {
  slug: string | null;
  default_domain: string | null;
  custom_domain: string | null;
  channel_count: number;
  active_channel_count: number;
  plan_count: number;
  enabled_plan_count: number;
  end_user_count: number;
  active_token_count: number;
  unused_redemption_count: number;
  paid_order_count: number;
  payment_configured: boolean;
  brand_configured: boolean;
}

export default function SetupPage() {
  const t = useTranslations('admin.setup');
  const tg = useTranslations('admin.getting_started');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'A' | 'B'>('A');

  useEffect(() => {
    safe(api<SetupStatus>('/admin/setup-status'), null as any).then((s) => {
      setStatus(s);
      setLoading(false);
      // Auto-pick the path the user is already on.
      if (s) {
        if (s.custom_domain) setMode('A');
        else if (s.unused_redemption_count > 0 || s.active_token_count > 0) setMode('B');
      }
    });
  }, []);

  if (loading || !status) {
    return (
      <AdminShell title={t('title')} subtitle={t('subtitle')}>
        <div className="text-sm text-muted-foreground py-12 text-center">{t('loading')}</div>
      </AdminShell>
    );
  }

  const checks = {
    channel: status.active_channel_count > 0,
    plans: status.enabled_plan_count > 0,
    brand: status.brand_configured,
    domain: !!status.custom_domain,
    manualKey: status.active_token_count > 0 || status.unused_redemption_count > 0,
    payment: status.payment_configured,
    firstSale: status.paid_order_count > 0 || status.active_token_count > 0,
  };
  const distributionDone = mode === 'A' ? checks.domain : checks.manualKey;

  const sharedDoneCount = [checks.channel, checks.plans, checks.brand].filter(Boolean).length;
  const totalSteps = 6;
  const doneCount = sharedDoneCount + (distributionDone ? 1 : 0) + (checks.payment ? 1 : 0) + (checks.firstSale ? 1 : 0);

  const publicUrl = status.custom_domain || status.default_domain || '';

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      {/* Progress strip */}
      <div className="mb-6 rounded-xl border border-teal-200/70 bg-gradient-to-r from-teal-50 to-emerald-50 p-5 dark:from-teal-950/30 dark:to-emerald-950/30 dark:border-teal-800/40">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('progress_title')}</h2>
            <p className="text-sm text-muted-foreground">{t('progress_subtitle', { done: doneCount, total: totalSteps })}</p>
          </div>
          {publicUrl && (
            <a
              href={`https://${publicUrl}`}
              target="_blank"
              rel="noopener"
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-white dark:bg-card text-foreground text-xs font-medium hover:border-teal-400"
            >
              {t('open_storefront')}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="h-2 w-full bg-white/70 dark:bg-card rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all"
            style={{ width: `${(doneCount / totalSteps) * 100}%` }}
          />
        </div>
      </div>

      <div className="space-y-4">
        <Step
          n={1}
          done={checks.channel}
          Icon={Plug}
          title={t('s1_title')}
          desc={t('s1_desc')}
          bullets={[t('s1_b1'), t('s1_b2'), t('s1_b3')]}
          ctaLabel={checks.channel ? t('cta_review') : t('s1_cta')}
          ctaHref="/admin/channels"
          status={checks.channel ? t('badge_count', { n: status.active_channel_count }) : null}
        />
        <Step
          n={2}
          done={checks.plans}
          Icon={Package}
          title={t('s2_title')}
          desc={t('s2_desc')}
          bullets={[t('s2_b1'), t('s2_b2'), t('s2_b3')]}
          ctaLabel={checks.plans ? t('cta_review') : t('s2_cta')}
          ctaHref="/admin/plans"
          status={checks.plans ? t('badge_count', { n: status.enabled_plan_count }) : null}
        />
        <Step
          n={3}
          done={checks.brand}
          Icon={Palette}
          title={t('s3_title')}
          desc={t('s3_desc')}
          bullets={[t('s3_b1'), t('s3_b2'), t('s3_b3')]}
          ctaLabel={checks.brand ? t('cta_review') : t('s3_cta')}
          ctaHref="/admin/branding"
        />

        {/* Step 4: Distribution mode picker — the heart of this redesign */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-3 p-5 border-b border-border">
            <span
              className={
                'h-7 w-7 rounded-full flex items-center justify-center text-sm shrink-0 ' +
                (distributionDone ? 'bg-emerald-500 text-white' : 'bg-muted text-foreground font-semibold')
              }
            >
              {distributionDone ? <Check className="h-4 w-4" /> : 4}
            </span>
            <Globe className="h-5 w-5 text-teal-700 shrink-0" />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-foreground">{t('s4_title')}</h3>
              <p className="text-sm text-muted-foreground">{t('s4_desc')}</p>
            </div>
            {distributionDone && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                {t('badge_done')}
              </span>
            )}
          </div>

          {/* Tab pills */}
          <div className="px-5 pt-4">
            <div className="grid grid-cols-2 gap-2 p-1 bg-muted rounded-lg max-w-md">
              <button
                type="button"
                onClick={() => setMode('A')}
                className={
                  'py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-1.5 ' +
                  (mode === 'A' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground')
                }
              >
                <Globe className="h-3.5 w-3.5" /> {t('s4_tab_a')}
              </button>
              <button
                type="button"
                onClick={() => setMode('B')}
                className={
                  'py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-1.5 ' +
                  (mode === 'B' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground')
                }
              >
                <KeyRound className="h-3.5 w-3.5" /> {t('s4_tab_b')}
              </button>
            </div>
          </div>

          {mode === 'A' ? (
            <div className="p-5 space-y-3">
              <p className="text-sm text-muted-foreground">{t('s4_a_intro')}</p>
              <ol className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <span className="text-teal-700 font-mono text-xs mt-0.5">A.1</span>
                  <span>{t('s4_a_step1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-teal-700 font-mono text-xs mt-0.5">A.2</span>
                  <div className="flex-1">
                    <div>{t('s4_a_step2')}</div>
                    {status.default_domain && (
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <code className="font-mono bg-muted px-2 py-1 rounded">CNAME → {status.default_domain}</code>
                        <button
                          type="button"
                          onClick={() => { try { navigator.clipboard.writeText(status.default_domain || ''); } catch {} }}
                          className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                        >
                          <Copy className="h-3 w-3" /> {t('copy')}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-teal-700 font-mono text-xs mt-0.5">A.3</span>
                  <span>{t('s4_a_step3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-teal-700 font-mono text-xs mt-0.5">A.4</span>
                  <span>{t('s4_a_step4', { domain: status.custom_domain || t('your_domain') })}</span>
                </li>
              </ol>
              <div className="pt-2">
                <Link
                  href="/admin/branding"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
                >
                  {checks.domain ? t('s4_a_cta_done') : t('s4_a_cta')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                {status.custom_domain && (
                  <span className="ml-3 text-xs text-emerald-700">
                    ✓ {t('s4_a_bound', { domain: status.custom_domain })}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="p-5 space-y-3">
              <p className="text-sm text-muted-foreground">{t('s4_b_intro')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Link
                  href="/admin/keys"
                  className="block rounded-md border border-border bg-background hover:border-teal-400 transition-colors p-4"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <KeyRound className="h-4 w-4 text-teal-700" />
                    <span className="text-sm font-semibold text-foreground">{t('s4_b_keys_title')}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('s4_b_keys_desc')}</p>
                  <div className="mt-2 text-xs text-teal-700 inline-flex items-center gap-1">
                    {t('s4_b_keys_cta')} <ArrowRight className="h-3 w-3" />
                  </div>
                </Link>
                <Link
                  href="/admin/redemption"
                  className="block rounded-md border border-border bg-background hover:border-amber-400 transition-colors p-4"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Ticket className="h-4 w-4 text-amber-700" />
                    <span className="text-sm font-semibold text-foreground">{t('s4_b_redeem_title')}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('s4_b_redeem_desc')}</p>
                  <div className="mt-2 text-xs text-amber-700 inline-flex items-center gap-1">
                    {t('s4_b_redeem_cta')} <ArrowRight className="h-3 w-3" />
                  </div>
                </Link>
              </div>
              {status.default_domain && (
                <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
                  {t('s4_b_storefront_note')}
                  <code className="ml-1 font-mono">{status.default_domain}</code>
                </div>
              )}
            </div>
          )}
        </div>

        <Step
          n={5}
          done={checks.payment}
          Icon={Wallet}
          title={t('s5_title')}
          desc={mode === 'B' ? t('s5_desc_b') : t('s5_desc_a')}
          bullets={[t('s5_b1'), t('s5_b2'), t('s5_b3')]}
          ctaLabel={checks.payment ? t('cta_review') : t('s5_cta')}
          ctaHref="/admin/payment-config"
          optional={mode === 'B'}
        />
        <Step
          n={6}
          done={checks.firstSale}
          Icon={Sparkles}
          title={t('s6_title')}
          desc={mode === 'A' ? t('s6_desc_a') : t('s6_desc_b')}
          bullets={mode === 'A' ? [t('s6_a_b1'), t('s6_a_b2')] : [t('s6_b_b1'), t('s6_b_b2')]}
          ctaLabel={mode === 'A' ? t('s6_a_cta') : t('s6_b_cta')}
          ctaHref={mode === 'A' ? (publicUrl ? `https://${publicUrl}` : '/admin/branding') : '/admin/keys'}
          ctaExternal={mode === 'A' && !!publicUrl}
        />
      </div>
    </AdminShell>
  );
}

interface StepProps {
  n: number;
  done: boolean;
  Icon: typeof Check;
  title: string;
  desc: string;
  bullets: string[];
  ctaLabel: string;
  ctaHref: string;
  status?: string | null;
  optional?: boolean;
  ctaExternal?: boolean;
}

function Step({ n, done, Icon, title, desc, bullets, ctaLabel, ctaHref, status, optional, ctaExternal }: StepProps) {
  const t = useTranslations('admin.setup');
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-4">
        <span
          className={
            'h-7 w-7 rounded-full flex items-center justify-center text-sm shrink-0 mt-0.5 ' +
            (done ? 'bg-emerald-500 text-white' : 'bg-muted text-foreground font-semibold')
          }
        >
          {done ? <Check className="h-4 w-4" /> : n}
        </span>
        <Icon className={'h-5 w-5 shrink-0 mt-1 ' + (done ? 'text-muted-foreground' : 'text-teal-700')} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={'text-base font-semibold ' + (done ? 'text-muted-foreground line-through decoration-1' : 'text-foreground')}>
              {title}
            </h3>
            {optional && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
                {t('badge_optional')}
              </span>
            )}
            {status && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                {status}
              </span>
            )}
            {done && !status && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                {t('badge_done')}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{desc}</p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-muted-foreground">
                <Circle className="h-1.5 w-1.5 mt-2 shrink-0 fill-current" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            {ctaExternal ? (
              <a
                href={ctaHref}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
              >
                {ctaLabel} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <Link
                href={ctaHref}
                className={
                  'inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium ' +
                  (done
                    ? 'border border-border bg-background hover:bg-accent text-foreground'
                    : 'bg-teal-600 hover:bg-teal-700 text-white')
                }
              >
                {ctaLabel} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
