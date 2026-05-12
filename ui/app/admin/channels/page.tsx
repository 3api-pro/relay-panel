'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Modal } from '@/components/admin/Modal';
import { ChannelKeyRow, ChannelKey } from '@/components/admin/ChannelKeyRow';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api, auth } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Channel {
  id: number;
  name: string;
  base_url: string;
  type: string;
  status: string;
  weight: number;
  priority: number;
  is_default: boolean;
  models: string | null;
  group_access: string;
  key_preview: string | null;
  keys: ChannelKey[];
  keys_total: number;
  keys_active: number;
  current_key_idx: number;
  created_at: string;
}

const DEFAULT_FORM = {
  id: 0,
  name: '',
  base_url: 'https://api.llmapi.pro/v1',
  api_key: '',
  type: 'byok-claude',
};

const TYPES = [
  { v: 'byok-claude', label: 'BYOK Claude (Anthropic 兼容)' },
  { v: 'byok-openai-compat', label: 'BYOK OpenAI 兼容' },
  { v: 'byok-other', label: 'BYOK 其他' },
  { v: 'wholesale-3api', label: '3API Wholesale (我方批发)' },
];

export default function AdminChannelsPage() {
  const router = useRouter();
  const [list, setList] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [editing, setEditing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // add-key modal
  const [addKeyFor, setAddKeyFor] = useState<Channel | null>(null);
  const [newKey, setNewKey] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  // bulk replace modal
  const [bulkFor, setBulkFor] = useState<Channel | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (!auth.hasToken()) {
      router.push('/admin/login');
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setErr('');
    setLoading(true);
    try {
      const r = await api<{ data: Channel[] }>('/admin/channels');
      setList(r.data);
    } catch (e: any) {
      setErr(e.message);
      if (e.message.includes('401')) {
        auth.clearToken();
        router.push('/admin/login');
      }
    } finally {
      setLoading(false);
    }
  }

  function clearForm() {
    setForm({ ...DEFAULT_FORM });
    setEditing(false);
    setFormOpen(false);
    setMsg('');
    setErr('');
  }

  function startNew() {
    setForm({ ...DEFAULT_FORM });
    setEditing(false);
    setFormOpen(true);
    setMsg('');
    setErr('');
  }

  function startEdit(c: Channel) {
    setForm({ id: c.id, name: c.name, base_url: c.base_url, api_key: '', type: c.type });
    setEditing(true);
    setFormOpen(true);
    setMsg(`正在编辑 #${c.id}; api_key 留空则不变`);
    setErr('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      if (editing) {
        const body: any = { name: form.name, base_url: form.base_url, type: form.type };
        if (form.api_key) body.api_key = form.api_key;
        await api(`/admin/channels/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setMsg(`✓ 已更新 #${form.id}`);
      } else {
        const r = await api<Channel>('/admin/channels', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name,
            base_url: form.base_url,
            api_key: form.api_key,
            type: form.type,
          }),
        });
        setMsg(`✓ 已添加 #${r.id}`);
      }
      clearForm();
      refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(id: number) {
    setErr('');
    setMsg('');
    try {
      await api(`/admin/channels/${id}/set-default`, { method: 'POST' });
      setMsg(`✓ 已设 #${id} 为默认`);
      refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function remove(id: number) {
    if (!confirm(`确定删除 channel #${id}? 不可恢复。`)) return;
    setErr('');
    setMsg('');
    try {
      await api(`/admin/channels/${id}`, { method: 'DELETE' });
      setMsg(`✓ 已删除 #${id}`);
      refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function toggleExpand(id: number) {
    setExpanded((m) => ({ ...m, [id]: !m[id] }));
  }

  async function deleteKey(c: Channel, idx: number) {
    if (!confirm(`删除 channel #${c.id} 的第 ${idx} 个 key? 不可恢复。`)) return;
    try {
      await api(`/admin/channels/${c.id}/keys/${idx}`, { method: 'DELETE' });
      setMsg(`✓ 已删除 #${c.id} key #${idx}`);
      refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function submitAddKey() {
    if (!addKeyFor || !newKey || newKey.length < 8) return;
    setAddBusy(true);
    setErr('');
    try {
      await api(`/admin/channels/${addKeyFor.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ key: newKey }),
      });
      setMsg(`✓ 已为 #${addKeyFor.id} 添加 key`);
      setAddKeyFor(null);
      setNewKey('');
      refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setAddBusy(false);
    }
  }

  async function submitBulkReplace() {
    if (!bulkFor) return;
    const keys = bulkText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      if (!confirm('确定清空所有 key？(这会让该 channel 失效)')) return;
    }
    setBulkBusy(true);
    setErr('');
    try {
      await api(`/admin/channels/${bulkFor.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ keys }),
      });
      setMsg(`✓ #${bulkFor.id} 已替换为 ${keys.length} 个 key`);
      setBulkFor(null);
      setBulkText('');
      refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <AdminShell
      title="上游 Channel"
      subtitle="配上游 sk-key + base_url；同一 channel 可挂多 key 轮询"
      actions={
        <Button size="sm" onClick={startNew} className="gap-1">
          <Plus className="h-4 w-4" />
          添加 channel
        </Button>
      }
    >
      {/* status / errors */}
      {(msg || err) && (
        <div
          className={cn(
            'mb-4 px-4 py-2 rounded-md border text-sm',
            err
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {err || msg}
        </div>
      )}

      {/* edit/create modal */}
      <Modal
        open={formOpen}
        onClose={clearForm}
        title={editing ? `编辑 channel #${form.id}` : '添加 channel'}
        width="lg"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={clearForm}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={(e) => onSubmit(e as any)}
              disabled={busy || !form.name || !form.base_url || (!editing && !form.api_key)}
            >
              {busy ? '提交中…' : editing ? '保存修改' : '+ 添加'}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-1 space-y-1.5">
            <Label>名称</Label>
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例: 主上游"
            />
          </div>
          <div className="col-span-1 space-y-1.5">
            <Label>类型</Label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {TYPES.map((t) => (
                <option key={t.v} value={t.v}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>Base URL</Label>
            <Input
              type="url"
              required
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.llmapi.pro/v1"
              className="font-mono text-sm"
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>
              API Key{' '}
              {editing && (
                <span className="text-xs text-muted-foreground font-normal">
                  (留空 = 不修改；新增更多 key 可在保存后在 channel 行展开添加)
                </span>
              )}
            </Label>
            <Input
              type="password"
              required={!editing}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="sk-..."
              className="font-mono text-sm"
              minLength={editing ? 0 : 8}
            />
          </div>
          {/* hidden submit to enable Enter-key submit */}
          <button type="submit" className="hidden" />
        </form>
      </Modal>

      {/* channel list */}
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            暂无 channel。点右上 + 添加一个上游，客户的 /v1/messages 才能转发。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((c) => {
            const isOpen = expanded[c.id] || false;
            return (
              <Card key={c.id} className="overflow-hidden">
                <CardHeader className="py-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => toggleExpand(c.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={isOpen ? '收起' : '展开'}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                    <CardTitle className="text-base">{c.name}</CardTitle>
                    {c.is_default && (
                      <Badge variant="default" className="h-5 text-[10px]">
                        默认
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-5 text-[10px]',
                        c.status === 'active'
                          ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                          : 'border-muted text-muted-foreground',
                      )}
                    >
                      {c.status}
                    </Badge>
                    <Badge variant="secondary" className="h-5 text-[10px]">
                      {c.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      key {c.keys_active}/{c.keys_total} · 当前 #
                      {c.current_key_idx ?? 0}
                    </span>
                    <div className="flex-1" />
                    <div className="flex items-center gap-1.5 text-xs">
                      {!c.is_default && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => setDefault(c.id)}
                        >
                          设为默认
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => startEdit(c)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-rose-600 hover:bg-rose-500/10"
                        onClick={() => remove(c.id)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="font-mono text-xs ml-7 pt-1">
                    {c.base_url}
                  </CardDescription>
                </CardHeader>
                {isOpen && (
                  <CardContent className="pt-0 pb-4">
                    <div className="ml-7 space-y-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          上游 keys ({c.keys?.length ?? 0})
                        </span>
                        <div className="flex-1" />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 gap-1"
                          onClick={() => {
                            setAddKeyFor(c);
                            setNewKey('');
                          }}
                        >
                          <Plus className="h-3 w-3" />
                          添加 key
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2"
                          onClick={() => {
                            setBulkFor(c);
                            setBulkText('');
                          }}
                        >
                          批量替换
                        </Button>
                      </div>
                      {(!c.keys || c.keys.length === 0) && (
                        <div className="text-xs text-muted-foreground italic px-3 py-2">
                          该 channel 没有 key（仅遗留 api_key 字段{' '}
                          {c.key_preview ?? '—'}，建议添加新 key）
                        </div>
                      )}
                      <div className="space-y-1.5">
                        {c.keys?.map((k, idx) => (
                          <ChannelKeyRow
                            key={idx}
                            idx={idx}
                            current={idx === (c.current_key_idx ?? 0)}
                            k={k}
                            onDelete={() => deleteKey(c, idx)}
                          />
                        ))}
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Add-key modal */}
      <Modal
        open={addKeyFor != null}
        onClose={() => {
          setAddKeyFor(null);
          setNewKey('');
        }}
        title={addKeyFor ? `为 ${addKeyFor.name} 添加新 key` : ''}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAddKeyFor(null);
                setNewKey('');
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={submitAddKey}
              disabled={addBusy || newKey.length < 8}
            >
              {addBusy ? '提交中…' : '+ 添加'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label>新 key (≥8 字符)</Label>
          <Input
            type="password"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="sk-..."
            className="font-mono"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            添加后立即生效，加入轮询池。状态默认 active。
          </p>
        </div>
      </Modal>

      {/* Bulk-replace modal */}
      <Modal
        open={bulkFor != null}
        onClose={() => {
          setBulkFor(null);
          setBulkText('');
        }}
        title={bulkFor ? `批量替换 ${bulkFor.name} 的 keys` : ''}
        width="lg"
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBulkFor(null);
                setBulkText('');
              }}
            >
              取消
            </Button>
            <Button size="sm" onClick={submitBulkReplace} disabled={bulkBusy}>
              {bulkBusy ? '替换中…' : '替换'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label>一行一个 key（空行忽略）</Label>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={10}
            placeholder={'sk-key1...\nsk-key2...\nsk-key3...'}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm font-mono"
          />
          <p className="text-xs text-rose-700 dark:text-rose-400">
            ⚠ 此操作会清空现有 keys[] 并替换为上面的列表（按顺序）。current_key_idx
            会重置为 0。
          </p>
        </div>
      </Modal>
    </AdminShell>
  );
}
