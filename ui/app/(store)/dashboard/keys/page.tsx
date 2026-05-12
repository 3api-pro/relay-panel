'use client';
import { useEffect, useState } from 'react';
import { store, fmtDate } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Input, Alert, Modal, Badge, Spinner } from '@/components/store/ui';

interface Key {
  id: number | string;
  name: string;
  key_prefix?: string;
  key_masked?: string;
  status?: string;
  last_used_at?: string | null;
  created_at?: string;
  model_allowlist?: string[] | null;
}

function mask(s: string | undefined): string {
  if (!s) return '—';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export default function KeysPage() {
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">控制台</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <KeysInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function KeysInner() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [newName, setNewName] = useState('My Key');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<Key | null>(null);

  async function refresh() {
    try {
      const r = await store.listKeys();
      setKeys((r as any).data || []);
      setErr(null);
    } catch (e: any) {
      if (e?.status === 404) setKeys([]);
      else setErr(e?.message || '加载失败');
    }
  }
  useEffect(() => { refresh(); }, []);

  async function createKey() {
    setBusy(true);
    try {
      const r: any = await store.createKey(newName || 'My Key');
      const secret = r.key || r.secret || r.token || r.api_key;
      if (secret) setIssued(String(secret));
      setOpenCreate(false);
      setNewName('My Key');
      await refresh();
    } catch (e: any) {
      setErr(e?.message || '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke() {
    if (!revokeId) return;
    setBusy(true);
    try {
      await store.revokeKey(revokeId.id);
      setRevokeId(null);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || '撤销失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {issued && (
        <Alert kind="warn">
          <div className="font-medium">新 Key 已生成 (仅显示一次, 请复制保存)</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all bg-card border border-amber-300 px-2 py-1.5 rounded text-xs">{issued}</code>
            <Button size="sm" variant="ghost" onClick={() => {
              if (navigator?.clipboard) navigator.clipboard.writeText(issued).catch(() => {});
            }}>复制</Button>
            <Button size="sm" variant="subtle" onClick={() => setIssued(null)}>关闭</Button>
          </div>
        </Alert>
      )}

      {err && <Alert kind="error">{err}</Alert>}

      <Card title="API Keys"
        action={<Button onClick={() => setOpenCreate(true)} size="sm">+ 新建 Key</Button>}>
        {keys === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">加载中…</span>
          </div>
        ) : keys.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">还没有 API Key — 点击右上角生成第一个。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="pr-3 font-medium">Key</th>
                  <th className="pr-3 font-medium">状态</th>
                  <th className="pr-3 font-medium">最近使用</th>
                  <th className="pr-3 font-medium">创建</th>
                  <th className="font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-border/50">
                    <td className="py-3 pr-3">{k.name}</td>
                    <td className="pr-3">
                      <code className="text-xs text-muted-foreground">{k.key_masked || mask(k.key_prefix)}</code>
                    </td>
                    <td className="pr-3">
                      <Badge tone={k.status === 'active' || !k.status ? 'success' : 'neutral'}>
                        {k.status || 'active'}
                      </Badge>
                    </td>
                    <td className="pr-3 text-muted-foreground">{fmtDate(k.last_used_at)}</td>
                    <td className="pr-3 text-muted-foreground">{fmtDate(k.created_at)}</td>
                    <td>
                      <button onClick={() => setRevokeId(k)}
                        className="text-red-600 hover:underline text-xs">撤销</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="如何使用">
        <div className="text-sm text-foreground space-y-2">
          <p>把客户端的 baseUrl 指向本站, 用上面的 Key 作为 Authorization 头:</p>
          <pre className="bg-foreground text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST {your-domain}/v1/messages \\
  -H "Authorization: Bearer sk-xxxx" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`}</pre>
          <p>详见 <a href="/docs" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>API 文档</a>。</p>
        </div>
      </Card>

      <Modal open={openCreate} onClose={() => !busy && setOpenCreate(false)}
        title="新建 API Key"
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setOpenCreate(false)}>取消</Button>
          <Button onClick={createKey} disabled={busy}>{busy ? '创建中…' : '生成'}</Button>
        </>}>
        <Input label="名称" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Project" />
        <p className="text-xs text-muted-foreground mt-2">名称只是给你自己看的便签; 模型权限会继承当前订阅的套餐。</p>
      </Modal>

      <Modal open={!!revokeId} onClose={() => !busy && setRevokeId(null)}
        title={`确认撤销 "${revokeId?.name}"?`}
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setRevokeId(null)}>取消</Button>
          <Button variant="danger" onClick={doRevoke} disabled={busy}>{busy ? '撤销中…' : '确认撤销'}</Button>
        </>}>
        <p className="text-sm text-muted-foreground">撤销后该 Key 立即失效, 已发出的请求不受影响。此操作不可恢复。</p>
      </Modal>
    </div>
  );
}
