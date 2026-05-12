'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTable, Column } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
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

const PAGE_SIZE = 20;

export default function UsersPage() {
  const [rows, setRows] = useState<EndUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<EndUser | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh(p: number = page, query: string = q) {
    setLoading(true);
    const r = await safe(
      api<{ data: EndUser[] }>(`/admin/end-users?limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}&q=${encodeURIComponent(query)}`),
      { data: [] },
    );
    setRows(r.data || []);
    setLoading(false);
  }
  useEffect(() => { refresh(0, ''); /* eslint-disable-next-line */ }, []);

  function search(e: React.FormEvent) {
    e.preventDefault();
    setPage(0);
    refresh(0, q);
  }

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

  const columns: Column<EndUser>[] = [
    { key: 'id', header: 'ID', render: (u) => <span className="font-mono text-xs text-muted-foreground">#{u.id}</span> },
    { key: 'email', header: '邮箱', render: (u) => (
      <div>
        <div className="text-foreground">{u.email}</div>
        {u.display_name && <div className="text-xs text-muted-foreground">{u.display_name}</div>}
      </div>
    ) },
    { key: 'group', header: '分组', render: (u) => <span className="text-xs text-muted-foreground">{u.group_name}</span> },
    { key: 'created', header: '注册时间', render: (u) => <span className="text-xs text-muted-foreground">{fmtDate(u.created_at)}</span> },
    { key: 'balance', header: '余额 / 已用', render: (u) => (
      <div className="text-xs">
        <div>{fmtCNY(u.quota_cents - u.used_quota_cents)} 余</div>
        <div className="text-muted-foreground">{fmtCNY(u.used_quota_cents)} 已用</div>
      </div>
    ) },
    { key: 'status', header: '状态', render: (u) => (
      <span className={
        'text-xs px-2 py-0.5 rounded ' +
        (u.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
         u.status === 'suspended' ? 'bg-rose-100 text-rose-700' :
         'bg-muted text-muted-foreground')
      }>{u.status}</span>
    ) },
    { key: 'ops', header: '操作', render: (u) => (
      <div className="flex gap-2 text-xs">
        <button onClick={() => startEditQuota(u)} className="text-brand-700 hover:underline">额度</button>
        {u.status === 'active' ? (
          <button onClick={() => setStatus(u, 'suspended')} className="text-rose-600 hover:underline">停用</button>
        ) : (
          <button onClick={() => setStatus(u, 'active')} className="text-emerald-700 hover:underline">启用</button>
        )}
      </div>
    ) },
  ];

  return (
    <AdminShell
      title="终端用户"
      subtitle={`你的店铺已注册用户（每页 ${PAGE_SIZE} 条）`}
      actions={
        <form onSubmit={search} className="flex gap-2">
          <input
            placeholder="按邮箱搜索…" value={q} onChange={(e) => setQ(e.target.value)}
            className="px-3 py-1.5 rounded-md border border-input text-sm w-56" />
          <button className="px-3 py-1.5 rounded-md bg-accent text-white text-sm hover:bg-foreground">搜索</button>
        </form>
      }
    >
      <DataTable
        rows={rows}
        columns={columns}
        keyFn={(u) => u.id}
        loading={loading}
        empty={q ? `没有匹配 "${q}" 的用户` : '暂无用户'}
        page={page}
        pageSize={PAGE_SIZE}
        onPage={(p) => { setPage(p); refresh(p, q); }}
      />

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing ? `调整额度 — ${editing.email}` : ''}
        footer={
          <>
            <button onClick={() => setEditing(null)}
              className="px-4 py-1.5 rounded-md border border-input text-sm">取消</button>
            <button onClick={saveQuota} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm disabled:opacity-50">
              {busy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              当前剩余 <b>{fmtCNY(editing.quota_cents - editing.used_quota_cents)}</b>，已用 {fmtCNY(editing.used_quota_cents)}。
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">设为新剩余额度（分）</div>
              <input type="number" value={quotaInput} onChange={(e) => setQuotaInput(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-input" />
              <div className="text-xs text-muted-foreground mt-0.5">= {fmtCNY(Number(quotaInput) || 0)}</div>
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
