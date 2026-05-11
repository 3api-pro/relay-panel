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

type Provider = 'alipay' | 'usdt-trc20' | 'usdt-erc20';

export default function CheckoutPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh] flex items-center justify-center text-slate-400 text-sm">加载中…</div>}>
      <AuthGuard>
        <CheckoutInner />
      </AuthGuard>
    </Suspense>
  );
}

function CheckoutInner() {
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
      setErr(e?.message || '加载订单失败');
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
        setErr(e?.message || '支付通道异常');
      }
    } finally {
      setBusy(false);
    }
  }

  const expiresMs = useMemo(() => {
    if (!order?.expires_at) return null;
    const t = new Date(order.expires_at).getTime();
    return isNaN(t) ? null : t;
  }, [order?.expires_at]);
  const remaining = expiresMs ? Math.max(0, expiresMs - now) : null;
  const remStr = remaining === null ? null : `${Math.floor(remaining / 60000)}:${String(Math.floor(remaining / 1000) % 60).padStart(2, '0')}`;
  const expired = remaining !== null && remaining <= 0;
  const paid = order?.status === 'paid';

  if (!orderId) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <Alert kind="error">缺少订单参数。请从 <Link href="/dashboard/billing" className="underline">订单列表</Link> 进入。</Alert>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">结账</h1>

      {err && <Alert kind="error">{err}</Alert>}

      {!order && !err && (
        <div className="flex items-center justify-center py-12 text-slate-400">
          <Spinner /> <span className="ml-2 text-sm">加载订单…</span>
        </div>
      )}

      {order && (
        <>
          <Card title="订单详情">
            <dl className="text-sm space-y-2">
              <div className="flex justify-between">
                <dt className="text-slate-500">订单号</dt>
                <dd className="font-mono text-xs">{order.id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">套餐</dt>
                <dd>{order.plan_name || order.plan_slug || `#${order.plan_id}`}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">金额</dt>
                <dd className="text-lg font-semibold">{fmtCents(order.amount_cents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">状态</dt>
                <dd><Badge tone={paid ? 'success' : expired ? 'danger' : 'warn'}>{paid ? '已支付' : expired ? '已过期' : order.status || '待支付'}</Badge></dd>
              </div>
              {order.expires_at && !paid && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">截止</dt>
                  <dd className="text-slate-700">{fmtDate(order.expires_at)} {remStr && !expired && <span className="ml-2 text-amber-600">剩余 {remStr}</span>}</dd>
                </div>
              )}
            </dl>
          </Card>

          {paid && (
            <div className="mt-4">
              <Alert kind="success">
                <div className="font-medium">支付成功!</div>
                <div className="text-sm mt-1">即将跳转账单页…</div>
              </Alert>
            </div>
          )}

          {!paid && !expired && (
            <Card title="选择支付方式" className="mt-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(['alipay', 'usdt-trc20', 'usdt-erc20'] as Provider[]).map((p) => (
                  <button key={p} disabled={busy}
                    onClick={() => selectProvider(p)}
                    className={`text-left rounded-lg border p-4 hover:bg-slate-50 disabled:opacity-50 ${provider === p ? 'border-slate-900' : 'border-slate-200'}`}>
                    <div className="font-medium text-slate-900">
                      {p === 'alipay' ? '支付宝' : p === 'usdt-trc20' ? 'USDT (TRC20)' : 'USDT (ERC20)'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {p === 'alipay' ? '扫码即时到账' : 'Tether USD, 链上转账'}
                    </div>
                  </button>
                ))}
              </div>

              {busy && (
                <div className="mt-4 flex items-center text-slate-400 text-sm">
                  <Spinner /> <span className="ml-2">生成支付凭证…</span>
                </div>
              )}

              {providerOffline && (
                <div className="mt-4">
                  <Alert kind="warn">
                    支付通道开通中, 暂时无法在线支付。订单已为你保留, 可联系客服线下支付,
                    或稍后回到 <Link href="/dashboard/billing" className="underline">订单列表</Link> 重试。
                  </Alert>
                </div>
              )}

              {payInfo?.kind === 'alipay' && payInfo.qr_code_url && (
                <div className="mt-4">
                  <Alert kind="info">使用支付宝扫码完成支付。本页面会自动检测到账状态。</Alert>
                  <div className="mt-3 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={payInfo.qr_code_url} alt="支付二维码" className="w-56 h-56 border border-slate-200 rounded-md" />
                  </div>
                </div>
              )}

              {payInfo?.kind === 'usdt' && (
                <div className="mt-4 space-y-2">
                  <Alert kind="info">向以下地址转账 USDT, 转账完成后页面会自动确认。</Alert>
                  <div className="bg-slate-50 border border-slate-200 rounded p-3 text-sm space-y-1">
                    <div><span className="text-slate-500">网络:</span> {String(payInfo.network).toUpperCase()}</div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">地址:</span>
                      <code className="text-xs break-all flex-1">{payInfo.address}</code>
                      <Button size="sm" variant="ghost"
                        onClick={() => { if (navigator?.clipboard && payInfo.address) navigator.clipboard.writeText(payInfo.address).catch(() => {}); }}>
                        复制
                      </Button>
                    </div>
                    <div><span className="text-slate-500">金额:</span> {payInfo.amount} USDT</div>
                    {payInfo.expires_at && <div><span className="text-slate-500">到期:</span> {fmtDate(payInfo.expires_at)}</div>}
                  </div>
                </div>
              )}
            </Card>
          )}

          {expired && !paid && (
            <div className="mt-4">
              <Alert kind="error">
                <div className="font-medium">订单已过期</div>
                <div className="text-sm mt-1">
                  请 <Link href="/pricing" className="underline">重新下单</Link>。
                </div>
              </Alert>
            </div>
          )}
        </>
      )}
    </div>
  );
}
