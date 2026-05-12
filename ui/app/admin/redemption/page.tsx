'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTableV2 } from '@/components/admin/DataTable';
import { Modal } from '@/components/admin/Modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface Redemption {
  id: number;
  code: string;
  quota_cents: number;
  status: 'unused' | 'redeemed' | 'revoked' | string;
  redeemed_by: number | null;
  redeemed_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ListResp {
  data: Redemption[];
  counts: Partial<Record<string, number>>;
}

export default function RedemptionPage() {
  const t = useTranslations('admin.redemption');
  const [rows, setRows] = useState<Redemption[]>([]);
  const [counts, setCounts] = useState<Partial<Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'unused' | 'redeemed' | 'revoked'>('all');

  const [genOpen, setGenOpen] = useState(false);
  const [genCount, setGenCount] = useState('10');
  const [genQuotaYuan, setGenQuotaYuan] = useState('10');
  const [genPrefix, setGenPrefix] = useState('');
  const [genExpiry, setGenExpiry] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  const [generated, setGenerated] = useState<string[] | null>(null);

  async function refresh() {
    setLoading(true);
    const r = await safe<ListResp>(
      api<ListResp>(`/admin/redemption?status=${statusFilter}&limit=500`),
      { data: [], counts: {} },
    );
    setRows(r.data || []);
    setCounts(r.counts || {});
    setLoading(false);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function generate() {
    const count = parseInt(genCount, 10);
    const yuan = parseFloat(genQuotaYuan);
    if (!count || count <= 0 || count > 1000) {
      alert(t('err_count_range'));
      return;
    }
    if (!yuan || yuan <= 0) {
      alert(t('err_quota_positive'));
      return;
    }
    const body: any = {
      count,
      quota_cents: Math.round(yuan * 100),
    };
    if (genPrefix.trim()) body.prefix = genPrefix.trim();
    if (genExpiry) body.expires_at = new Date(genExpiry).toISOString();

    setGenBusy(true);
    try {
      const r = await api<{ codes: string[]; quota_cents_each: number }>('/admin/redemption', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setGenerated(r.codes);
      setGenOpen(false);
      refresh();
    } catch (e: any) {
      alert(`${t('err_generate_prefix')}${e.message}`);
    } finally {
      setGenBusy(false);
    }
  }

  async function revoke(r: Redemption) {
    if (!confirm(t('confirm_revoke', { code: r.code }))) return;
    try {
      await api(`/admin/redemption/${r.id}/revoke`, { method: 'POST' });
      refresh();
    } catch (e: any) {
      alert(`${t('err_revoke_prefix')}${e.message}`);
    }
  }

  function copyAll() {
    if (!generated) return;
    try { navigator.clipboard.writeText(generated.join('\n')); } catch {}
  }

  const columns = useMemo<ColumnDef<Redemption, any>[]>(() => [
    { accessorKey: 'id', header: '#', cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.id}</span> },
    { accessorKey: 'code', header: t('col_code'), cell: ({ row }) => <code className="text-xs">{row.original.code}</code> },
    { accessorKey: 'quota_cents', header: t('col_value'), cell: ({ row }) => <span className="text-sm tabular-nums">{fmtCNY(row.original.quota_cents)}</span> },
    { accessorKey: 'status', header: t('col_status'), cell: ({ row }) => {
      const s = row.original.status;
      const cls = s === 'unused' ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                : s === 'redeemed' ? 'text-sky-700 dark:text-sky-400 bg-sky-500/10'
                : 'text-muted-foreground bg-muted';
      return <Badge variant="secondary" className={cls}>{t(`status_${s}`)}</Badge>;
    }},
    { accessorKey: 'expires_at', header: t('col_expires'), cell: ({ row }) =>
      row.original.expires_at ? <span className="text-xs text-muted-foreground">{fmtDate(row.original.expires_at)}</span> : <span className="text-xs">—</span> },
    { accessorKey: 'redeemed_at', header: t('col_redeemed_at'), cell: ({ row }) =>
      row.original.redeemed_at ? <span className="text-xs text-muted-foreground">{fmtDate(row.original.redeemed_at)}</span> : <span className="text-xs">—</span> },
    { accessorKey: 'created_at', header: t('col_created'), cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDate(row.original.created_at)}</span> },
    { id: 'actions', header: t('col_actions'), cell: ({ row }) => (
      row.original.status === 'unused'
        ? <Button size="sm" variant="destructive" onClick={() => revoke(row.original)}>{t('btn_revoke')}</Button>
        : <span className="text-xs text-muted-foreground">—</span>
    ) },
  ], [t]);

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 text-sm">
            {(['all', 'unused', 'redeemed', 'revoked'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={
                  'px-3 py-1.5 rounded-md text-xs transition-colors ' +
                  (statusFilter === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground')
                }
              >
                {t(`filter_${s}`)}{s !== 'all' && counts[s] != null ? ` (${counts[s]})` : ''}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Button onClick={() => setGenOpen(true)}>{t('generate_button')}</Button>
        </div>

        <DataTableV2<Redemption>
          columns={columns}
          data={rows}
          loading={loading}
          pageSize={20}
          emptyMessage={t('empty')}
        />

        {/* Generate-batch modal */}
        <Modal open={genOpen} onClose={() => setGenOpen(false)} title={t('generate_modal_title')}>
          <div className="space-y-4">
            <div>
              <Label>{t('field_count')}</Label>
              <Input type="number" min={1} max={1000} value={genCount} onChange={(e) => setGenCount(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">{t('field_count_hint')}</p>
            </div>
            <div>
              <Label>{t('field_quota')}</Label>
              <Input type="number" step="0.01" min={0.01} value={genQuotaYuan} onChange={(e) => setGenQuotaYuan(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">{t('field_quota_hint')}</p>
            </div>
            <div>
              <Label>{t('field_prefix')}</Label>
              <Input maxLength={16} value={genPrefix} onChange={(e) => setGenPrefix(e.target.value)} placeholder="2026Q2-" />
              <p className="text-xs text-muted-foreground mt-1">{t('field_prefix_hint')}</p>
            </div>
            <div>
              <Label>{t('field_expiry')}</Label>
              <Input type="datetime-local" value={genExpiry} onChange={(e) => setGenExpiry(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">{t('field_expiry_hint')}</p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setGenOpen(false)}>{t('cancel')}</Button>
              <Button onClick={generate} disabled={genBusy}>
                {genBusy ? t('generating') : t('confirm_generate')}
              </Button>
            </div>
          </div>
        </Modal>

        {/* Result modal — show the freshly generated codes once */}
        <Modal open={!!generated} onClose={() => setGenerated(null)} title={t('generated_modal_title')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('generated_hint', { count: generated?.length ?? 0 })}</p>
            <textarea
              readOnly
              className="w-full h-64 text-xs font-mono bg-muted/40 border border-border rounded-md p-3 resize-none"
              value={(generated ?? []).join('\n')}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={copyAll}>{t('copy_all')}</Button>
              <Button onClick={() => setGenerated(null)}>{t('done')}</Button>
            </div>
          </div>
        </Modal>
      </div>
    </AdminShell>
  );
}
