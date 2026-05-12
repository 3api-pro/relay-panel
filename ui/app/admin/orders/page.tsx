'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTableV2 } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { Button } from '@/components/ui/button';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

interface Order {
  id: number;
  user_email?: string;
  user_id?: number;
  plan_name?: string;
  plan_slug?: string;
  amount_cents: number;
  pay_method?: string;
  provider_txn_id?: string | null;
  status: string;
  created_at: string;
  paid_at?: string | null;
}

const FETCH_LIMIT = 500;
const STATUSES = ['', 'pending', 'paid', 'refunded', 'canceled'] as const;
type StatusFilter = (typeof STATUSES)[number];

function statusClass(s: string) {
  return (
    'text-xs px-2 py-0.5 rounded ' +
    (s === 'paid'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : s === 'refunded'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      : s === 'pending'
      ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
      : 'bg-muted text-muted-foreground')
  );
}

function escapeCsv(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(rows: Order[]) {
  const header = ['id', 'user_email', 'plan_name', 'amount_cents', 'pay_method', 'provider_txn_id', 'status', 'created_at', 'paid_at'];
  const body = rows.map((o) =>
    [
      o.id,
      o.user_email ?? '',
      o.plan_name ?? '',
      o.amount_cents,
      o.pay_method ?? '',
      o.provider_txn_id ?? '',
      o.status,
      o.created_at,
      o.paid_at ?? '',
    ]
      .map(escapeCsv)
      .join(','),
  );
  const csv = [header.join(','), ...body].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `orders-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function OrdersPage() {
  const [rows, setRows] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>('');
  const [refunding, setRefunding] = useState<Order | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh(s: StatusFilter = status) {
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(FETCH_LIMIT), offset: '0' });
    if (s) qs.set('status', s);
    const r = await safe(api<{ data: Order[] }>(`/admin/orders?${qs}`), { data: [] });
    setRows(r.data || []);
    setLoading(false);
  }
  useEffect(() => {
    refresh('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const columns = useMemo<ColumnDef<Order, any>[]>(
    () => [
      {
        id: 'select',
        enableSorting: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="全选当前页"
            checked={table.getIsAllPageRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = !table.getIsAllPageRowsSelected() && table.getIsSomePageRowsSelected();
            }}
            onChange={(e) => table.toggleAllPageRowsSelected(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-input cursor-pointer"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label="选中行"
            checked={row.getIsSelected()}
            onChange={(e) => row.toggleSelected(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-input cursor-pointer"
          />
        ),
        size: 32,
      },
      {
        accessorKey: 'id',
        header: 'ID',
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">#{row.original.id}</span>
        ),
      },
      {
        accessorKey: 'user_email',
        header: '用户',
        cell: ({ row }) => {
          const o = row.original;
          return (
            <span className="text-foreground">
              {o.user_email ?? `user#${o.user_id ?? '?'}`}
            </span>
          );
        },
      },
      {
        accessorKey: 'plan_name',
        header: '套餐',
        cell: ({ row }) =>
          row.original.plan_name ?? <span className="text-muted-foreground">—</span>,
      },
      {
        accessorKey: 'amount_cents',
        header: '金额',
        cell: ({ row }) => (
          <span className="font-medium">{fmtCNY(row.original.amount_cents)}</span>
        ),
      },
      {
        accessorKey: 'pay_method',
        header: '支付方式',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.pay_method ?? '—'}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: '状态',
        cell: ({ row }) => <span className={statusClass(row.original.status)}>{row.original.status}</span>,
      },
      {
        accessorKey: 'created_at',
        header: '时间',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{fmtDate(row.original.created_at)}</span>
        ),
      },
      {
        id: 'ops',
        header: '操作',
        enableSorting: false,
        cell: ({ row }) => {
          const o = row.original;
          return o.status === 'paid' ? (
            <button
              onClick={() => setRefunding(o)}
              className="text-xs text-rose-600 hover:underline"
            >
              退款
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          );
        },
      },
    ],
    [],
  );

  const statusToolbar = (
    <div className="flex gap-1.5 flex-wrap">
      {STATUSES.map((s) => (
        <Button
          key={s || 'all'}
          size="sm"
          variant={status === s ? 'default' : 'outline'}
          onClick={() => {
            setStatus(s);
            refresh(s);
          }}
          className="h-8 px-3 text-xs"
        >
          {s || '全部'}
        </Button>
      ))}
    </div>
  );

  return (
    <AdminShell
      title="订单"
      subtitle="终端用户下单 / 支付 / 退款记录（支持搜索 · 排序 · 批量导出）"
    >
      <DataTableV2<Order>
        columns={columns}
        data={rows}
        loading={loading}
        searchKey="user_email"
        searchPlaceholder="按邮箱 / 订单号搜索…"
        emptyMessage="暂无订单"
        toolbar={statusToolbar}
        bulkActions={[
          {
            label: '导出 CSV',
            onClick: (sel) => downloadCsv(sel),
            variant: 'outline',
          },
        ]}
      />

      <Modal
        open={refunding != null}
        onClose={() => {
          setRefunding(null);
          setReason('');
        }}
        title={refunding ? `退款 #${refunding.id}` : ''}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRefunding(null);
                setReason('');
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={doRefund}
              disabled={busy}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {busy ? '处理中…' : '确认退款'}
            </Button>
          </>
        }
      >
        {refunding && (
          <div className="space-y-3 text-sm">
            <div className="text-foreground">
              用户 <b>{refunding.user_email ?? '?'}</b>，金额{' '}
              <b>{fmtCNY(refunding.amount_cents)}</b>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">退款原因</div>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="如：用户主动申请 / 服务异常 / 误下单 …"
                className="w-full px-3 py-2 rounded-md border border-input text-sm bg-background"
              />
            </div>
            <div className="text-xs text-rose-700 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 rounded px-3 py-2">
              退款会同时回退订阅状态，且不可逆。请确认已通过站外渠道与用户达成一致。
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
