'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Star, Zap, Wallet, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, safe } from '@/lib/api';
import { formatTestError } from '@/lib/format-test-error';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/lib/i18n';

/**
 * "Use Recommended" hero card on the channels page.
 *
 * Surfaces the platform-default channel (is_recommended=true) and the
 * tenant's current wholesale balance so the operator can see at a glance
 * whether their store has runway. This is 3api's unfair advantage made
 * literal: one card, "you already have an upstream — go top up".
 */

interface RecommendedChannel {
  id: number;
  name: string;
  base_url: string;
  provider_type: string;
  enabled: boolean;
  is_recommended: boolean;
  last_test_result?: { ok: boolean; latency_ms?: number; status?: number; error?: string } | null;
  last_tested_at?: string | null;
  keys_total?: number;
  keys_active?: number;
}

interface WholesaleSummary {
  balance_cents: number;
  updated_at: string | null;
}

interface Props {
  channels: RecommendedChannel[];
  onTest?: (channelId: number) => Promise<void>;
}

function fmtCents(c: number): string {
  if (c == null) return '¥0.00';
  const yuan = c / 100;
  if (yuan < 1) return `¥${yuan.toFixed(2)}`;
  return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ChannelHero({ channels, onTest }: Props) {
  const t = useTranslations('admin.channel.hero');
  const tChannels = useTranslations('admin.channels');
  const [ws, setWs] = useState<WholesaleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);

  useEffect(() => {
    safe(api<WholesaleSummary>('/admin/wholesale'), { balance_cents: 0, updated_at: null })
      .then((r) => setWs(r))
      .finally(() => setLoading(false));
  }, []);

  // Filter on the client even though the server already sorts is_recommended
  // first — keeps this card independent of GET-ordering changes.
  const recs = channels.filter((c) => c.is_recommended);
  if (recs.length === 0) {
    // No recommended upstream yet — surface a buy CTA so a 3api-first signup
    // can discover the llmapi.pro wholesale path. After purchase the user
    // clicks the 3api handoff inside their llmapi dashboard; SSO auto-mints
    // sk-relay-* and INSERTs the channel here. See sso-llmapi.ts.
    return (
      <Card className="border-teal-200 bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-950/30 dark:to-cyan-950/20 dark:border-teal-900">
        <CardContent className="py-5 px-6 flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <h3 className="text-base font-semibold text-teal-900 dark:text-teal-200 flex items-center gap-2">
              <Zap className="w-4 h-4" />
              {t('no_upstream_title')}
            </h3>
            <p className="text-sm text-teal-700 dark:text-teal-300/80 mt-1 leading-relaxed">
              {t('no_upstream_desc')}
            </p>
          </div>
          <a href="https://llmapi.pro/pricing" target="_blank" rel="noopener noreferrer">
            <Button className="bg-teal-600 hover:bg-teal-700 text-white">
              {t('no_upstream_cta')}
            </Button>
          </a>
        </CardContent>
      </Card>
    );
  }

  // Show at most one hero, the lowest-id recommended channel.
  const c = recs[0];
  const balance = ws?.balance_cents ?? 0;
  // ¥50 / 5000 cents threshold — arbitrary but matches the seed in
  // smoke-payments / smoke-v02 (¥100000 typical). Below this we nag.
  const lowBalance = balance < 5000;

  const lastTest = c.last_test_result;
  const testOk = lastTest?.ok === true;
  const testBad = lastTest?.ok === false;

  async function handleTest() {
    if (!onTest) return;
    setTesting(c.id);
    try {
      await onTest(c.id);
    } finally {
      setTesting(null);
    }
  }

  return (
    <Card
      className={cn(
        'mb-5 overflow-hidden border-brand-300/60 dark:border-brand-700/60',
        // Subtle brand wash — no purple/indigo per memory feedback_no_ai_gradient.
        'bg-gradient-to-br from-brand-50/80 via-brand-50/40 to-background',
        'dark:from-brand-950/40 dark:via-brand-950/20 dark:to-background',
      )}
      data-tour="channel-hero"
    >
      <CardContent className="py-5 px-5">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="shrink-0 w-12 h-12 rounded-xl bg-brand-600 text-white flex items-center justify-center">
            <Star className="w-6 h-6 fill-current" />
          </div>
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground">
                {t('title')}
              </h2>
              <Badge
                variant="default"
                className="h-5 text-[10px] bg-brand-600 hover:bg-brand-700 text-white"
              >
                {t('badge_zero_inv')}
              </Badge>
              <Badge variant="outline" className="h-5 text-[10px] gap-1">
                <Zap className="w-3 h-3" />
                {t('badge_oneclick')}
              </Badge>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t('body_pre')}<b className="text-foreground">{c.name}</b>{t('body_mid')}
              <b className="text-foreground">{t('body_strong')}</b>{t('body_post')}
            </p>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label={t('metric_provider')} value={c.provider_type} />
              <Metric label={t('metric_keys')} value={`${c.keys_active ?? 0}/${c.keys_total ?? 0}${t('metric_keys_active_suffix')}`} />
              <Metric
                label={t('metric_balance')}
                value={loading ? t('metric_balance_loading') : fmtCents(balance)}
                warn={lowBalance}
              />
              <Metric
                label={t('metric_health')}
                value={
                  testOk ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" />
                      {lastTest?.latency_ms ? `${lastTest.latency_ms}ms` : t('metric_health_online')}
                    </span>
                  ) : testBad ? (
                    <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
                      <XCircle className="w-3 h-3" />
                      {lastTest ? formatTestError(lastTest, tChannels) : t('metric_health_unreachable')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('metric_health_untested')}</span>
                  )
                }
              />
            </div>
            {lowBalance && (
              <div
                className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/40 text-sm text-amber-700 dark:text-amber-400"
                data-tour="channel-hero-low-balance"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {t('low_balance_pre')}
                <Link href="/admin/wholesale" className="underline font-medium">
                  {t('low_balance_link')}
                </Link>
                {t('low_balance_post')}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/admin/wholesale">
                <Wallet className="w-4 h-4" />
                {t('cta_topup')}
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!onTest || testing === c.id}
            >
              {testing === c.id ? t('cta_test_busy') : t('cta_test')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  warn,
}: {
  label: string;
  value: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-sm font-medium',
          warn ? 'text-amber-700 dark:text-amber-400' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}
