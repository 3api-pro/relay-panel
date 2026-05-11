'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatCard } from '@/components/admin/StatCard';
import { DataTable, Column } from '@/components/admin/DataTable';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

interface Stats {
  revenue_today_cents: number;
  active_subscriptions: number;
  tokens_today: number;
  wholesale_balance_cents: number;
  revenue_series?: { date: string; cents: number }[];
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

export default function AdminHome() {
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      safe(api<Stats>(`/admin/stats?period=${period}`), {
        revenue_today_cents: 0,
        active_subscriptions: 0,
        tokens_today: 0,
        wholesale_balance_cents: 0,
        revenue_series: [],
      } as Stats),
      safe(api<{ balance_cents: number }>('/admin/wholesale'), { balance_cents: 0 }),
      safe(api<{ data: Order[] }>('/admin/orders?limit=10'), { data: [] }),
    ]).then(([s, w, o]) => {
      // merge real wholesale balance if /admin/stats hasn't filled it
      setStats({ ...s, wholesale_balance_cents: w.balance_cents ?? s.wholesale_balance_cents });
      setOrders(o.data || []);
      setLoading(false);
    });
  }, [period]);

  const lowBalance =
    stats != null && stats.wholesale_balance_cents < LOW_WHOLESALE_THRESHOLD;

  return (
    <AdminShell title="总览" subtitle="今日营收 / 用户活跃 / 上游余额一览">
      {lowBalance && (
        <div className="mb-5 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-center justify-between">
          <span>⚠️ wholesale 余额低于 {fmtCNY(LOW_WHOLESALE_THRESHOLD)}（当前 {fmtCNY(stats!.wholesale_balance_cents)}），建议尽快充值避免用户付款后无法供给。</span>
          <a href="/admin/finance" className="text-amber-900 underline ml-4">去充值</a>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="今日收入"
          value={fmtCNY(stats?.revenue_today_cents ?? 0)}
          hint="实时"
        />
        <StatCard
          label="活跃订阅"
          value={stats?.active_subscriptions ?? 0}
          hint="未到期 + 未取消"
        />
        <StatCard
          label="今日 Token 消耗"
          value={(stats?.tokens_today ?? 0).toLocaleString()}
          hint="input + output"
        />
        <StatCard
          label="上游余额"
          value={fmtCNY(stats?.wholesale_balance_cents ?? 0)}
          hint={lowBalance ? '余额偏低' : '正常'}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-4">
        <section className="xl:col-span-2 bg-white rounded-lg border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">收入趋势</h2>
            <div className="flex gap-1 text-xs">
              {(['7d', '30d'] as const).map((p) => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={
                    'px-2.5 py-1 rounded-md ' +
                    (period === p
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                  }>
                  {p === '7d' ? '7 天' : '30 天'}
                </button>
              ))}
            </div>
          </div>
          <RevenueChart series={stats?.revenue_series ?? []} />
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-4">最近订单</h2>
          {loading ? (
            <div className="text-sm text-slate-400 py-8 text-center">加载中…</div>
          ) : orders.length === 0 ? (
            <div className="text-sm text-slate-400 py-8 text-center">暂无订单</div>
          ) : (
            <ul className="space-y-2">
              {orders.slice(0, 10).map((o) => (
                <li key={o.id} className="flex items-start justify-between text-sm border-b border-slate-100 pb-2 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-slate-800 truncate">{o.user_email ?? `#${o.id}`}</div>
                    <div className="text-xs text-slate-500">{o.plan_name ?? '—'} · {fmtDate(o.created_at)}</div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="font-medium">{fmtCNY(o.amount_cents)}</div>
                    <div className="text-xs text-slate-500">{o.status}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

/* Pure-SVG line chart so we stay zero-dep. */
function RevenueChart({ series }: { series: { date: string; cents: number }[] }) {
  if (!series || series.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-slate-400 bg-slate-50/50 rounded-md">
        暂无数据（待 /admin/stats 接口上线）
      </div>
    );
  }
  const w = 600;
  const h = 180;
  const pad = 24;
  const max = Math.max(1, ...series.map((p) => p.cents));
  const pts = series.map((p, i) => {
    const x = pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
    const y = h - pad - (p.cents / max) * (h - pad * 2);
    return { x, y, p };
  });
  const path = pts.map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e2e8f0" />
      <line x1={pad} y1={pad}     x2={pad}     y2={h - pad} stroke="#e2e8f0" />
      <path d={path} fill="none" stroke="#0e9486" strokeWidth={2} />
      {pts.map((q, i) => (
        <circle key={i} cx={q.x} cy={q.y} r={3} fill="#0e9486" />
      ))}
    </svg>
  );
}
