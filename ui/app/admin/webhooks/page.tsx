'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Modal } from '@/components/admin/Modal';
import { api, safe, fmtDate } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';
import { useRouter } from 'next/navigation';

interface Webhook {
  id: number;
  url: string;
  events: string[];
  enabled: boolean;
  last_triggered_at: string | null;
  fail_count_total: number;
  delivery_count: number;
  success_count: number;
  created_at: string;
}

interface Delivery {
  id: number;
  event_type: string;
  status: string;
  http_status: number | null;
  response_excerpt: string | null;
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
}

function statusBadge(s: string) {
  const m: Record<string, string> = {
    success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    pending: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
    failed: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    exhausted: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  };
  const cls = m[s] || 'bg-muted text-muted-foreground';
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{s}</span>;
}

export default function WebhooksPage() {
  const t = useTranslations('admin.webhooks');
  const router = useRouter();
  const [rows, setRows] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<Webhook | null>(null);
  const [history, setHistory] = useState<{ hook: Webhook; data: Delivery[] } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setErr('');
    try {
      const r = await safe(api<{ data: Webhook[] }>('/admin/webhooks'), { data: [] });
      setRows(r.data || []);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function toggleEnabled(w: Webhook) {
    try {
      await api(`/admin/webhooks/${w.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      refresh();
    } catch (e: any) {
      alert(`${t('alert_update_failed_prefix')}${e.message}`);
    }
  }

  async function fireTest(w: Webhook) {
    setTesting(w.id);
    setTestResult(null);
    try {
      const r = await api<{ delivery: Delivery }>(`/admin/webhooks/${w.id}/test`, {
        method: 'POST',
      });
      const d = r.delivery;
      if (d.status === 'success') {
        setTestResult(t('test_ok', { http: d.http_status ?? '—' }));
      } else {
        setTestResult(
          t('test_failed', {
            status: d.status,
            http: d.http_status ?? '—',
            body: d.response_excerpt ?? '',
          }),
        );
      }
      refresh();
    } catch (e: any) {
      setTestResult(`${t('test_error_prefix')}${e.message}`);
    } finally {
      setTesting(null);
    }
  }

  async function doDelete() {
    if (!confirmDel) return;
    try {
      await api(`/admin/webhooks/${confirmDel.id}`, { method: 'DELETE' });
      setConfirmDel(null);
      refresh();
    } catch (e: any) {
      alert(`${t('alert_delete_failed_prefix')}${e.message}`);
    }
  }

  async function viewHistory(w: Webhook) {
    setHistory({ hook: w, data: [] });
    setHistoryLoading(true);
    try {
      const r = await api<{ data: Delivery[] }>(`/admin/webhooks/${w.id}/deliveries?limit=50`);
      setHistory({ hook: w, data: r.data || [] });
    } catch (e: any) {
      setHistory({ hook: w, data: [] });
      alert(`${t('alert_history_failed_prefix')}${e.message}`);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <AdminShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
          </div>
          <Button onClick={() => router.push('/admin/webhooks/new')}>{t('add_button')}</Button>
        </div>

        {testResult && (
          <div className="text-sm bg-card border border-border rounded-md px-3 py-2 flex items-center justify-between">
            <span>{testResult}</span>
            <button className="text-xs text-muted-foreground" onClick={() => setTestResult(null)}>{t('close')}</button>
          </div>
        )}

        {err && (
          <div className="text-sm text-rose-600 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
            {err}
          </div>
        )}

        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">{t('col_id')}</TableHead>
                <TableHead>{t('col_url')}</TableHead>
                <TableHead>{t('col_events')}</TableHead>
                <TableHead>{t('col_status')}</TableHead>
                <TableHead>{t('col_last_triggered')}</TableHead>
                <TableHead>{t('col_stats')}</TableHead>
                <TableHead className="w-72 text-right">{t('col_actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">{t('loading')}</TableCell></TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">{t('empty_rows')}</TableCell></TableRow>
              )}
              {rows.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="text-xs text-muted-foreground">{w.id}</TableCell>
                  <TableCell>
                    <code className="text-xs break-all">{w.url}</code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {w.events.map((e) => (
                        <Badge key={e} variant="secondary" className="text-xs">{e}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {w.enabled ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{t('badge_enabled')}</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">{t('badge_disabled')}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {w.last_triggered_at ? fmtDate(w.last_triggered_at) : t('last_triggered_never')}
                  </TableCell>
                  <TableCell className="text-xs">
                    {w.success_count}/{w.delivery_count}{t('stats_success_suffix')}
                    {w.fail_count_total > 0 && (
                      <div className="text-rose-600">{t('stats_failed_prefix')}{w.fail_count_total}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => fireTest(w)} disabled={testing === w.id}>
                      {testing === w.id ? t('btn_test_busy') : t('btn_test')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => viewHistory(w)}>{t('btn_history')}</Button>
                    <Button size="sm" variant="outline" onClick={() => toggleEnabled(w)}>
                      {w.enabled ? t('btn_disable') : t('btn_enable')}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setConfirmDel(w)}>{t('btn_delete')}</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Modal
          open={!!confirmDel}
          onClose={() => setConfirmDel(null)}
          title={t('delete_modal_title')}
        >
          <div className="space-y-4">
            <p className="text-sm">
              {t('delete_confirm_prefix')}<code className="text-xs">{confirmDel?.url}</code>{t('delete_confirm_suffix')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDel(null)}>{t('delete_cancel')}</Button>
              <Button variant="destructive" onClick={doDelete}>{t('delete_confirm')}</Button>
            </div>
          </div>
        </Modal>

        <Modal
          open={!!history}
          onClose={() => setHistory(null)}
          title={`${t('history_modal_title_prefix')}${history?.hook.url ?? ''}`}
        >
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {historyLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
            {!historyLoading && history && history.data.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('empty_history')}</p>
            )}
            {!historyLoading && history && history.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_events')}</TableHead>
                    <TableHead>{t('col_status')}</TableHead>
                    <TableHead>{t('col_http')}</TableHead>
                    <TableHead>{t('col_attempts')}</TableHead>
                    <TableHead>{t('col_time')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs"><code>{d.event_type}</code></TableCell>
                      <TableCell>{statusBadge(d.status)}</TableCell>
                      <TableCell className="text-xs">{d.http_status ?? '—'}</TableCell>
                      <TableCell className="text-xs">{d.attempts}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(d.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Modal>
      </div>
    </AdminShell>
  );
}
