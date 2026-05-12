'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtCNY } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

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
  billing_type?: 'subscription' | 'token_pack';
}

type BillingType = 'subscription' | 'token_pack';
const TOKEN_PACK_PERIOD_DAYS = 3650;

const EMPTY_FORM = {
  id: 0,
  name: '',
  slug: '',
  period_days: 30,
  quota_tokens: 5_000_000,
  price_cents: 9900,
  wholesale_face_value_cents: 6000,
  enabled: true,
  billing_type: 'subscription' as BillingType,
};

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<typeof EMPTY_FORM | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<BillingType>('subscription');
  const t = useTranslations('admin.plans');
  const tCommon = useTranslations('common');

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
      billing_type: (p.billing_type ?? 'subscription') as BillingType,
    });
  }
  function startCreate() {
    // Pre-set billing_type to the currently active tab so the "+ 新增套餐"
    // CTA inside "Token 套餐" tab pre-fills as token_pack.
    setEditing({ ...EMPTY_FORM, billing_type: tab });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const isPack = editing.billing_type === 'token_pack';
      const body = {
        name: editing.name,
        slug: editing.slug,
        // Backend force-clamps period_days for token_pack to 3650;
        // we send the clamped value here too so the create form preview matches.
        period_days: isPack ? TOKEN_PACK_PERIOD_DAYS : Number(editing.period_days),
        quota_tokens: Number(editing.quota_tokens),
        price_cents: Number(editing.price_cents),
        wholesale_face_value_cents: Number(editing.wholesale_face_value_cents),
        enabled: editing.enabled,
        billing_type: editing.billing_type,
      };
      if (editing.id) {
        await api(`/admin/plans/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/admin/plans', { method: 'POST', body: JSON.stringify(body) });
      }
      setEditing(null);
      await refresh();
    } catch (e: any) {
      alert(t('save_failed_prefix') + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Plan) {
    if (!confirm(t('remove_confirm', { name: p.name }))) return;
    try {
      await api(`/admin/plans/${p.id}`, { method: 'DELETE' });
      refresh();
    } catch (e: any) {
      alert(t('delete_failed_prefix') + e.message);
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
      alert(t('reorder_failed_prefix') + e.message);
      refresh();
    }
  }

  const filteredPlans = plans.filter(
    (p) => (p.billing_type ?? 'subscription') === tab,
  );
  const subCount = plans.filter((p) => (p.billing_type ?? 'subscription') === 'subscription').length;
  const packCount = plans.filter((p) => p.billing_type === 'token_pack').length;

  return (
    <AdminShell
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <button onClick={startCreate}
          className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
          {t('new_btn')}
        </button>
      }
    >
      {/* Tabs: 订阅 vs token pack */}
      <div className="flex gap-1 border-b border-border mb-6">
        <TabBtn active={tab === 'subscription'} onClick={() => setTab('subscription')}>
          {t('tab_subscription')} <span className="ml-1 text-xs text-muted-foreground">({subCount})</span>
        </TabBtn>
        <TabBtn active={tab === 'token_pack'} onClick={() => setTab('token_pack')}>
          {t('tab_token_pack')} <span className="ml-1 text-xs text-muted-foreground">({packCount})</span>
        </TabBtn>
      </div>

      {err && <div className="mb-4 text-sm text-red-600">{err}</div>}
      {loading ? (
        <div className="text-sm text-muted-foreground">{tCommon('loading')}</div>
      ) : filteredPlans.length === 0 ? (
        <div className="bg-card rounded-lg border border-border p-12 text-center text-muted-foreground">
          {tab === 'subscription' ? t('empty_subscription') : t('empty_token_pack')}{' '}
          <a href="/admin/onboarding" className="text-brand-700 underline">{t('empty_link')}</a> {t('empty_tail')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {filteredPlans.map((p, idx) => (
            <div key={p.id} className="bg-card rounded-lg border border-border p-5 flex flex-col">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-sm text-muted-foreground font-mono">{p.slug}</div>
                  <div className="text-lg font-semibold text-foreground">{p.name}</div>
                </div>
                <label className="text-xs flex items-center gap-1 cursor-pointer shrink-0">
                  <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                  <span className={p.enabled ? 'text-emerald-700' : 'text-muted-foreground'}>
                    {p.enabled ? tCommon('listed') : tCommon('unlisted')}
                  </span>
                </label>
              </div>
              <div className="mt-2 mb-3">
                <div className="text-3xl font-bold text-foreground">{fmtCNY(p.price_cents)}</div>
                <div className="text-xs text-muted-foreground">
                  {p.billing_type === 'token_pack' ? t('lifetime') : t('period_days_suffix', { days: p.period_days })}
                </div>
              </div>
              <ul className="text-sm text-muted-foreground space-y-1 flex-1">
                <li>
                  {p.quota_tokens === -1
                    ? t('unlimited_token')
                    : `${(p.quota_tokens / 1_000_000).toFixed(1)}${t('tokens_m')}`}
                </li>
                <li className="text-xs text-muted-foreground">
                  {t('upstream_cost')} {fmtCNY(p.wholesale_face_value_cents)}
                </li>
              </ul>
              <div className="mt-4 flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  <button onClick={() => move(p, -1)} disabled={idx === 0}
                    className="px-2 py-1 rounded border border-input text-xs disabled:opacity-30 hover:bg-muted">↑</button>
                  <button onClick={() => move(p, 1)} disabled={idx === filteredPlans.length - 1}
                    className="px-2 py-1 rounded border border-input text-xs disabled:opacity-30 hover:bg-muted">↓</button>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => startEdit(p)}
                    className="px-2.5 py-1 rounded text-xs text-brand-700 hover:underline">{tCommon('edit')}</button>
                  <button onClick={() => remove(p)}
                    className="px-2.5 py-1 rounded text-xs text-rose-600 hover:underline">{tCommon('unlisted')}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.id ? `${t('modal_edit_prefix')}${editing.id}` : t('modal_new')}
        width="lg"
        footer={
          <>
            <button onClick={() => setEditing(null)}
              className="px-4 py-1.5 rounded-md border border-input text-sm hover:bg-muted">{tCommon('cancel')}</button>
            <button onClick={save} disabled={busy}
              className="px-4 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700 disabled:opacity-50">
              {busy ? tCommon('saving') : tCommon('save')}
            </button>
          </>
        }
      >
        {editing && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="col-span-2">
              <div className="text-xs font-medium text-muted-foreground mb-1.5">{t('billing_type_label')}</div>
              <div className="flex gap-2">
                <label className={`flex-1 cursor-pointer px-3 py-2 rounded-md border ${editing.billing_type === 'subscription' ? 'border-brand-600 bg-brand-50' : 'border-input'}`}>
                  <input
                    type="radio"
                    name="billing_type"
                    value="subscription"
                    checked={editing.billing_type === 'subscription'}
                    onChange={() => setEditing({ ...editing, billing_type: 'subscription' })}
                    className="mr-2"
                  />
                  <span className="font-medium">{t('billing_sub_title')}</span>
                  <div className="text-xs text-muted-foreground mt-0.5">{t('billing_sub_desc')}</div>
                </label>
                <label className={`flex-1 cursor-pointer px-3 py-2 rounded-md border ${editing.billing_type === 'token_pack' ? 'border-brand-600 bg-brand-50' : 'border-input'}`}>
                  <input
                    type="radio"
                    name="billing_type"
                    value="token_pack"
                    checked={editing.billing_type === 'token_pack'}
                    onChange={() => setEditing({ ...editing, billing_type: 'token_pack', period_days: TOKEN_PACK_PERIOD_DAYS })}
                    className="mr-2"
                  />
                  <span className="font-medium">{t('billing_pack_title')}</span>
                  <div className="text-xs text-muted-foreground mt-0.5">{t('billing_pack_desc')}</div>
                </label>
              </div>
            </div>
            <Field label={t('field_name')}>
              <input className="w-full px-3 py-2 rounded-md border border-input"
                value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label={t('field_slug')}>
              <input className="w-full px-3 py-2 rounded-md border border-input font-mono"
                value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
            </Field>
            {editing.billing_type === 'subscription' ? (
              <Field label={t('field_period_days')}>
                <input type="number" className="w-full px-3 py-2 rounded-md border border-input"
                  value={editing.period_days} onChange={(e) => setEditing({ ...editing, period_days: +e.target.value })} />
              </Field>
            ) : (
              <Field label={t('field_validity')}>
                <div className="px-3 py-2 rounded-md border border-input bg-muted text-muted-foreground">
                  {t('lifetime_inline')}
                </div>
              </Field>
            )}
            <Field label={t('field_quota')}>
              <input type="number" className="w-full px-3 py-2 rounded-md border border-input"
                value={editing.quota_tokens} onChange={(e) => setEditing({ ...editing, quota_tokens: +e.target.value })} />
            </Field>
            <Field label={t('field_price')}>
              <input type="number" className="w-full px-3 py-2 rounded-md border border-input"
                value={editing.price_cents} onChange={(e) => setEditing({ ...editing, price_cents: +e.target.value })} />
              <div className="text-xs text-muted-foreground mt-0.5">= {fmtCNY(editing.price_cents)}</div>
            </Field>
            <Field label={t('field_wholesale')}>
              <input type="number" className="w-full px-3 py-2 rounded-md border border-input"
                value={editing.wholesale_face_value_cents} onChange={(e) => setEditing({ ...editing, wholesale_face_value_cents: +e.target.value })} />
              <div className="text-xs text-muted-foreground mt-0.5">= {fmtCNY(editing.wholesale_face_value_cents)} {t('profit_inline', { profit: fmtCNY(editing.price_cents - editing.wholesale_face_value_cents) })}</div>
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
              {t('list_now')}
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
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 transition-colors ${
        active
          ? 'border-brand-600 text-brand-700 font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
