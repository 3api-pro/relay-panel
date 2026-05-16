'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Check, Circle, Plug, Package, Palette, Globe, Wallet, Sparkles,
  ChevronRight, X, ArrowRight, KeyRound, Ticket,
} from 'lucide-react';
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

const DISMISS_KEY = '3api_admin_getting_started_dismissed';

interface StepDef {
  id: string;
  Icon: typeof Check;
  done: boolean;
  href: string;
  hrefLabelKey: string;
}

export function GettingStarted() {
  const t = useTranslations('admin.getting_started');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    safe(api<SetupStatus>('/admin/setup-status'), null as any).then((s) => {
      setStatus(s);
      setLoading(false);
    });
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {}
  }, []);

  if (loading || !status) return null;

  const steps: StepDef[] = [
    {
      id: 'channel',
      Icon: Plug,
      done: status.active_channel_count > 0,
      href: '/admin/channels',
      hrefLabelKey: 'cta_channel',
    },
    {
      id: 'plans',
      Icon: Package,
      done: status.enabled_plan_count > 0,
      href: '/admin/plans',
      hrefLabelKey: 'cta_plans',
    },
    {
      id: 'brand',
      Icon: Palette,
      done: status.brand_configured,
      href: '/admin/branding',
      hrefLabelKey: 'cta_brand',
    },
    {
      id: 'distribution',
      Icon: Globe,
      // Either path counts as done: bound a custom domain OR issued a manual key/code.
      done: !!status.custom_domain || status.active_token_count > 0 || status.unused_redemption_count > 0,
      href: '/admin/setup',
      hrefLabelKey: 'cta_distribution',
    },
    {
      id: 'payment',
      Icon: Wallet,
      done: status.payment_configured,
      href: '/admin/payment-config',
      hrefLabelKey: 'cta_payment',
    },
    {
      id: 'first_sale',
      Icon: Sparkles,
      done: status.paid_order_count > 0 || status.active_token_count > 0,
      href: '/admin/setup',
      hrefLabelKey: 'cta_first_sale',
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;
  const allDone = doneCount === total;

  // Once everything is done AND user dismissed the celebration, hide.
  if (allDone && dismissed) return null;

  // Find the first incomplete step — that's where the primary CTA points.
  const next = steps.find((s) => !s.done);
  const distribution = steps.find((s) => s.id === 'distribution')!;

  return (
    <div className="mb-6 relative overflow-hidden rounded-xl border border-teal-200/70 dark:border-teal-800/40 bg-gradient-to-br from-teal-50 via-emerald-50 to-cyan-50 dark:from-teal-950/30 dark:via-emerald-950/30 dark:to-cyan-950/30">
      {/* Decorative blob */}
      <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-teal-300/20 blur-3xl pointer-events-none" />

      <div className="relative p-5 md:p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="h-7 w-7 rounded-md bg-teal-600 text-white flex items-center justify-center">
                <Sparkles className="h-4 w-4" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                {allDone ? t('done_title') : t('title')}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {allDone
                ? t('done_subtitle')
                : t('subtitle', { done: doneCount, total })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {next && (
              <Link
                href={next.href}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium"
              >
                {t(`step_${next.id}_cta`)}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
            <Link
              href="/admin/setup"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-white/70 dark:bg-card hover:bg-white text-foreground text-xs font-medium border border-border"
            >
              {t('view_full')}
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
            {allDone && (
              <button
                type="button"
                onClick={() => {
                  try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
                  setDismissed(true);
                }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/60"
                aria-label={t('dismiss')}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-4 h-1.5 w-full bg-white/60 dark:bg-card rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all"
            style={{ width: `${(doneCount / total) * 100}%` }}
          />
        </div>

        {/* Steps */}
        <ol className="space-y-1.5">
          {steps.map((s, i) => (
            <li key={s.id}>
              <Link
                href={s.href}
                className={
                  'group flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors ' +
                  (s.done
                    ? 'text-muted-foreground hover:bg-white/40'
                    : 'text-foreground hover:bg-white/60 dark:hover:bg-card/60')
                }
              >
                <span
                  className={
                    'h-5 w-5 rounded-full flex items-center justify-center text-xs shrink-0 ' +
                    (s.done
                      ? 'bg-emerald-500 text-white'
                      : 'border border-border bg-white text-muted-foreground')
                  }
                >
                  {s.done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <s.Icon className={'h-4 w-4 shrink-0 ' + (s.done ? 'text-muted-foreground' : 'text-teal-700')} />
                <span className={'flex-1 ' + (s.done ? 'line-through decoration-1 opacity-70' : 'font-medium')}>
                  {t(`step_${s.id}_title`)}
                </span>
                <span className="text-xs text-muted-foreground hidden md:inline">
                  {t(`step_${s.id}_hint`)}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>

              {/* Distribution branch — show A/B sub-paths inline when this step is current/active */}
              {s.id === 'distribution' && !distribution.done && (
                <div className="ml-8 mr-2 mt-1 mb-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Link
                    href="/admin/branding"
                    className="rounded-md border border-teal-200 bg-white dark:bg-card hover:border-teal-400 transition-colors p-3 text-xs flex items-start gap-2"
                  >
                    <Globe className="h-4 w-4 text-teal-700 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-medium text-foreground">{t('path_a_title')}</div>
                      <div className="text-muted-foreground mt-0.5">{t('path_a_desc')}</div>
                    </div>
                  </Link>
                  <Link
                    href="/admin/keys"
                    className="rounded-md border border-amber-200 bg-white dark:bg-card hover:border-amber-400 transition-colors p-3 text-xs flex items-start gap-2"
                  >
                    <KeyRound className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-medium text-foreground">{t('path_b_title')}</div>
                      <div className="text-muted-foreground mt-0.5">{t('path_b_desc')}</div>
                    </div>
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ol>

        {/* Footer hint when bound but no traffic yet */}
        {status.custom_domain && status.paid_order_count === 0 && status.active_token_count === 0 && (
          <div className="mt-4 text-xs text-muted-foreground bg-white/60 dark:bg-card rounded-md p-3 border border-border">
            <span className="font-medium text-foreground">{t('tip_title')}</span>{' '}
            {t('tip_share', { domain: status.custom_domain })}
          </div>
        )}
        {!status.custom_domain && status.unused_redemption_count > 0 && (
          <div className="mt-4 text-xs text-muted-foreground bg-white/60 dark:bg-card rounded-md p-3 border border-border flex items-center gap-2">
            <Ticket className="h-3.5 w-3.5 text-amber-700" />
            {t('tip_redemption', { count: status.unused_redemption_count })}
          </div>
        )}
      </div>
    </div>
  );
}
