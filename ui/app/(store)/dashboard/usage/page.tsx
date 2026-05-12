'use client';
import { useEffect, useMemo, useState } from 'react';
import { store, fmtCents, fmtDate, fmtTokens } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, StatTile, Alert, Spinner } from '@/components/store/ui';
import { UsageChart, UsagePoint } from '@/components/store/UsageChart';
import { useTranslations } from '@/lib/i18n';

export default function UsagePage() {
  const t = useTranslations('storefront.usage');
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">{t('title')}</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <UsageInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function UsageInner() {
  const t = useTranslations('storefront.usage');
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    store.usage(period)
      .then(setData)
      .catch((e) => setErr(e?.message || t('load_failed')));
  }, [period]);

  const series: UsagePoint[] = useMemo(() => {
    if (!data) return [];
    const raw = data.daily || data.data || data.series || [];
    return raw.map((d: any) => ({
      date: String(d.date || d.day || d.bucket || ''),
      tokens: Number(d.tokens || d.total_tokens || 0),
      requests: Number(d.requests || d.count || 0),
    })).filter((d: UsagePoint) => d.date);
  }, [data]);

  const totals = useMemo(() => {
    if (!data) return { tokens: 0, requests: 0, costCents: 0 };
    return {
      tokens: Number(data.totals?.tokens ?? series.reduce((s, d) => s + d.tokens, 0)),
      requests: Number(data.totals?.requests ?? series.reduce((s, d) => s + (d.requests || 0), 0)),
      costCents: Number(data.totals?.cost_cents ?? 0),
    };
  }, [data, series]);

  const recent: any[] = data?.recent || data?.logs || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('period_label')}</span>
        {(['7d', '30d'] as const).map((p) => (
          <button key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-md border ${period === p ? 'bg-foreground text-white border-slate-900' : 'bg-card border-input text-muted-foreground hover:bg-background'}`}>
            {p === '7d' ? t('period_7d') : t('period_30d')}
          </button>
        ))}
      </div>

      {err && <Alert kind="error">{err}</Alert>}

      {data === null && !err && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner /> <span className="ml-2 text-sm">{t('loading_inline')}</span>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile label={t('stat_tokens')} value={fmtTokens(totals.tokens)} sub={`${totals.tokens.toLocaleString()}${t('stat_tokens_exact_suffix')}`} />
            <StatTile label={t('stat_requests')} value={totals.requests.toLocaleString()} />
            <StatTile label={t('stat_cost')} value={fmtCents(totals.costCents)} sub={period === '7d' ? t('period_7d') : t('period_30d')} />
          </div>

          <Card title={t('card_daily')}>
            <UsageChart data={series} />
          </Card>

          <Card title={t('card_recent')}>
            {recent.length === 0 ? (
              <div className="py-6 text-center text-muted-foreground text-sm">{t('no_recent')}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t('th_time')}</th>
                      <th className="pr-3 font-medium">{t('th_model')}</th>
                      <th className="pr-3 font-medium">{t('th_tokens')}</th>
                      <th className="pr-3 font-medium">{t('th_cost')}</th>
                      <th className="font-medium">{t('th_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.slice(0, 50).map((r: any, i: number) => (
                      <tr key={r.id || i} className="border-b border-border/50">
                        <td className="py-2 pr-3 text-muted-foreground">{fmtDate(r.ts || r.created_at)}</td>
                        <td className="pr-3 text-foreground">{r.model || '—'}</td>
                        <td className="pr-3">{Number(r.tokens || r.total_tokens || 0).toLocaleString()}</td>
                        <td className="pr-3">{fmtCents(r.cost_cents)}</td>
                        <td>
                          <span className={`text-xs px-2 py-0.5 rounded ${r.status === 'ok' || r.status === 200 ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>
                            {r.status || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
