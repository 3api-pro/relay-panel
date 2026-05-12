'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';

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
  { v: 'byok-claude',         label: 'BYOK Claude (Anthropic 兼容)' },
  { v: 'byok-openai-compat',  label: 'BYOK OpenAI 兼容' },
  { v: 'byok-other',          label: 'BYOK 其他' },
  { v: 'wholesale-3api',      label: '3API Wholesale (我方批发)' },
];

export default function AdminChannelsPage() {
  const router = useRouter();
  const [list, setList] = useState<Channel[]>([]);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!auth.hasToken()) { router.push('/admin/login'); return; }
    refresh();
  }, []);

  async function refresh() {
    setErr('');
    try {
      const r = await api<{ data: Channel[] }>('/admin/channels');
      setList(r.data);
    } catch (e: any) {
      setErr(e.message);
      if (e.message.includes('401')) { auth.clearToken(); router.push('/admin/login'); }
    }
  }

  function clearForm() {
    setForm({ ...DEFAULT_FORM });
    setEditing(false);
    setMsg(''); setErr('');
  }

  function startEdit(c: Channel) {
    setForm({ id: c.id, name: c.name, base_url: c.base_url, api_key: '', type: c.type });
    setEditing(true);
    setMsg(`正在编辑 #${c.id}; api_key 留空则不变`);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(''); setMsg('');
    try {
      if (editing) {
        const body: any = {
          name: form.name,
          base_url: form.base_url,
          type: form.type,
        };
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
    setErr(''); setMsg('');
    try {
      await api(`/admin/channels/${id}/set-default`, { method: 'POST' });
      setMsg(`✓ 已设 #${id} 为默认`);
      refresh();
    } catch (e: any) { setErr(e.message); }
  }

  async function remove(id: number) {
    if (!confirm(`确定删除 channel #${id}? 不可恢复。`)) return;
    setErr(''); setMsg('');
    try {
      await api(`/admin/channels/${id}`, { method: 'DELETE' });
      setMsg(`✓ 已删除 #${id}`);
      refresh();
    } catch (e: any) { setErr(e.message); }
  }

  function logout() { auth.clearToken(); router.push('/'); }

  return (
    <main className="min-h-screen bg-muted">
      <header className="bg-accent text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold">3API Admin</div>
          <nav className="flex items-center gap-5 text-sm">
            <a href="/admin/dashboard/" className="hover:text-amber-400">客户</a>
            <a href="/admin/channels/" className="text-amber-400">上游 Channel</a>
            <button onClick={logout} className="hover:text-amber-400">退出</button>
          </nav>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">上游 Channel</h1>
          <p className="text-sm text-muted-foreground mt-1">
            配上游 sk-key + base_url, 默认 channel 用于客户调 /v1/messages 转发。
            一个 tenant 可配多个, 切换默认即可换上游。
          </p>
        </div>

        <section className="bg-card rounded-lg border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">{editing ? `编辑 channel #${form.id}` : '添加 channel'}</h2>
            {editing && (
              <button onClick={clearForm} className="text-sm text-muted-foreground hover:text-foreground">
                取消编辑
              </button>
            )}
          </div>
          <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
            <label className="block col-span-1">
              <div className="text-sm font-medium text-foreground mb-1">名称</div>
              <input
                type="text" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例: 主上游"
                className="w-full px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none"
              />
            </label>
            <label className="block col-span-1">
              <div className="text-sm font-medium text-foreground mb-1">类型</div>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none"
              >
                {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </label>
            <label className="block col-span-2">
              <div className="text-sm font-medium text-foreground mb-1">Base URL</div>
              <input
                type="url" required value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.llmapi.pro/v1"
                className="w-full px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none font-mono text-sm"
              />
            </label>
            <label className="block col-span-2">
              <div className="text-sm font-medium text-foreground mb-1">
                API Key {editing && <span className="text-xs text-muted-foreground">(留空 = 不修改)</span>}
              </div>
              <input
                type="password" required={!editing} value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder="sk-..."
                className="w-full px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none font-mono text-sm"
                minLength={editing ? 0 : 8}
              />
            </label>
            <div className="col-span-2 flex items-center justify-between">
              <div className="text-sm">
                {msg && <span className="text-emerald-600">{msg}</span>}
                {err && <span className="text-red-600">{err}</span>}
              </div>
              <button
                type="submit" disabled={busy}
                className="px-5 py-2 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? '提交中…' : editing ? '保存修改' : '+ 添加 channel'}
              </button>
            </div>
          </form>
        </section>

        <section className="bg-card rounded-lg border border-border">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-semibold">已配置 ({list.length})</h2>
          </div>
          {list.length === 0 ? (
            <div className="px-6 py-12 text-center text-muted-foreground text-sm">
              暂无 channel。添加一个上游, 客户的 /v1/messages 才能转发。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-4 py-2">默认</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>Base URL</th>
                  <th>Key</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className="px-4 py-3">
                      {c.is_default ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">默认</span>
                      ) : (
                        <button onClick={() => setDefault(c.id)} className="text-xs text-brand-600 hover:underline">设为默认</button>
                      )}
                    </td>
                    <td className="font-medium">{c.name}</td>
                    <td className="text-muted-foreground">{c.type}</td>
                    <td className="font-mono text-xs text-muted-foreground">{c.base_url}</td>
                    <td className="font-mono text-xs text-muted-foreground">{c.key_preview ?? '—'}</td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded ${c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="space-x-2 whitespace-nowrap">
                      <button onClick={() => startEdit(c)} className="text-brand-600 hover:underline text-xs">编辑</button>
                      <button onClick={() => remove(c.id)} className="text-red-600 hover:underline text-xs">删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
