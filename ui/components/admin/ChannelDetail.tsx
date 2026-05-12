'use client';
import { useEffect, useState } from 'react';
import { Plus, Trash2, X, Pencil, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Modal } from '@/components/admin/Modal';
import { ChannelKeyRow, ChannelKey } from '@/components/admin/ChannelKeyRow';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// Provider type taxonomy mirrors src/services/upstream.ts. Adapter status
// reflects v0.3 scope: anthropic / llmapi-wholesale / openai work; custom
// passes through; the rest are stubs that ship in v0.4.
export const PROVIDER_TYPES: Array<{
  v: string;
  label: string;
  status: 'live' | 'stub' | 'passthrough';
  doc: string;
}> = [
  { v: 'llmapi-wholesale', label: 'llmapi.pro Wholesale  (推荐)', status: 'live', doc: 'Anthropic 兼容协议，我方批发' },
  { v: 'anthropic',        label: 'Anthropic 直连',                status: 'live', doc: '官方 /v1/messages 兼容' },
  { v: 'openai',           label: 'OpenAI 兼容',                   status: 'live', doc: '/v1/chat/completions; 非流式自动适配' },
  { v: 'custom',           label: '自定义 (Passthrough)',          status: 'passthrough', doc: '原样转发到 base_url + custom_headers' },
  { v: 'gemini',           label: 'Google Gemini',                 status: 'stub', doc: 'v0.4 上线' },
  { v: 'moonshot',         label: 'Moonshot Kimi',                 status: 'stub', doc: 'v0.4 上线' },
  { v: 'deepseek',         label: 'DeepSeek',                      status: 'stub', doc: 'v0.4 上线' },
  { v: 'minimax',          label: 'MiniMax',                       status: 'stub', doc: 'v0.4 上线' },
  { v: 'qwen',             label: 'Qwen / Tongyi',                 status: 'stub', doc: 'v0.4 上线' },
];

export interface ChannelFull {
  id: number;
  name: string;
  base_url: string;
  type: string;
  status: string;
  weight: number;
  priority: number;
  is_default: boolean;
  models: string | null;
  model_mapping?: Record<string, string> | null;
  custom_headers?: Record<string, string> | null;
  group_access: string;
  key_preview: string | null;
  keys: ChannelKey[];
  keys_total: number;
  keys_active: number;
  current_key_idx: number;
  // v0.3 new fields
  provider_type: string;
  enabled: boolean;
  is_recommended: boolean;
  last_tested_at?: string | null;
  last_test_result?: { ok: boolean; latency_ms?: number; status?: number; error?: string; models?: string[] } | null;
  created_at: string;
}

interface Props {
  channel: ChannelFull;
  onChange: () => Promise<void>;
  onClose: () => void;
}

export function ChannelDetail({ channel, onChange, onClose }: Props) {
  // Local edit buffer — only flushed to the server on "保存".
  const [form, setForm] = useState({
    name: channel.name,
    base_url: channel.base_url,
    provider_type: channel.provider_type,
    type: channel.type,
    weight: channel.weight,
    priority: channel.priority,
    enabled: channel.enabled,
    models: channel.models ?? '',
  });
  // Pair editors for model_mapping + custom_headers. We keep them as
  // arrays of [k, v] tuples so the UI can render in stable order.
  const [mappingPairs, setMappingPairs] = useState<Array<[string, string]>>(
    Object.entries(channel.model_mapping || {}),
  );
  const [headerPairs, setHeaderPairs] = useState<Array<[string, string]>>(
    Object.entries(channel.custom_headers || {}),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Key management modals
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [newKey, setNewKey] = useState('');

  // Reset state when switching channels.
  useEffect(() => {
    setForm({
      name: channel.name,
      base_url: channel.base_url,
      provider_type: channel.provider_type,
      type: channel.type,
      weight: channel.weight,
      priority: channel.priority,
      enabled: channel.enabled,
      models: channel.models ?? '',
    });
    setMappingPairs(Object.entries(channel.model_mapping || {}));
    setHeaderPairs(Object.entries(channel.custom_headers || {}));
    setMsg('');
    setErr('');
  }, [channel.id, channel.name, channel.base_url, channel.provider_type, channel.type, channel.weight, channel.priority, channel.enabled, channel.models, channel.model_mapping, channel.custom_headers]);

  function pairsToObject(pairs: Array<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of pairs) {
      const key = k.trim();
      if (key) out[key] = v;
    }
    return out;
  }

  async function save() {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api(`/admin/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name,
          base_url: form.base_url,
          provider_type: form.provider_type,
          type: form.type,
          weight: Number(form.weight),
          priority: Number(form.priority),
          enabled: !!form.enabled,
          models: form.models || null,
          model_mapping: pairsToObject(mappingPairs),
          custom_headers: pairsToObject(headerPairs),
        }),
      });
      setMsg('已保存');
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function setDefault() {
    setErr('');
    setMsg('');
    try {
      await api(`/admin/channels/${channel.id}/set-default`, { method: 'POST' });
      setMsg('已设为默认');
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function test() {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      const r = await api<any>(`/admin/channels/${channel.id}/test`, { method: 'POST' });
      if (r.ok) {
        setMsg(`连接 OK · ${r.latency_ms ?? '-'}ms${r.status ? ` (HTTP ${r.status})` : ''}`);
      } else {
        setErr(`连接失败: ${r.error || r.category || '未知'}`);
      }
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (channel.is_default) {
      setErr('不能删除默认 channel — 先把别的设为默认');
      return;
    }
    if (!confirm(`确定删除 channel #${channel.id} (${channel.name})？此操作不可恢复。`)) return;
    try {
      await api(`/admin/channels/${channel.id}`, { method: 'DELETE' });
      await onChange();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function addKey() {
    if (!newKey || newKey.length < 8) {
      setErr('key 至少 8 个字符');
      return;
    }
    try {
      await api(`/admin/channels/${channel.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ key: newKey }),
      });
      setNewKey('');
      setAddKeyOpen(false);
      setMsg('已添加 key');
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function deleteKey(idx: number) {
    if (!confirm(`删除 channel #${channel.id} 的第 ${idx} 个 key？`)) return;
    try {
      await api(`/admin/channels/${channel.id}/keys/${idx}`, { method: 'DELETE' });
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const provInfo = PROVIDER_TYPES.find((p) => p.v === form.provider_type);

  return (
    <Card className="sticky top-4">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              <Pencil className="w-4 h-4 text-muted-foreground" />
              <span className="truncate">{channel.name}</span>
              {channel.is_recommended && (
                <Badge variant="default" className="h-5 text-[10px] bg-brand-600 text-white">
                  推荐
                </Badge>
              )}
              {channel.is_default && <Badge variant="outline" className="h-5 text-[10px]">默认</Badge>}
            </CardTitle>
            <CardDescription className="text-xs font-mono mt-1 truncate">
              #{channel.id} · {channel.base_url}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {(msg || err) && (
          <div
            className={cn(
              'px-3 py-2 rounded-md border text-sm',
              err
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
            )}
          >
            {err || msg}
          </div>
        )}

        {/* Provider type */}
        <Field label="Provider type" hint={provInfo?.doc}>
          <select
            value={form.provider_type}
            onChange={(e) => setForm({ ...form, provider_type: e.target.value })}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {PROVIDER_TYPES.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
                {p.status === 'stub' ? ' [v0.4]' : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* Name + base_url */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-9"
            />
          </Field>
          <Field label="Legacy type">
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="wholesale-3api">wholesale-3api</option>
              <option value="byok-claude">byok-claude</option>
              <option value="byok-openai-compat">byok-openai-compat</option>
              <option value="byok-other">byok-other</option>
            </select>
          </Field>
        </div>
        <Field label="Base URL">
          <Input
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            className="h-9 font-mono text-sm"
          />
        </Field>

        {/* Weight + priority + enabled */}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Weight">
            <Input
              type="number"
              value={form.weight}
              onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
              className="h-9"
            />
          </Field>
          <Field label="Priority">
            <Input
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              className="h-9"
            />
          </Field>
          <Field label="Enabled">
            <div className="flex items-center gap-2 h-9">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: !!v })}
              />
              <span className="text-xs text-muted-foreground">
                {form.enabled ? '路由' : '已关闭'}
              </span>
            </div>
          </Field>
        </div>

        {/* Models allowlist */}
        <Field
          label="Models allowlist"
          hint="逗号分隔；为空 = 不限制。例: claude-sonnet-4-7,claude-opus-4-7"
        >
          <Input
            value={form.models}
            onChange={(e) => setForm({ ...form, models: e.target.value })}
            className="h-9 font-mono text-xs"
            placeholder="claude-sonnet-4-7,claude-opus-4-7"
          />
        </Field>

        {/* Model mapping editor */}
        <PairEditor
          label="Model mapping"
          hint="把客户请求的 model 改写成上游真实 model 名"
          pairs={mappingPairs}
          setPairs={setMappingPairs}
          placeholderKey="claude-sonnet-4-7"
          placeholderVal="claude-3-5-sonnet-20241022"
        />

        {/* Custom headers editor */}
        <PairEditor
          label="Custom headers"
          hint="合并到出站请求的 HTTP header"
          pairs={headerPairs}
          setPairs={setHeaderPairs}
          placeholderKey="anthropic-beta"
          placeholderVal="prompt-caching-2024-07-31"
        />

        {/* Keys management — embedded v0.2 multi-key UI */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Keys ({channel.keys_active ?? 0}/{channel.keys_total ?? 0})
            </Label>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              onClick={() => setAddKeyOpen(true)}
            >
              <Plus className="w-3 h-3" />
              添加 key
            </Button>
          </div>
          <div className="space-y-1.5">
            {channel.keys?.length ? (
              channel.keys.map((k, idx) => (
                <ChannelKeyRow
                  key={idx}
                  idx={idx}
                  current={idx === (channel.current_key_idx ?? 0)}
                  k={k}
                  onDelete={() => deleteKey(idx)}
                />
              ))
            ) : (
              <p className="text-xs text-muted-foreground italic px-3 py-2">
                该 channel 还没有 key (legacy api_key={channel.key_preview ?? '—'})
              </p>
            )}
          </div>
        </div>

        {/* Last test result */}
        {channel.last_test_result && (
          <div className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              {channel.last_test_result.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-rose-600" />
              )}
              <span className="text-muted-foreground">最近一次测试:</span>
              <span>
                {channel.last_test_result.ok ? 'OK' : 'FAIL'}
                {channel.last_test_result.latency_ms != null && ` · ${channel.last_test_result.latency_ms}ms`}
                {channel.last_test_result.status != null && ` · HTTP ${channel.last_test_result.status}`}
              </span>
              {channel.last_tested_at && (
                <span className="text-muted-foreground ml-auto">
                  {new Date(channel.last_tested_at).toLocaleString('zh-CN', { hour12: false })}
                </span>
              )}
            </div>
            {channel.last_test_result.error && (
              <p className="mt-1 text-rose-700 dark:text-rose-400 font-mono">{channel.last_test_result.error}</p>
            )}
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={busy} className="gap-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />
            测试连接
          </Button>
          {!channel.is_default && (
            <Button size="sm" variant="outline" onClick={setDefault}>
              设为默认
            </Button>
          )}
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            className="text-rose-600 hover:bg-rose-500/10 gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除
          </Button>
        </div>
      </CardContent>

      {/* Add-key modal */}
      <Modal
        open={addKeyOpen}
        onClose={() => {
          setAddKeyOpen(false);
          setNewKey('');
        }}
        title={`为 ${channel.name} 添加新 key`}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setAddKeyOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={addKey} disabled={newKey.length < 8}>
              添加
            </Button>
          </>
        }
      >
        <Label>新 key (≥8 字符)</Label>
        <Input
          type="password"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="sk-..."
          className="font-mono mt-1.5"
          autoFocus
        />
      </Modal>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PairEditor({
  label,
  hint,
  pairs,
  setPairs,
  placeholderKey,
  placeholderVal,
}: {
  label: string;
  hint?: string;
  pairs: Array<[string, string]>;
  setPairs: (p: Array<[string, string]>) => void;
  placeholderKey: string;
  placeholderVal: string;
}) {
  function update(idx: number, k: string, v: string) {
    const next = pairs.slice();
    next[idx] = [k, v];
    setPairs(next);
  }
  function remove(idx: number) {
    const next = pairs.slice();
    next.splice(idx, 1);
    setPairs(next);
  }
  function add() {
    setPairs([...pairs, ['', '']]);
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button size="sm" variant="ghost" className="h-6 gap-1 text-xs" onClick={add}>
          <Plus className="w-3 h-3" />
          添加
        </Button>
      </div>
      {pairs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">无</p>
      ) : (
        <div className="space-y-1.5">
          {pairs.map(([k, v], idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => update(idx, e.target.value, v)}
                placeholder={placeholderKey}
                className="h-8 font-mono text-xs"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <Input
                value={v}
                onChange={(e) => update(idx, k, e.target.value)}
                placeholder={placeholderVal}
                className="h-8 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-500/10 shrink-0"
                onClick={() => remove(idx)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
