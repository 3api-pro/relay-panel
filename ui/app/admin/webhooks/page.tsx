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
      alert(`更新失败: ${e.message}`);
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
        setTestResult(`✔ 测试成功 (HTTP ${d.http_status})`);
      } else {
        setTestResult(`✘ 测试失败 (status=${d.status}, http=${d.http_status ?? '—'}, ${d.response_excerpt ?? ''})`);
      }
      refresh();
    } catch (e: any) {
      setTestResult(`✘ 错误: ${e.message}`);
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
      alert(`删除失败: ${e.message}`);
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
      alert(`读取历史失败: ${e.message}`);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <AdminShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Webhooks</h1>
            <p className="text-sm text-muted-foreground mt-1">
              订阅事件 (order.paid / subscription.expired / refund.processed / wholesale.low)
              到指定 URL。每条请求带 HMAC SHA256 签名 (X-3api-Signature)。
            </p>
          </div>
          <Button onClick={() => router.push('/admin/webhooks/new')}>+ 添加 Webhook</Button>
        </div>

        {testResult && (
          <div className="text-sm bg-card border border-border rounded-md px-3 py-2 flex items-center justify-between">
            <span>{testResult}</span>
            <button className="text-xs text-muted-foreground" onClick={() => setTestResult(null)}>关闭</button>
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
                <TableHead className="w-12">#</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>事件</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近触发</TableHead>
                <TableHead>统计</TableHead>
                <TableHead className="w-72 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">加载中...</TableCell></TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">还没有 webhook, 点上方按钮添加。</TableCell></TableRow>
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
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">启用</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">已停用</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {w.last_triggered_at ? fmtDate(w.last_triggered_at) : '从未'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {w.success_count}/{w.delivery_count} 成功
                    {w.fail_count_total > 0 && (
                      <div className="text-rose-600">失败 {w.fail_count_total}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => fireTest(w)} disabled={testing === w.id}>
                      {testing === w.id ? '测试中…' : '测试'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => viewHistory(w)}>历史</Button>
                    <Button size="sm" variant="outline" onClick={() => toggleEnabled(w)}>
                      {w.enabled ? '停用' : '启用'}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setConfirmDel(w)}>删除</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Modal
          open={!!confirmDel}
          onClose={() => setConfirmDel(null)}
          title="删除 Webhook"
        >
          <div className="space-y-4">
            <p className="text-sm">
              确认删除? URL <code className="text-xs">{confirmDel?.url}</code>。
              历史投递记录也会一并删除 (CASCADE)。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDel(null)}>取消</Button>
              <Button variant="destructive" onClick={doDelete}>确认删除</Button>
            </div>
          </div>
        </Modal>

        <Modal
          open={!!history}
          onClose={() => setHistory(null)}
          title={`历史投递 — ${history?.hook.url ?? ''}`}
        >
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {historyLoading && <p className="text-sm text-muted-foreground">加载中...</p>}
            {!historyLoading && history && history.data.length === 0 && (
              <p className="text-sm text-muted-foreground">暂无投递记录。</p>
            )}
            {!historyLoading && history && history.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>事件</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>尝试</TableHead>
                    <TableHead>时间</TableHead>
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
