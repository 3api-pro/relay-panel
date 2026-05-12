'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { store, fmtCents, fmtDate, fmtDateShort, fmtTokens } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Alert, Spinner, Badge } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

export default function BillingPage() {
  const t = useTranslations('storefront.billing');
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">{t('title')}</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <BillingInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function BillingInner() {
  const t = useTranslations('storefront.billing');
  const [orders, setOrders] = useState<any[] | null>(null);
  const [sub, setSub] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const o = await store.listOrders();
      setOrders((o as any).data || []);
    } catch (e: any) {
      if (e?.status === 404) setOrders([]); else setErr(e?.message || t('load_failed'));
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

      <Card title={t('card_current_sub')}
        action={<Link href="/pricing"><Button size="sm">{t('cta_upgrade')}</Button></Link>}>
        {!active ? (
          <div className="text-sm text-muted-foreground">
            {t('no_sub_prefix')}<Link href="/pricing" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('view_plans_link')}</Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-foreground">{planName || t('subscribing')}</div>
                <div className="text-xs text-muted-foreground">{t('expires_label')}{fmtDateShort(renew)}</div>
              </div>
              <Badge tone={active.status === 'active' ? 'success' : 'neutral'}>{active.status || t('active_default')}</Badge>
            </div>
            {quotaTotal > 0 && (
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>{t('quota_used_pre')}{fmtTokens(quotaUsed)}{t('quota_used_mid')}{fmtTokens(quotaTotal)}{t('quota_used_post')}</span>
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

      <Card title={t('card_order_history')}>
        {orders === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">{t('loading_inline')}</span>
          </div>
        ) : orders.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-sm">{t('no_orders')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t('th_order_id')}</th>
                  <th className="pr-3 font-medium">{t('th_plan')}</th>
                  <th className="pr-3 font-medium">{t('th_amount')}</th>
                  <th className="pr-3 font-medium">{t('th_status')}</th>
                  <th className="pr-3 font-medium">{t('th_created')}</th>
                  <th className="font-medium">{t('th_actions')}</th>
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
                        <Link href={`/checkout/${o.id}`} className="hover:underline text-xs" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('pay_link')}</Link>
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

      <Card title={t('card_token_pack')}>
        <div className="text-sm text-muted-foreground">
          {t('token_pack_pending')}
        </div>
      </Card>
    </div>
  );
}
