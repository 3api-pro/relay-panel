'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTable, Column } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

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
      alert(`充值失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const lowBalance = (ws?.balance_cents ?? 0) < 5000;

  const topupCols: Column<TopupRow>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="font-mono text-xs text-slate-500">#{r.id}</span> },
    { key: 'amount', header: '金额', render: (r) => (
      <span className={r.amount_cents >= 0 ? 'text-emerald-700 font-medium' : 'text-rose-600 font-medium'}>
        {r.amount_cents >= 0 ? '+' : ''}{fmtCNY(r.amount_cents)}
      </span>
    ) },
    { key: 'method', header: '渠道', render: (r) => <span className="text-xs">{r.pay_method ?? '—'}</span> },
    { key: 'ref', header: '凭证', render: (r) => <span className="text-xs font-mono text-slate-500">{r.ref ?? '—'}</span> },
    { key: 'status', header: '状态', render: (r) => <span className="text-xs">{r.status ?? '—'}</span> },
    { key: 'time', header: '时间', render: (r) => <span className="text-xs text-slate-500">{fmtDate(r.created_at)}</span> },
  ];

  const planCols: Column<PlanRevenue>[] = [
    { key: 'plan', header: '套餐', render: (p) => <span className="text-slate-800">{p.plan_name}</span> },
    { key: 'orders', header: '订单数', render: (p) => p.orders },
    { key: 'rev', header: '总收入', render: (p) => <span className="font-medium">{fmtCNY(p.revenue_cents)}</span> },
  ];

  return (
    <AdminShell title="财务" subtitle="上游充值 + 收入报表 + 提现">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <section className="lg:col-span-2 bg-white rounded-lg border border-slate-200 p-6">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Wholesale 余额</div>
          <div className={
            'text-4xl font-bold mt-2 ' +
            (lowBalance ? 'text-rose-600' : 'text-slate-900')
          }>
            {fmtCNY(ws?.balance_cents ?? 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1">更新于 {fmtDate(ws?.updated_at ?? null)}</div>
          {lowBalance && (
            <div className="mt-3 text-sm text-rose-700">
              ⚠️ 余额偏低 — 用户付款后将无法供给上游 token，请尽快充值。
            </div>
          )}
          <div className="mt-5 flex gap-2">
            <button onClick={() => setTopupOpen(true)}
              className="px-4 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
              + 充值
            </button>
            <button onClick={() => alert('提现功能将在 v0.2 上线 — 当前阶段直接联系平台运营')}
              className="px-4 py-2 rounded-md border border-slate-300 text-sm hover:bg-slate-50">
              提现
            </button>
          </div>
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="text-xs text-slate-500 uppercase tracking-wide">本月毛利估算</div>
          <div className="text-2xl font-bold text-slate-900 mt-2">
            {fmtCNY(planRev.reduce((acc, p) => acc + (p.revenue_cents ?? 0), 0))}
          </div>
          <div className="text-xs text-slate-500 mt-1">30 天滚动 · 不含未结算</div>
          <a href="/admin/orders" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
            查看明细 →
          </a>
        </section>
      </div>

      <section className="mb-6">
        <h2 className="font-semibold text-slate-900 mb-3">充值历史</h2>
        <DataTable
          rows={ws?.history ?? []}
          columns={topupCols}
          keyFn={(r) => r.id}
          empty="暂无充值记录"
        />
      </section>

      <section>
        <h2 className="font-semibold text-slate-900 mb-3">30 天收入（按套餐）</h2>
        <DataTable
          rows={planRev}
          columns={planCols}
          keyFn={(p) => p.plan_name}
          empty="暂无收入数据（等 /admin/stats?group=plan 接口）"
        />
      </section>

      <Modal
        open={topupOpen}
        onClose={() => setTopupOpen(false)}
        title="给 wholesale 余额充值"
        footer={
          <>
            <button onClick={() => setTopupOpen(false)}
              className="px-4 py-1.5 rounded-md border border-slate-300 text-sm">取消</button>
            <button onClick={topup} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm disabled:opacity-50">
              {busy ? '处理中…' : '确认充值'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-medium text-slate-600 mb-1">金额（分）</div>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300" />
            <div className="text-xs text-slate-500 mt-0.5">= {fmtCNY(Number(amount) || 0)}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-600 mb-1">支付方式</div>
            <select value={method} onChange={(e) => setMethod(e.target.value as any)}
              className="w-full px-3 py-2 rounded-md border border-slate-300">
              <option value="alipay">支付宝</option>
              <option value="usdt">USDT</option>
            </select>
          </div>
          <div className="text-xs text-slate-500 bg-slate-50 rounded px-3 py-2">
            备注：当前阶段属本地账面充值，需先线下完成与平台的对账。后端会原子扣减余额。
          </div>
        </div>
      </Modal>
    </AdminShell>
  );
}
