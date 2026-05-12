'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { store, fmtCents, fmtDate, fmtDateShort, fmtTokens } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Alert, Spinner, Badge } from '@/components/store/ui';

export default function BillingPage() {
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">控制台</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <BillingInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function BillingInner() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const [sub, setSub] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const o = await store.listOrders();
      setOrders((o as any).data || []);
    } catch (e: any) {
      if (e?.status === 404) setOrders([]); else setErr(e?.message || '加载失败');
    }
    try {
      const s = await store.subscriptions();
      setSub(s);
    } catch {
      setSub(null);
    }
  }

  useEffect(() => { refresh(); }, []);

  const active = sub?.subscription || sub?.data || sub;
  const planName = active?.plan_name || active?.plan?.name;
  const quotaUsed = Number(active?.quota_used_tokens || active?.used_tokens || 0);
  const quotaTotal = Number(active?.quota_tokens || active?.plan?.quota_tokens || 0);
  const usePct = quotaTotal > 0 ? Math.min(100, Math.round(quotaUsed * 100 / quotaTotal)) : 0;
  const renew = active?.current_period_end || active?.expires_at || active?.renew_at;

  return (
    <div className="space-y-4">
      {err && <Alert kind="error">{err}</Alert>}

      <Card title="当前订阅"
        action={<Link href="/pricing"><Button size="sm">升级 / 续费</Button></Link>}>
        {!active ? (
          <div className="text-sm text-muted-foreground">
            尚未订阅任何套餐 — <Link href="/pricing" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>查看套餐</Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-foreground">{planName || '订阅中'}</div>
                <div className="text-xs text-muted-foreground">到期: {fmtDateShort(renew)}</div>
              </div>
              <Badge tone={active.status === 'active' ? 'success' : 'neutral'}>{active.status || 'active'}</Badge>
            </div>
            {quotaTotal > 0 && (
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>已用 {fmtTokens(quotaUsed)} / {fmtTokens(quotaTotal)} tokens</span>
                  <span>{usePct}%</span>
                </div>
                <div className="h-2 bg-muted rounded overflow-hidden">
                  <div className="h-full rounded"
                    style={{ width: `${usePct}%`, background: 'var(--brand-primary, #0e9486)' }} />
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="订单历史">
        {orders === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">加载中…</span>
          </div>
        ) : orders.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-sm">还没有订单。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="py-2 pr-3 font-medium">订单号</th>
                  <th className="pr-3 font-medium">套餐</th>
                  <th className="pr-3 font-medium">金额</th>
                  <th className="pr-3 font-medium">状态</th>
                  <th className="pr-3 font-medium">创建</th>
                  <th className="font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-border/50">
                    <td className="py-2 pr-3 font-mono text-xs">{String(o.id).slice(0, 12)}…</td>
                    <td className="pr-3">{o.plan_name || o.plan_slug || `#${o.plan_id}`}</td>
                    <td className="pr-3">{fmtCents(o.amount_cents)}</td>
                    <td className="pr-3">
                      <Badge tone={o.status === 'paid' ? 'success' : o.status === 'pending' ? 'warn' : o.status === 'expired' || o.status === 'canceled' ? 'neutral' : 'neutral'}>
                        {o.status || '—'}
                      </Badge>
                    </td>
                    <td className="pr-3 text-muted-foreground">{fmtDate(o.created_at)}</td>
                    <td>
                      {o.status === 'pending' ? (
                        <Link href={`/checkout/${o.id}`} className="hover:underline text-xs" style={{ color: 'var(--brand-primary, #0e9486)' }}>去支付</Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="充值 Token Pack">
        <div className="text-sm text-muted-foreground">
          额外 token 包即将上线。当前请通过续费或升级套餐补充额度。
        </div>
      </Card>
    </div>
  );
}
