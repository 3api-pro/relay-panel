'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY } from '@/lib/api';

interface Plan {
  id: number;
  name: string;
  slug: string;
  period_days: number;
  quota_tokens: number;
  price_cents: number;
  wholesale_face_value_cents: number;
  enabled: boolean;
  sort_order: number;
  allowed_models?: string[] | string | null;
}

const EMPTY_FORM = {
  id: 0,
  name: '',
  slug: '',
  period_days: 30,
  quota_tokens: 5_000_000,
  price_cents: 9900,
  wholesale_face_value_cents: 6000,
  enabled: true,
};

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<typeof EMPTY_FORM | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true); setErr('');
    try {
      const r = await api<{ data: Plan[] }>('/admin/plans');
      setPlans((r.data || []).sort((a, b) => a.sort_order - b.sort_order));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function toggle(p: Plan) {
    const next = !p.enabled;
    setPlans((cur) => cur.map((x) => (x.id === p.id ? { ...x, enabled: next } : x)));
    try {
      await api(`/admin/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    } catch {
      setPlans((cur) => cur.map((x) => (x.id === p.id ? { ...x, enabled: !next } : x)));
    }
  }

  function startEdit(p: Plan) {
    setEditing({
      id: p.id,
      name: p.name,
      slug: p.slug,
      period_days: p.period_days,
      quota_tokens: p.quota_tokens,
      price_cents: p.price_cents,
      wholesale_face_value_cents: p.wholesale_face_value_cents,
      enabled: p.enabled,
    });
  }
  function startCreate() {
    setEditing({ ...EMPTY_FORM });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const body = {
        name: editing.name,
        slug: editing.slug,
        period_days: Number(editing.period_days),
        quota_tokens: Number(editing.quota_tokens),
        price_cents: Number(editing.price_cents),
        wholesale_face_value_cents: Number(editing.wholesale_face_value_cents),
        enabled: editing.enabled,
      };
      if (editing.id) {
        await api(`/admin/plans/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/admin/plans', { method: 'POST', body: JSON.stringify(body) });
      }
      setEditing(null);
      await refresh();
    } catch (e: any) {
      alert(`保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Plan) {
    if (!confirm(`下架套餐 "${p.name}"？已下架的套餐不影响存量订单。`)) return;
    try {
      await api(`/admin/plans/${p.id}`, { method: 'DELETE' });
      refresh();
    } catch (e: any) {
      alert(`删除失败：${e.message}`);
    }
  }

  async function move(p: Plan, dir: -1 | 1) {
    const idx = plans.findIndex((x) => x.id === p.id);
    const swap = plans[idx + dir];
    if (!swap) return;
    const ids = plans.map((x) => x.id);
    [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
    const optimistic = ids.map((id) => plans.find((x) => x.id === id)!);
    setPlans(optimistic);
    try {
      await api('/admin/plans/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
    } catch (e: any) {
      alert(`排序失败：${e.message}`);
      refresh();
    }
  }

  return (
    <AdminShell
      title="套餐管理"
      subtitle="终端用户可下单的订阅套餐"
      actions={
        <button onClick={startCreate}
          className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
          + 新增套餐
        </button>
      }
    >
      {err && <div className="mb-4 text-sm text-red-600">{err}</div>}
      {loading ? (
        <div className="text-sm text-slate-400">加载中…</div>
      ) : plans.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-12 text-center text-slate-400">
          暂无套餐 — 点 "+ 新增套餐" 创建首个，或先完成 <a href="/admin/onboarding" className="text-brand-700 underline">站长向导</a> seed 默认 4 个套餐。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {plans.map((p, idx) => (
            <div key={p.id} className="bg-white rounded-lg border border-slate-200 p-5 flex flex-col">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-sm text-slate-500 font-mono">{p.slug}</div>
                  <div className="text-lg font-semibold text-slate-900">{p.name}</div>
                </div>
                <label className="text-xs flex items-center gap-1 cursor-pointer shrink-0">
                  <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                  <span className={p.enabled ? 'text-emerald-700' : 'text-slate-400'}>
                    {p.enabled ? '上架' : '下架'}
                  </span>
                </label>
              </div>
              <div className="mt-2 mb-3">
                <div className="text-3xl font-bold text-slate-900">{fmtCNY(p.price_cents)}</div>
                <div className="text-xs text-slate-500">/ {p.period_days} 天</div>
              </div>
              <ul className="text-sm text-slate-600 space-y-1 flex-1">
                <li>
                  {p.quota_tokens === -1
                    ? '不限 Token'
                    : `${(p.quota_tokens / 1_000_000).toFixed(1)}M Token`}
                </li>
                <li className="text-xs text-slate-500">
                  上游成本 {fmtCNY(p.wholesale_face_value_cents)}
                </li>
              </ul>
              <div className="mt-4 flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  <button onClick={() => move(p, -1)} disabled={idx === 0}
                    className="px-2 py-1 rounded border border-slate-300 text-xs disabled:opacity-30 hover:bg-slate-50">↑</button>
                  <button onClick={() => move(p, 1)} disabled={idx === plans.length - 1}
                    className="px-2 py-1 rounded border border-slate-300 text-xs disabled:opacity-30 hover:bg-slate-50">↓</button>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => startEdit(p)}
                    className="px-2.5 py-1 rounded text-xs text-brand-700 hover:underline">编辑</button>
                  <button onClick={() => remove(p)}
                    className="px-2.5 py-1 rounded text-xs text-rose-600 hover:underline">下架</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.id ? `编辑 #${editing.id}` : '新增套餐'}
        width="lg"
        footer={
          <>
            <button onClick={() => setEditing(null)}
              className="px-4 py-1.5 rounded-md border border-slate-300 text-sm hover:bg-slate-50">取消</button>
            <button onClick={save} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700 disabled:opacity-50">
              {busy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editing && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="名称">
              <input className="w-full px-3 py-2 rounded-md border border-slate-300"
                value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Slug (URL 用)">
              <input className="w-full px-3 py-2 rounded-md border border-slate-300 font-mono"
                value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
            </Field>
            <Field label="周期天数">
              <input type="number" className="w-full px-3 py-2 rounded-md border border-slate-300"
                value={editing.period_days} onChange={(e) => setEditing({ ...editing, period_days: +e.target.value })} />
            </Field>
            <Field label="Token 配额（-1 = 不限）">
              <input type="number" className="w-full px-3 py-2 rounded-md border border-slate-300"
                value={editing.quota_tokens} onChange={(e) => setEditing({ ...editing, quota_tokens: +e.target.value })} />
            </Field>
            <Field label="售价（分）">
              <input type="number" className="w-full px-3 py-2 rounded-md border border-slate-300"
                value={editing.price_cents} onChange={(e) => setEditing({ ...editing, price_cents: +e.target.value })} />
              <div className="text-xs text-slate-500 mt-0.5">= {fmtCNY(editing.price_cents)}</div>
            </Field>
            <Field label="上游成本（分）">
              <input type="number" className="w-full px-3 py-2 rounded-md border border-slate-300"
                value={editing.wholesale_face_value_cents} onChange={(e) => setEditing({ ...editing, wholesale_face_value_cents: +e.target.value })} />
              <div className="text-xs text-slate-500 mt-0.5">= {fmtCNY(editing.wholesale_face_value_cents)}（毛利 {fmtCNY(editing.price_cents - editing.wholesale_face_value_cents)}）</div>
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
              立即上架
            </label>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-600 mb-1">{label}</div>
      {children}
    </div>
  );
}
