'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTableV2 } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { Button } from '@/components/ui/button';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

interface EndUser {
  id: number;
  email: string;
  display_name: string | null;
  group_name: string;
  status: string;
  quota_cents: number;
  used_quota_cents: number;
  created_at: string;
}

const FETCH_LIMIT = 500;

export default function UsersPage() {
  const [rows, setRows] = useState<EndUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EndUser | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    const r = await safe(
      api<{ data: EndUser[] }>(`/admin/end-users?limit=${FETCH_LIMIT}&offset=0`),
      { data: [] },
    );
    setRows(r.data || []);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function setStatus(u: EndUser, status: 'active' | 'suspended') {
    if (!confirm(`确定 ${status === 'suspended' ? '停用' : '启用'} ${u.email}？`)) return;
    setRows((cur) => cur.map((x) => (x.id === u.id ? { ...x, status } : x)));
    try {
      await api(
        `/admin/end-users/${u.id}/${status === 'suspended' ? 'suspend' : 'activate'}`,
        { method: 'POST' },
      );
    } catch (e: any) {
      alert(`操作失败：${e.message}`);
      refresh();
    }
  }

  async function bulkSetStatus(users: EndUser[], status: 'active' | 'suspended') {
    const label = status === 'suspended' ? '停用' : '启用';
    if (!confirm(`${label} 选中的 ${users.length} 个用户？`)) return;
    let ok = 0;
    let fail = 0;
    for (const u of users) {
      try {
        await api(
          `/admin/end-users/${u.id}/${status === 'suspended' ? 'suspend' : 'activate'}`,
          { method: 'POST' },
        );
        ok++;
      } catch {
        fail++;
      }
    }
    alert(`${label}完成：成功 ${ok}，失败 ${fail}`);
    refresh();
  }

  function startEditQuota(u: EndUser) {
    setEditing(u);
    setQuotaInput(String(u.quota_cents - u.used_quota_cents));
  }

  async function saveQuota() {
    if (!editing) return;
    setBusy(true);
    try {
      const delta = Number(quotaInput) - (editing.quota_cents - editing.used_quota_cents);
      await api(`/admin/end-users/${editing.id}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount_cents: delta }),
      });
      setEditing(null);
      refresh();
    } catch (e: any) {
      alert(`保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<ColumnDef<EndUser, any>[]>(
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
        accessorKey: 'email',
        header: '邮箱',
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div>
              <div className="text-foreground">{u.email}</div>
              {u.display_name && (
                <div className="text-xs text-muted-foreground">{u.display_name}</div>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'group_name',
        header: '分组',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{row.original.group_name}</span>
        ),
      },
      {
        accessorKey: 'created_at',
        header: '注册时间',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{fmtDate(row.original.created_at)}</span>
        ),
      },
      {
        id: 'balance',
        header: '余额 / 已用',
        accessorFn: (u) => u.quota_cents - u.used_quota_cents,
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="text-xs">
              <div>{fmtCNY(u.quota_cents - u.used_quota_cents)} 余</div>
              <div className="text-muted-foreground">{fmtCNY(u.used_quota_cents)} 已用</div>
            </div>
          );
        },
      },
      {
        accessorKey: 'status',
        header: '状态',
        cell: ({ row }) => {
          const s = row.original.status;
          return (
            <span
              className={
                'text-xs px-2 py-0.5 rounded ' +
                (s === 'active'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : s === 'suspended'
                  ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                  : 'bg-muted text-muted-foreground')
              }
            >
              {s}
            </span>
          );
        },
      },
      {
        id: 'ops',
        header: '操作',
        enableSorting: false,
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => startEditQuota(u)}
                className="text-primary hover:underline"
              >
                额度
              </button>
              {u.status === 'active' ? (
                <button
                  onClick={() => setStatus(u, 'suspended')}
                  className="text-rose-600 hover:underline"
                >
                  停用
                </button>
              ) : (
                <button
                  onClick={() => setStatus(u, 'active')}
                  className="text-emerald-700 hover:underline"
                >
                  启用
                </button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <AdminShell
      title="终端用户"
      subtitle={`你的店铺已注册用户（点列头排序，搜索 + 选中支持批量操作）`}
    >
      <DataTableV2<EndUser>
        columns={columns}
        data={rows}
        loading={loading}
        searchKey="email"
        searchPlaceholder="按邮箱搜索…"
        emptyMessage="暂无用户"
        bulkActions={[
          { label: '批量停用', onClick: (sel) => bulkSetStatus(sel, 'suspended'), variant: 'outline' },
          { label: '批量启用', onClick: (sel) => bulkSetStatus(sel, 'active'), variant: 'outline' },
        ]}
      />

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing ? `调整额度 — ${editing.email}` : ''}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button size="sm" onClick={saveQuota} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              当前剩余 <b>{fmtCNY(editing.quota_cents - editing.used_quota_cents)}</b>，已用{' '}
              {fmtCNY(editing.used_quota_cents)}。
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                设为新剩余额度（分）
              </div>
              <input
                type="number"
                value={quotaInput}
                onChange={(e) => setQuotaInput(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background"
              />
              <div className="text-xs text-muted-foreground mt-0.5">
                = {fmtCNY(Number(quotaInput) || 0)}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
