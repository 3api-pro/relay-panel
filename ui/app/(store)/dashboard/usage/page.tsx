'use client';
import { useEffect, useMemo, useState } from 'react';
import { store, fmtCents, fmtDate, fmtTokens } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, StatTile, Alert, Spinner } from '@/components/store/ui';
import { UsageChart, UsagePoint } from '@/components/store/UsageChart';

export default function UsagePage() {
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">控制台</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <UsageInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function UsageInner() {
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    store.usage(period)
      .then(setData)
      .catch((e) => setErr(e?.message || '加载失败'));
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
        <span className="text-muted-foreground">区间:</span>
        {(['7d', '30d'] as const).map((p) => (
          <button key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-md border ${period === p ? 'bg-foreground text-white border-slate-900' : 'bg-card border-input text-muted-foreground hover:bg-background'}`}>
            {p === '7d' ? '近 7 天' : '近 30 天'}
          </button>
        ))}
      </div>

      {err && <Alert kind="error">{err}</Alert>}

      {data === null && !err && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner /> <span className="ml-2 text-sm">加载中…</span>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile label="Tokens" value={fmtTokens(totals.tokens)} sub={`${totals.tokens.toLocaleString()} 精确值`} />
            <StatTile label="请求数" value={totals.requests.toLocaleString()} />
            <StatTile label="累计费用" value={fmtCents(totals.costCents)} sub={period === '7d' ? '近 7 天' : '近 30 天'} />
          </div>

          <Card title="每日使用">
            <UsageChart data={series} />
          </Card>

          <Card title="最近请求">
            {recent.length === 0 ? (
              <div className="py-6 text-center text-muted-foreground text-sm">暂无请求记录。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-2 pr-3 font-medium">时间</th>
                      <th className="pr-3 font-medium">模型</th>
                      <th className="pr-3 font-medium">Tokens</th>
                      <th className="pr-3 font-medium">费用</th>
                      <th className="font-medium">状态</th>
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
