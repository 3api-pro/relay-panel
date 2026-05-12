'use client';
/**
 * Checkout page.
 *
 * NOTE: with Next.js `output: 'export'` we cannot prerender dynamic
 * route segments at unknown orderIds. So we use a query-string param
 * instead — links elsewhere should use `/checkout?order=<id>`.
 * useSearchParams() requires a Suspense boundary under static export.
 */
import { Suspense, useEffect, useMemo, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { store, fmtCents, fmtDate, StoreApiError } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { Card, Button, Alert, Badge, Spinner } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

type Provider = 'alipay' | 'usdt-trc20' | 'usdt-erc20';

function CheckoutFallback() {
  const t = useTranslations('storefront.checkout');
  return (
    <div className="min-h-[60vh] flex items-center justify-center text-muted-foreground text-sm">{t('loading_inline')}</div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<CheckoutFallback />}>
      <AuthGuard>
        <CheckoutInner />
      </AuthGuard>
    </Suspense>
  );
}

function CheckoutInner() {
  const t = useTranslations('storefront.checkout');
  const router = useRouter();
  const sp = useSearchParams();
  const orderId = sp?.get('order') || sp?.get('orderId') || '';
  const [order, setOrder] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [payInfo, setPayInfo] = useState<any | null>(null);
  const [providerOffline, setProviderOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!orderId) return;
    refresh();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function refresh() {
    if (!orderId) return;
    try {
      const o = await store.getOrder(orderId);
      setOrder(o);
      if ((o as any).status === 'paid') {
        if (pollRef.current) window.clearInterval(pollRef.current);
        setTimeout(() => router.push('/dashboard/billing'), 1500);
      }
    } catch (e: any) {
      setErr(e?.message || t('load_order_failed'));
    }
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(refresh, 3000);
  }

  async function selectProvider(p: Provider) {
    setProvider(p);
    setBusy(true); setErr(null); setPayInfo(null); setProviderOffline(false);
    try {
      if (p === 'alipay') {
        const r: any = await store.payAlipay(orderId);
        setPayInfo({ kind: 'alipay', ...r });
      } else {
        const net = p === 'usdt-trc20' ? 'trc20' : 'erc20';
        const r: any = await store.payUsdtCreate(orderId, net);
        setPayInfo({ kind: 'usdt', network: net, ...r });
      }
      startPolling();
    } catch (e: any) {
      if (e instanceof StoreApiError && e.status === 404) {
        setProviderOffline(true);
      } else {
        setErr(e?.message || t('channel_error'));
      }
    } finally {
      setBusy(false);
    }
  }

  const expiresMs = useMemo(() => {
    if (!order?.expires_at) return null;
    const ts = new Date(order.expires_at).getTime();
    return isNaN(ts) ? null : ts;
  }, [order?.expires_at]);
  const remaining = expiresMs ? Math.max(0, expiresMs - now) : null;
  const remStr = remaining === null ? null : `${Math.floor(remaining / 60000)}:${String(Math.floor(remaining / 1000) % 60).padStart(2, '0')}`;
  const expired = remaining !== null && remaining <= 0;
  const paid = order?.status === 'paid';

  if (!orderId) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <Alert kind="error">{t('missing_order_pre')}<Link href="/dashboard/billing" className="underline">{t('missing_order_link')}</Link>{t('missing_order_post')}</Alert>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <h1 className="text-2xl font-semibold text-foreground mb-6">{t('title')}</h1>

      {err && <Alert kind="error">{err}</Alert>}

      {!order && !err && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Spinner /> <span className="ml-2 text-sm">{t('loading_order')}</span>
        </div>
      )}

      {order && (
        <>
          <Card title={t('card_order_detail')}>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('row_order_id')}</dt>
                <dd className="font-mono text-xs">{order.id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('row_plan')}</dt>
                <dd>{order.plan_name || order.plan_slug || `#${order.plan_id}`}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('row_amount')}</dt>
                <dd className="text-lg font-semibold">{fmtCents(order.amount_cents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('row_status')}</dt>
                <dd><Badge tone={paid ? 'success' : expired ? 'danger' : 'warn'}>{paid ? t('status_paid') : expired ? t('status_expired') : order.status || t('status_pending')}</Badge></dd>
              </div>
              {order.expires_at && !paid && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('row_expires')}</dt>
                  <dd className="text-foreground">{fmtDate(order.expires_at)} {remStr && !expired && <span className="ml-2 text-amber-600">{t('remaining_prefix')}{remStr}</span>}</dd>
                </div>
              )}
            </dl>
          </Card>

          {paid && (
            <div className="mt-4">
              <Alert kind="success">
                <div className="font-medium">{t('alert_paid_title')}</div>
                <div className="text-sm mt-1">{t('alert_paid_body')}</div>
              </Alert>
            </div>
          )}

          {!paid && !expired && (
            <Card title={t('card_method_title')} className="mt-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(['alipay', 'usdt-trc20', 'usdt-erc20'] as Provider[]).map((p) => (
                  <button key={p} disabled={busy}
                    onClick={() => selectProvider(p)}
                    className={`text-left rounded-lg border p-4 hover:bg-background disabled:opacity-50 ${provider === p ? 'border-slate-900' : 'border-border'}`}>
                    <div className="font-medium text-foreground">
                      {p === 'alipay' ? t('method_alipay') : p === 'usdt-trc20' ? t('method_usdt_trc20') : t('method_usdt_erc20')}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {p === 'alipay' ? t('method_alipay_desc') : t('method_usdt_desc')}
                    </div>
                  </button>
                ))}
              </div>

              {busy && (
                <div className="mt-4 flex items-center text-muted-foreground text-sm">
                  <Spinner /> <span className="ml-2">{t('generating')}</span>
                </div>
              )}

              {providerOffline && (
                <div className="mt-4">
                  <Alert kind="warn">
                    {t('provider_offline_pre')}<Link href="/dashboard/billing" className="underline">{t('provider_offline_link')}</Link>{t('provider_offline_post')}
                  </Alert>
                </div>
              )}

              {payInfo?.kind === 'alipay' && payInfo.qr_code_url && (
                <div className="mt-4">
                  <Alert kind="info">{t('alipay_alert')}</Alert>
                  <div className="mt-3 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={payInfo.qr_code_url} alt={t('alipay_qr_alt')} className="w-56 h-56 border border-border rounded-md" />
                  </div>
                </div>
              )}

              {payInfo?.kind === 'usdt' && (
                <div className="mt-4 space-y-2">
                  <Alert kind="info">{t('usdt_alert')}</Alert>
                  <div className="bg-background border border-border rounded p-3 text-sm space-y-1">
                    <div><span className="text-muted-foreground">{t('row_network')}</span> {String(payInfo.network).toUpperCase()}</div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{t('row_address')}</span>
                      <code className="text-xs break-all flex-1">{payInfo.address}</code>
                      <Button size="sm" variant="ghost"
                        onClick={() => { if (navigator?.clipboard && payInfo.address) navigator.clipboard.writeText(payInfo.address).catch(() => {}); }}>
                        {t('copy')}
                      </Button>
                    </div>
                    <div><span className="text-muted-foreground">{t('row_usdt_amount')}</span> {payInfo.amount} USDT</div>
                    {payInfo.expires_at && <div><span className="text-muted-foreground">{t('row_usdt_expires')}</span> {fmtDate(payInfo.expires_at)}</div>}
                  </div>
                </div>
              )}
            </Card>
          )}

          {expired && !paid && (
            <div className="mt-4">
              <Alert kind="error">
                <div className="font-medium">{t('expired_title')}</div>
                <div className="text-sm mt-1">
                  {t('expired_pre')}<Link href="/pricing" className="underline">{t('expired_link')}</Link>{t('expired_post')}
                </div>
              </Alert>
            </div>
          )}
        </>
      )}
    </div>
  );
}
