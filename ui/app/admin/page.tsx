'use client';
import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatCard } from '@/components/admin/StatCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { OnboardingTour } from '@/components/OnboardingTour';

interface StatsSeries { date: string; cents?: number; value?: number }
interface Stats {
  revenue_today_cents: number;
  active_subscriptions: number;
  tokens_today: number;
  wholesale_balance_cents: number;
  revenue_series?: StatsSeries[];
  subscription_series?: StatsSeries[];
  tokens_series?: StatsSeries[];
  wholesale_series?: StatsSeries[];
}

interface Order {
  id: number;
  user_email?: string;
  plan_name?: string;
  amount_cents: number;
  pay_method?: string;
  status: string;
  created_at: string;
}

const LOW_WHOLESALE_THRESHOLD = 5000; // cents

function seriesValues(s?: StatsSeries[]): number[] {
  if (!s || s.length === 0) return [];
  return s.map((p) => (p.cents ?? p.value ?? 0));
}

export default function AdminHome() {
  // Read ?tour=1 from window.location to avoid useSearchParams + Suspense.
  const [startTour, setStartTour] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('tour') === '1') setStartTour(true);
    } catch {}
  }, []);

  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);

  /* ---- stats: auto-refreshing every 30 s (visibility-aware) ---- */
  const { data: stats, loading: statsLoading } = useAutoRefresh<Stats>(async () => {
    const [s, w] = await Promise.all([
      safe(api<Stats>(`/admin/stats?period=${period}`), {
        revenue_today_cents: 0,
        active_subscriptions: 0,
        tokens_today: 0,
        wholesale_balance_cents: 0,
        revenue_series: [],
      } as Stats),
      safe(api<{ balance_cents: number }>('/admin/wholesale'), { balance_cents: 0 }),
    ]);
    return { ...s, wholesale_balance_cents: w.balance_cents ?? s.wholesale_balance_cents };
  }, { intervalMs: 30_000 });

  /* ---- orders: one-shot on mount/period change (no polling) ---- */
  useEffect(() => {
    setOrdersLoading(true);
    safe(api<{ data: Order[] }>('/admin/orders?limit=10'), { data: [] })
      .then((o) => setOrders(o.data || []))
      .finally(() => setOrdersLoading(false));
  }, [period]);

  const loading = statsLoading || ordersLoading;

  const lowBalance = stats != null && stats.wholesale_balance_cents < LOW_WHOLESALE_THRESHOLD;

  const revenueData = useMemo(() => seriesValues(stats?.revenue_series),     [stats]);
  const subData     = useMemo(() => seriesValues(stats?.subscription_series),[stats]);
  const tokData     = useMemo(() => seriesValues(stats?.tokens_series),      [stats]);
  const wholData    = useMemo(() => seriesValues(stats?.wholesale_series),   [stats]);

  return (
    <AdminShell title="总览" subtitle="今日营收 / 用户活跃 / 上游余额一览">
      <OnboardingTour autoStart={startTour} force={startTour} />
      {lowBalance && (
        <div className="mb-5 rounded-md bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 flex items-center justify-between">
          <span>⚠️ wholesale 余额低于 {fmtCNY(LOW_WHOLESALE_THRESHOLD)}（当前 {fmtCNY(stats!.wholesale_balance_cents)}），建议尽快充值避免用户付款后无法供给。</span>
          <a href="/admin/finance" className="underline ml-4">去充值</a>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="今日收入"
          value={fmtCNY(stats?.revenue_today_cents ?? 0)}
          data={revenueData}
          hint="实时"
        />
        <StatCard
          label="活跃订阅"
          value={stats?.active_subscriptions ?? 0}
          data={subData}
          hint="未到期 + 未取消"
        />
        <StatCard
          label="今日 Token 消耗"
          value={(stats?.tokens_today ?? 0).toLocaleString()}
          data={tokData}
          hint="input + output"
        />
        <StatCard
          label="上游余额"
          value={fmtCNY(stats?.wholesale_balance_cents ?? 0)}
          data={wholData}
          hint={lowBalance ? '余额偏低' : '正常'}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>收入趋势</CardTitle>
            <div className="flex gap-1">
              {(['7d', '30d'] as const).map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={period === p ? 'default' : 'secondary'}
                  onClick={() => setPeriod(p)}
                  className="h-7 px-3 text-xs"
                >
                  {p === '7d' ? '7 天' : '30 天'}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <RevenueChart series={stats?.revenue_series ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle>最近订单</CardTitle></CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>
            ) : orders.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">暂无订单</div>
            ) : (
              <ul className="space-y-2">
                {orders.slice(0, 10).map((o) => (
                  <li key={o.id} className="flex items-start justify-between text-sm border-b border-border/50 pb-2 last:border-b-0">
                    <div className="min-w-0">
                      <div className="text-foreground truncate">{o.user_email ?? `#${o.id}`}</div>
                      <div className="text-xs text-muted-foreground">{o.plan_name ?? '—'} · {fmtDate(o.created_at)}</div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <div className="font-medium">{fmtCNY(o.amount_cents)}</div>
                      <div className="text-xs text-muted-foreground">{o.status}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

/** Theme-aware pure-SVG line chart. */
function RevenueChart({ series }: { series: StatsSeries[] }) {
  if (!series || series.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-muted-foreground bg-muted/50 rounded-md">
        暂无数据（待 /admin/stats 接口上线）
      </div>
    );
  }
  const w = 600, h = 180, pad = 24;
  const values = series.map((p) => p.cents ?? p.value ?? 0);
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return { x, y };
  });
  const path = pts.map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${pts[pts.length - 1].x.toFixed(1)} ${(h - pad).toFixed(1)} L ${pad.toFixed(1)} ${(h - pad).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48 text-primary">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} className="stroke-border" />
      <line x1={pad} y1={pad}     x2={pad}     y2={h - pad} className="stroke-border" />
      <path d={area} fill="currentColor" opacity={0.10} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
      {pts.map((q, i) => (
        <circle key={i} cx={q.x} cy={q.y} r={2.5} fill="currentColor" />
      ))}
    </svg>
  );
}
