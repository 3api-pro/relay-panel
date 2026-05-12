'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTableV2 } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { Button } from '@/components/ui/button';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

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
  const t = useTranslations('admin.users');
  const tCommon = useTranslations('common');
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
    const verb = status === 'suspended' ? t('confirm_suspend_prefix') : t('confirm_activate_prefix');
    if (!confirm(`${verb}${u.email}${t('confirm_suffix')}`)) return;
    setRows((cur) => cur.map((x) => (x.id === u.id ? { ...x, status } : x)));
    try {
      await api(
        `/admin/end-users/${u.id}/${status === 'suspended' ? 'suspend' : 'activate'}`,
        { method: 'POST' },
      );
    } catch (e: any) {
      alert(`${t('op_failed_prefix')}${e.message}`);
      refresh();
    }
  }

  async function bulkSetStatus(users: EndUser[], status: 'active' | 'suspended') {
    const label = status === 'suspended' ? t('op_suspend') : t('op_activate');
    if (!confirm(`${label}${t('bulk_confirm_pre')}${users.length}${t('bulk_confirm_mid')}`)) return;
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
    alert(`${label}${t('bulk_done_pre')}${ok}${t('bulk_done_mid')}${fail}`);
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
      alert(`${tCommon('save_failed')}：${e.message}`);
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
            aria-label={t('select_aria_all')}
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
            aria-label={t('select_aria_row')}
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
        header: t('col_email'),
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
        header: t('col_group'),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{row.original.group_name}</span>
        ),
      },
      {
        accessorKey: 'created_at',
        header: t('col_created'),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{fmtDate(row.original.created_at)}</span>
        ),
      },
      {
        id: 'balance',
        header: t('col_balance'),
        accessorFn: (u) => u.quota_cents - u.used_quota_cents,
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="text-xs">
              <div>{fmtCNY(u.quota_cents - u.used_quota_cents)} {t('balance_remain_suffix')}</div>
              <div className="text-muted-foreground">{fmtCNY(u.used_quota_cents)} {t('balance_used_suffix')}</div>
            </div>
          );
        },
      },
      {
        accessorKey: 'status',
        header: t('col_status'),
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
        header: t('col_ops'),
        enableSorting: false,
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => startEditQuota(u)}
                className="text-primary hover:underline"
              >
                {t('op_quota')}
              </button>
              {u.status === 'active' ? (
                <button
                  onClick={() => setStatus(u, 'suspended')}
                  className="text-rose-600 hover:underline"
                >
                  {t('op_suspend')}
                </button>
              ) : (
                <button
                  onClick={() => setStatus(u, 'active')}
                  className="text-emerald-700 hover:underline"
                >
                  {t('op_activate')}
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
      title={t('title')}
      subtitle={t('subtitle')}
    >
      <DataTableV2<EndUser>
        columns={columns}
        data={rows}
        loading={loading}
        searchKey="email"
        searchPlaceholder={t('search_placeholder')}
        emptyMessage={t('empty_message')}
        bulkActions={[
          { label: t('bulk_suspend'), onClick: (sel) => bulkSetStatus(sel, 'suspended'), variant: 'outline' },
          { label: t('bulk_activate'), onClick: (sel) => bulkSetStatus(sel, 'active'), variant: 'outline' },
        ]}
      />

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing ? `${t('modal_title_prefix')}${editing.email}` : ''}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              {tCommon('cancel')}
            </Button>
            <Button size="sm" onClick={saveQuota} disabled={busy}>
              {busy ? tCommon('saving') : tCommon('save')}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              {t('modal_remain_pre')}<b>{fmtCNY(editing.quota_cents - editing.used_quota_cents)}</b>{t('modal_used_pre')}
              {fmtCNY(editing.used_quota_cents)}{t('modal_used_suffix')}
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {t('field_new_quota')}
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
