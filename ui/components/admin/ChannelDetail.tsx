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
import { formatTestError } from '@/lib/format-test-error';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/lib/i18n';

// Provider type taxonomy mirrors src/services/upstream.ts. Adapter status
// reflects v0.3 scope: anthropic / llmapi-wholesale / openai work; custom
// passes through; the rest are stubs that ship in v0.4. The `label` /
// `doc` fields fall back to the i18n table; the legacy literals here are
// kept as a defensive fallback for any consumer that doesn't have the
// translations loaded yet.
export const PROVIDER_TYPES: Array<{
  v: string;
  label: string;
  status: 'live' | 'stub' | 'passthrough';
  doc: string;
  labelKey?: string;
  docKey?: string;
  defaultBaseUrl?: string;
}> = [
  { v: 'llmapi-wholesale', label: 'llmapi.pro Wholesale  (推荐)', status: 'live', doc: 'Anthropic 兼容协议，我方批发', labelKey: 'provider_label_llmapi_wholesale', docKey: 'provider_doc_llmapi_wholesale', defaultBaseUrl: 'https://llmapi.pro/v1' },
  { v: 'anthropic',        label: 'Anthropic 直连',                status: 'live', doc: '官方 /v1/messages 兼容', labelKey: 'provider_label_anthropic', docKey: 'provider_doc_anthropic', defaultBaseUrl: 'https://api.anthropic.com' },
  { v: 'openai',           label: 'OpenAI 兼容',                   status: 'live', doc: '/v1/chat/completions; 非流式自动适配', labelKey: 'provider_label_openai', docKey: 'provider_doc_openai', defaultBaseUrl: 'https://api.openai.com/v1' },
  { v: 'custom',           label: '自定义 (Passthrough)',          status: 'passthrough', doc: '原样转发到 base_url + custom_headers', labelKey: 'provider_label_custom', docKey: 'provider_doc_custom' },
  { v: 'gemini',           label: 'Google Gemini',                 status: 'stub', doc: 'v0.4 上线', docKey: 'provider_doc_stub_v04', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { v: 'moonshot',         label: 'Moonshot Kimi',                 status: 'stub', doc: 'v0.4 上线', docKey: 'provider_doc_stub_v04', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { v: 'deepseek',         label: 'DeepSeek',                      status: 'stub', doc: 'v0.4 上线', docKey: 'provider_doc_stub_v04', defaultBaseUrl: 'https://api.deepseek.com' },
  { v: 'minimax',          label: 'MiniMax',                       status: 'stub', doc: 'v0.4 上线', docKey: 'provider_doc_stub_v04', defaultBaseUrl: 'https://api.minimax.chat/v1' },
  { v: 'qwen',             label: 'Qwen / Tongyi',                 status: 'stub', doc: 'v0.4 上线', docKey: 'provider_doc_stub_v04', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
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
  const t = useTranslations('admin.channel.detail');
  const tCommon = useTranslations('common');
  const tChannels = useTranslations('admin.channels');
  // Local edit buffer — only flushed to the server on save.
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
  // Most users never touch weight/priority/legacy-type/models/mapping/headers,
  // so we keep them collapsed and surface only the four fields that matter
  // (provider, name, base_url, enabled). But: when editing an existing channel
  // that ALREADY has non-default advanced values, auto-expand so a power user
  // sees their config without having to click. Pattern stolen from new-api's
  // hasAdvancedSettingsValues() — clean for new channels, frictionless for edits.
  // "Fill from upstream" — fetch /models live and merge into the allowlist.
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModelsPreview, setFetchedModelsPreview] = useState('');
  const hasAdvancedValues = (
    (channel.weight !== 100 && channel.weight !== 0) ||
    (channel.priority !== 100 && channel.priority !== 0 && channel.priority !== 1) ||
    !!channel.models ||
    !!(channel.model_mapping && Object.keys(channel.model_mapping).length > 0) ||
    !!(channel.custom_headers && Object.keys(channel.custom_headers).length > 0) ||
    (channel.type !== 'wholesale-3api' && channel.type !== 'byok-claude')
  );
  const [showAdvanced, setShowAdvanced] = useState(hasAdvancedValues);

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
      setMsg(t('saved_ok'));
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
      setMsg(t('set_default_ok'));
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
        const httpSuffix = r.status ? t('test_http_suffix', { status: r.status }) : '';
        setMsg(`${t('test_ok_prefix')}${r.latency_ms ?? '-'}ms${httpSuffix}`);
      } else {
        setErr(`${t('test_fail_prefix')}${formatTestError(r, tChannels)}`);
      }
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Call /fetch-models, write the result into the allowlist field, and
  // surface a one-line summary so the operator can sanity-check before
  // hitting Save. We replace whatever was in the field instead of merging;
  // anything the user typed manually was just a draft anyway.
  async function fetchModelsFromUpstream() {
    setFetchingModels(true);
    setMsg('');
    setErr('');
    setFetchedModelsPreview('');
    try {
      const r = await api<any>(`/admin/channels/${channel.id}/fetch-models`, { method: 'POST' });
      if (r.ok && Array.isArray(r.models) && r.models.length > 0) {
        setForm({ ...form, models: r.models.join(',') });
        setFetchedModelsPreview(
          tChannels('fetch_models_ok', {
            count: r.models.length,
            sample: r.models.slice(0, 3).join(', '),
          }),
        );
      } else {
        setErr(`${tChannels('fetch_models_fail_prefix')}${formatTestError(r, tChannels)}`);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setFetchingModels(false);
    }
  }

  async function remove() {
    if (channel.is_default) {
      setErr(t('delete_default_blocked'));
      return;
    }
    if (!confirm(`${t('delete_confirm_pre')}${channel.id}${t('delete_confirm_mid')}${channel.name}${t('delete_confirm_post')}`)) return;
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
      setErr(t('key_too_short'));
      return;
    }
    try {
      await api(`/admin/channels/${channel.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ key: newKey }),
      });
      setNewKey('');
      setAddKeyOpen(false);
      setMsg(t('key_added_ok'));
      await onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function deleteKey(idx: number) {
    if (!confirm(`${t('key_delete_confirm_pre')}${idx}${t('key_delete_confirm_mid')}${channel.id}${t('key_delete_confirm_suffix')}`)) return;
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
                  {t('badge_recommended')}
                </Badge>
              )}
              {channel.is_default && <Badge variant="outline" className="h-5 text-[10px]">{t('badge_default')}</Badge>}
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

        {/* ─── CORE (always visible) ─── */}

        {/* Provider type */}
        <Field label={t('field_provider_type')} hint={provInfo?.docKey ? t(provInfo.docKey) : provInfo?.doc}>
          <select
            value={form.provider_type}
            onChange={(e) => {
              const v = e.target.value;
              const p = PROVIDER_TYPES.find((x) => x.v === v);
              // Auto-fill base_url default + type alias when switching provider,
              // but only if the user hasn't customized them yet (keep their edits).
              const sameProviderDefault = PROVIDER_TYPES.find((x) => x.v === form.provider_type)?.defaultBaseUrl;
              const baseUrlIsDefault = !form.base_url || form.base_url === sameProviderDefault;
              setForm({
                ...form,
                provider_type: v,
                type: v === 'llmapi-wholesale' ? 'wholesale-3api' : 'byok-claude',
                base_url: baseUrlIsDefault && p?.defaultBaseUrl ? p.defaultBaseUrl : form.base_url,
              });
            }}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {PROVIDER_TYPES.map((p) => (
              <option key={p.v} value={p.v}>
                {p.labelKey ? t(p.labelKey) : p.label}
                {p.status === 'stub' ? t('stub_v04_suffix') : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* Name (full width — legacy_type moved to Advanced) */}
        <Field label={t('field_name')}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="h-9"
            placeholder={tChannels('ph_name')}
          />
        </Field>

        {/* Base URL */}
        <Field label={t('field_base_url')} hint={tChannels('hint_base_url')}>
          <Input
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            className="h-9 font-mono text-sm"
          />
        </Field>

        {/* Enabled switch — single field on its own row */}
        <Field label={t('field_enabled')}>
          <div className="flex items-center gap-2 h-9">
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: !!v })}
            />
            <span className="text-xs text-muted-foreground">
              {form.enabled ? t('enabled_on') : t('enabled_off')}
            </span>
          </div>
        </Field>

        {/* ─── ADVANCED (collapsed by default) ─── */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className={cn('inline-block transition-transform', showAdvanced && 'rotate-90')}>▸</span>
            {t('advanced_toggle')}
            <span className="text-[10px] text-muted-foreground/70">{t('advanced_hint')}</span>
          </button>

          {showAdvanced && (
            <div className="mt-3 pl-3 border-l-2 border-muted space-y-3">
              {/* Weight + priority + legacy_type */}
              <div className="grid grid-cols-3 gap-3">
                <Field label={t('field_weight')}>
                  <Input
                    type="number"
                    value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
                    className="h-9"
                  />
                </Field>
                <Field label={t('field_priority')}>
                  <Input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                    className="h-9"
                  />
                </Field>
                <Field label={t('field_legacy_type')}>
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

              {/* Models allowlist */}
              <Field label={t('field_models')} hint={t('models_hint')}>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={form.models}
                      onChange={(e) => setForm({ ...form, models: e.target.value })}
                      className="h-9 font-mono text-xs flex-1"
                      placeholder="claude-sonnet-4-7,claude-opus-4-7"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 gap-1 shrink-0"
                      onClick={fetchModelsFromUpstream}
                      disabled={fetchingModels || busy}
                    >
                      <RefreshCw className={cn('w-3.5 h-3.5', fetchingModels && 'animate-spin')} />
                      {fetchingModels ? tChannels('fetch_models_busy') : tChannels('fetch_models_btn')}
                    </Button>
                  </div>
                  {fetchedModelsPreview && (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                      {fetchedModelsPreview}
                    </p>
                  )}
                </div>
              </Field>

              {/* Model mapping editor */}
              <PairEditor
                label={t('field_model_mapping')}
                hint={t('model_mapping_hint')}
                pairs={mappingPairs}
                setPairs={setMappingPairs}
                placeholderKey="claude-sonnet-4-7"
                placeholderVal="claude-3-5-sonnet-20241022"
                addLabel={t('pair_add')}
                emptyLabel={t('pair_empty')}
              />

              {/* Custom headers editor */}
              <PairEditor
                label={t('field_custom_headers')}
                hint={t('custom_headers_hint')}
                pairs={headerPairs}
                setPairs={setHeaderPairs}
                placeholderKey="anthropic-beta"
                placeholderVal="prompt-caching-2024-07-31"
                addLabel={t('pair_add')}
                emptyLabel={t('pair_empty')}
              />
            </div>
          )}
        </div>

        {/* Keys management — embedded v0.2 multi-key UI */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('keys_label')} ({channel.keys_active ?? 0}/{channel.keys_total ?? 0})
            </Label>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              onClick={() => setAddKeyOpen(true)}
            >
              <Plus className="w-3 h-3" />
              {t('key_add_btn')}
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
                  onEdit={async (newKey) => {
                    await api(`/admin/channels/${channel.id}/keys/${idx}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ key: newKey }),
                    });
                    await onChange();
                  }}
                  onReveal={async () => {
                    try {
                      const r = await api<{ key: string }>(
                        `/admin/channels/${channel.id}/keys/${idx}/reveal`,
                      );
                      return r.key;
                    } catch {
                      return null;
                    }
                  }}
                />
              ))
            ) : (
              <p className="text-xs text-muted-foreground italic px-3 py-2">
                {t('key_empty_prefix')}{channel.key_preview ?? '—'}{t('key_empty_suffix')}
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
              <span className="text-muted-foreground">{t('last_test_label')}</span>
              <span>
                {channel.last_test_result.ok ? t('last_test_ok') : t('last_test_fail')}
                {channel.last_test_result.latency_ms != null && ` · ${channel.last_test_result.latency_ms}ms`}
                {channel.last_test_result.status != null && ` · HTTP ${channel.last_test_result.status}`}
              </span>
              {channel.last_tested_at && (
                <span className="text-muted-foreground ml-auto">
                  {new Date(channel.last_tested_at).toLocaleString('zh-CN', { hour12: false })}
                </span>
              )}
            </div>
            {!channel.last_test_result.ok && (
              <p className="mt-1 text-rose-700 dark:text-rose-400">{formatTestError(channel.last_test_result, tChannels)}</p>
            )}
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? t('save_busy') : t('save')}
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={busy} className="gap-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />
            {t('test_btn')}
          </Button>
          {!channel.is_default && (
            <Button size="sm" variant="outline" onClick={setDefault}>
              {t('set_default_btn')}
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
            {t('delete_btn')}
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
        title={`${t('key_addmodal_title_prefix')}${channel.name}${t('key_addmodal_title_suffix')}`}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setAddKeyOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button size="sm" onClick={addKey} disabled={newKey.length < 8}>
              {t('key_addmodal_submit')}
            </Button>
          </>
        }
      >
        <Label>{t('key_addmodal_label')}</Label>
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
  addLabel,
  emptyLabel,
}: {
  label: string;
  hint?: string;
  pairs: Array<[string, string]>;
  setPairs: (p: Array<[string, string]>) => void;
  placeholderKey: string;
  placeholderVal: string;
  addLabel?: string;
  emptyLabel?: string;
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
          {addLabel ?? 'Add'}
        </Button>
      </div>
      {pairs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">{emptyLabel ?? 'None'}</p>
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
