'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTable, Column } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

interface Order {
  id: number;
  user_email?: string;
  user_id?: number;
  plan_name?: string;
  plan_slug?: string;
  amount_cents: number;
  pay_method?: string;
  status: string;
  created_at: string;
  paid_at?: string | null;
}

const PAGE_SIZE = 20;
const STATUSES = ['', 'pending', 'paid', 'refunded', 'canceled'] as const;
type StatusFilter = typeof STATUSES[number];

export default function OrdersPage() {
  const [rows, setRows] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('');
  const [refunding, setRefunding] = useState<Order | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh(p: number = page, s: StatusFilter = status) {
    setLoading(true);
    const qs = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(p * PAGE_SIZE),
    });
    if (s) qs.set('status', s);
    const r = await safe(api<{ data: Order[] }>(`/admin/orders?${qs}`), { data: [] });
    setRows(r.data || []);
    setLoading(false);
  }
  useEffect(() => { refresh(0, ''); /* eslint-disable-next-line */ }, []);

  async function doRefund() {
    if (!refunding) return;
    setBusy(true);
    try {
      await api(`/admin/orders/${refunding.id}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setRefunding(null);
      setReason('');
      refresh();
    } catch (e: any) {
      alert(`退款失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Order>[] = [
    { key: 'id', header: 'ID', render: (o) => <span className="font-mono text-xs text-slate-500">#{o.id}</span> },
    { key: 'user', header: '用户', render: (o) => <span className="text-slate-800">{o.user_email ?? `user#${o.user_id ?? '?'}`}</span> },
    { key: 'plan', header: '套餐', render: (o) => o.plan_name ?? <span className="text-slate-400">—</span> },
    { key: 'amount', header: '金额', render: (o) => <span className="font-medium">{fmtCNY(o.amount_cents)}</span> },
    { key: 'method', header: '支付方式', render: (o) => <span className="text-xs text-slate-600">{o.pay_method ?? '—'}</span> },
    { key: 'status', header: '状态', render: (o) => (
      <span className={
        'text-xs px-2 py-0.5 rounded ' +
        (o.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
         o.status === 'refunded' ? 'bg-amber-100 text-amber-700' :
         o.status === 'pending' ? 'bg-sky-100 text-sky-700' :
         'bg-slate-100 text-slate-500')
      }>{o.status}</span>
    ) },
    { key: 'time', header: '时间', render: (o) => <span className="text-xs text-slate-500">{fmtDate(o.created_at)}</span> },
    { key: 'ops', header: '操作', render: (o) => (
      o.status === 'paid' ? (
        <button onClick={() => setRefunding(o)} className="text-xs text-rose-600 hover:underline">退款</button>
      ) : <span className="text-xs text-slate-400">—</span>
    ) },
  ];

  return (
    <AdminShell
      title="订单"
      subtitle="终端用户下单 / 支付 / 退款记录"
      actions={
        <div className="flex gap-2">
          {STATUSES.map((s) => (
            <button key={s || 'all'} onClick={() => { setStatus(s); setPage(0); refresh(0, s); }}
              className={
                'px-3 py-1.5 rounded-md text-sm ' +
                (status === s ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')
              }>
              {s || '全部'}
            </button>
          ))}
        </div>
      }
    >
      <DataTable
        rows={rows}
        columns={columns}
        keyFn={(o) => o.id}
        loading={loading}
        empty="暂无订单"
        page={page}
        pageSize={PAGE_SIZE}
        onPage={(p) => { setPage(p); refresh(p, status); }}
      />

      <Modal
        open={refunding != null}
        onClose={() => { setRefunding(null); setReason(''); }}
        title={refunding ? `退款 #${refunding.id}` : ''}
        footer={
          <>
            <button onClick={() => { setRefunding(null); setReason(''); }}
              className="px-4 py-1.5 rounded-md border border-slate-300 text-sm">取消</button>
            <button onClick={doRefund} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-rose-600 text-white text-sm hover:bg-rose-700 disabled:opacity-50">
              {busy ? '处理中…' : '确认退款'}
            </button>
          </>
        }
      >
        {refunding && (
          <div className="space-y-3 text-sm">
            <div className="text-slate-700">
              用户 <b>{refunding.user_email ?? '?'}</b>，金额 <b>{fmtCNY(refunding.amount_cents)}</b>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">退款原因</div>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)}
                rows={3} placeholder="如：用户主动申请 / 服务异常 / 误下单 …"
                className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm" />
            </div>
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
              退款会同时回退订阅状态，且不可逆。请确认已通过站外渠道与用户达成一致。
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
