'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminShell } from '@/components/admin/AdminShell';
import { DataTableV2 } from '@/components/admin/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface LogRow {
  id: number;
  end_user_id: number | null;
  end_token_id: number | null;
  channel_id: number | null;
  model_name: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  quota_charged_cents: number;
  request_id: string | null;
  elapsed_ms: number | null;
  is_stream: boolean;
  status: string;
  created_at: string;
}

const PAGE_SIZE = 50;

export default function LogsPage() {
  const t = useTranslations('admin.logs');
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failure'>('all');
  const [model, setModel] = useState('');
  const [endUserId, setEndUserId] = useState('');

  async function refresh() {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      status: statusFilter,
    });
    if (model) params.set('model', model);
    if (endUserId) params.set('end_user_id', endUserId);
    const r = await safe(
      api<{ data: LogRow[]; total: number }>(`/admin/logs?${params}`),
      { data: [], total: 0 },
    );
    setRows(r.data || []);
    setTotal(r.total || 0);
    setLoading(false);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [offset, statusFilter]);

  const columns = useMemo<ColumnDef<LogRow, any>[]>(() => [
    { accessorKey: 'id', header: '#', cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.id}</span> },
    { accessorKey: 'created_at', header: t('col_time'), cell: ({ row }) => <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(row.original.created_at)}</span> },
    { accessorKey: 'status', header: t('col_status'), cell: ({ row }) => (
      row.original.status === 'success'
        ? <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400 bg-emerald-500/10">{t('status_success')}</Badge>
        : <Badge variant="secondary" className="text-rose-700 dark:text-rose-400 bg-rose-500/10">{t('status_failure')}</Badge>
    ) },
    { accessorKey: 'model_name', header: t('col_model'), cell: ({ row }) => <code className="text-xs">{row.original.model_name ?? '—'}</code> },
    { accessorKey: 'end_user_id', header: t('col_user'), cell: ({ row }) => <span className="text-xs">{row.original.end_user_id ?? '—'}</span> },
    { accessorKey: 'prompt_tokens', header: t('col_input'), cell: ({ row }) => <span className="text-xs tabular-nums">{row.original.prompt_tokens.toLocaleString()}</span> },
    { accessorKey: 'completion_tokens', header: t('col_output'), cell: ({ row }) => <span className="text-xs tabular-nums">{row.original.completion_tokens.toLocaleString()}</span> },
    { accessorKey: 'quota_charged_cents', header: t('col_cost'), cell: ({ row }) => <span className="text-xs tabular-nums">{fmtCNY(row.original.quota_charged_cents)}</span> },
    { accessorKey: 'elapsed_ms', header: t('col_latency'), cell: ({ row }) => <span className="text-xs tabular-nums">{row.original.elapsed_ms != null ? `${row.original.elapsed_ms}ms` : '—'}</span> },
    { accessorKey: 'is_stream', header: t('col_stream'), cell: ({ row }) => <span className="text-xs">{row.original.is_stream ? 'SSE' : 'JSON'}</span> },
    { accessorKey: 'request_id', header: t('col_request_id'), cell: ({ row }) => <code className="text-[10px] text-muted-foreground">{row.original.request_id?.slice(0, 12) ?? '—'}</code> },
  ], [t]);

  const pageIndex = Math.floor(offset / PAGE_SIZE);
  const pageCount = Math.ceil(total / PAGE_SIZE);

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1 text-sm">
            {(['all', 'success', 'failure'] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setOffset(0); }}
                className={
                  'px-3 py-1.5 rounded-md text-xs transition-colors ' +
                  (statusFilter === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground')
                }
              >
                {t(`filter_${s}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t('filter_model')}</label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-sonnet"
              className="h-9 w-44"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t('filter_user_id')}</label>
            <Input
              type="number"
              value={endUserId}
              onChange={(e) => setEndUserId(e.target.value)}
              placeholder="123"
              className="h-9 w-28"
            />
          </div>
          <Button size="sm" onClick={() => { setOffset(0); refresh(); }}>{t('apply_filters')}</Button>
        </div>

        <DataTableV2<LogRow>
          columns={columns}
          data={rows}
          loading={loading}
          pageSize={PAGE_SIZE}
          emptyMessage={t('empty')}
        />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('pager_total', { total })}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              {t('pager_prev')}
            </Button>
            <span>{t('pager_position', { current: pageIndex + 1, total: Math.max(1, pageCount) })}</span>
            <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              {t('pager_next')}
            </Button>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
