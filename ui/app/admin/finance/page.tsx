'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTable, Column } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Wholesale {
  balance_cents: number;
  updated_at: string | null;
  history?: TopupRow[];
}

interface TopupRow {
  id: number;
  amount_cents: number;
  pay_method?: string;
  ref?: string;
  status?: string;
  created_at: string;
}

interface PlanRevenue {
  plan_name: string;
  orders: number;
  revenue_cents: number;
}

export default function FinancePage() {
  const t = useTranslations('admin.finance');
  const tCommon = useTranslations('common');
  const [ws, setWs] = useState<Wholesale | null>(null);
  const [planRev, setPlanRev] = useState<PlanRevenue[]>([]);
  const [topupOpen, setTopupOpen] = useState(false);
  const [amount, setAmount] = useState('50000'); // ¥500
  const [method, setMethod] = useState<'alipay' | 'usdt'>('alipay');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [w, p] = await Promise.all([
      safe(api<Wholesale>('/admin/wholesale'), { balance_cents: 0, updated_at: null, history: [] }),
      safe(api<{ data: PlanRevenue[] }>('/admin/stats?period=30d&group=plan'), { data: [] }),
    ]);
    setWs(w);
    setPlanRev(p.data || []);
  }
  useEffect(() => { refresh(); }, []);

  async function topup() {
    setBusy(true);
    try {
      await api('/admin/wholesale/topup', {
        method: 'POST',
        body: JSON.stringify({ amount_cents: Number(amount), pay_method: method }),
      });
      setTopupOpen(false);
      refresh();
    } catch (e: any) {
      alert(`${t('topup_failed_prefix')}${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const lowBalance = (ws?.balance_cents ?? 0) < 5000;

  const topupCols: Column<TopupRow>[] = [
    { key: 'id', header: t('col_id'), render: (r) => <span className="font-mono text-xs text-muted-foreground">#{r.id}</span> },
    { key: 'amount', header: t('col_amount'), render: (r) => (
      <span className={r.amount_cents >= 0 ? 'text-emerald-700 font-medium' : 'text-rose-600 font-medium'}>
        {r.amount_cents >= 0 ? '+' : ''}{fmtCNY(r.amount_cents)}
      </span>
    ) },
    { key: 'method', header: t('col_method'), render: (r) => <span className="text-xs">{r.pay_method ?? '—'}</span> },
    { key: 'ref', header: t('col_ref'), render: (r) => <span className="text-xs font-mono text-muted-foreground">{r.ref ?? '—'}</span> },
    { key: 'status', header: t('col_status'), render: (r) => <span className="text-xs">{r.status ?? '—'}</span> },
    { key: 'time', header: t('col_time'), render: (r) => <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span> },
  ];

  const planCols: Column<PlanRevenue>[] = [
    { key: 'plan', header: t('col_plan'), render: (p) => <span className="text-foreground">{p.plan_name}</span> },
    { key: 'orders', header: t('col_orders'), render: (p) => p.orders },
    { key: 'rev', header: t('col_revenue'), render: (p) => <span className="font-medium">{fmtCNY(p.revenue_cents)}</span> },
  ];

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <section className="lg:col-span-2 bg-card rounded-lg border border-border p-6">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('wholesale_label')}</div>
          <div className={
            'text-4xl font-bold mt-2 ' +
            (lowBalance ? 'text-rose-600' : 'text-foreground')
          }>
            {fmtCNY(ws?.balance_cents ?? 0)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">{t('updated_at_prefix')}{fmtDate(ws?.updated_at ?? null)}</div>
          {lowBalance && (
            <div className="mt-3 text-sm text-rose-700">
              {t('low_balance_warn')}
            </div>
          )}
          <div className="mt-5 flex gap-2">
            <button onClick={() => setTopupOpen(true)}
              className="px-4 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
              {t('topup_btn')}
            </button>
            <button onClick={() => alert(t('withdraw_pending'))}
              className="px-4 py-2 rounded-md border border-input text-sm hover:bg-muted">
              {t('withdraw_btn')}
            </button>
          </div>
        </section>

        <section className="bg-card rounded-lg border border-border p-6">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('month_margin_label')}</div>
          <div className="text-2xl font-bold text-foreground mt-2">
            {fmtCNY(planRev.reduce((acc, p) => acc + (p.revenue_cents ?? 0), 0))}
          </div>
          <div className="text-xs text-muted-foreground mt-1">{t('month_margin_hint')}</div>
          <a href="/admin/orders" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
            {t('view_detail')}
          </a>
        </section>
      </div>

      <section className="mb-6">
        <h2 className="font-semibold text-foreground mb-3">{t('history_title')}</h2>
        <DataTable
          rows={ws?.history ?? []}
          columns={topupCols}
          keyFn={(r) => r.id}
          empty={t('history_empty')}
        />
      </section>

      <section>
        <h2 className="font-semibold text-foreground mb-3">{t('plan_table_title')}</h2>
        <DataTable
          rows={planRev}
          columns={planCols}
          keyFn={(p) => p.plan_name}
          empty={t('plan_table_empty')}
        />
      </section>

      <Modal
        open={topupOpen}
        onClose={() => setTopupOpen(false)}
        title={t('modal_title')}
        footer={
          <>
            <button onClick={() => setTopupOpen(false)}
              className="px-4 py-1.5 rounded-md border border-input text-sm">{tCommon('cancel')}</button>
            <button onClick={topup} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm disabled:opacity-50">
              {busy ? t('topup_busy') : t('submit_topup')}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">{t('field_amount')}</div>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input" />
            <div className="text-xs text-muted-foreground mt-0.5">= {fmtCNY(Number(amount) || 0)}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">{t('field_pay_method')}</div>
            <select value={method} onChange={(e) => setMethod(e.target.value as any)}
              className="w-full px-3 py-2 rounded-md border border-input">
              <option value="alipay">{t('pay_alipay')}</option>
              <option value="usdt">{t('pay_usdt')}</option>
            </select>
          </div>
          <div className="text-xs text-muted-foreground bg-muted rounded px-3 py-2">
            {t('topup_note')}
          </div>
        </div>
      </Modal>
    </AdminShell>
  );
}
