'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Star, Activity, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Modal } from '@/components/admin/Modal';
import { ChannelHero } from '@/components/admin/ChannelHero';
import { ChannelDetail, ChannelFull, PROVIDER_TYPES } from '@/components/admin/ChannelDetail';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, auth } from '@/lib/api';
import { formatTestError } from '@/lib/format-test-error';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/lib/i18n';

/**
 * v0.3 channel admin — Hero card + master/detail.
 *
 * Top: ChannelHero ("使用推荐 — llmapi.pro wholesale baked").
 * Below: left column = channel list (compact rows), right column = the
 * currently selected channel's detail/editor. On narrow viewports the
 * detail panel becomes a modal so we don't lose the list.
 */
export default function AdminChannelsPage() {
  const router = useRouter();
  const [list, setList] = useState<ChannelFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const t = useTranslations('admin.channels');
  const tCommon = useTranslations('common');

  // New-channel modal
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState({
    name: '',
    base_url: 'https://llmapi.pro/v1',
    api_key: '',
    provider_type: 'llmapi-wholesale',
    type: 'wholesale-3api',
  });
  const [newBusy, setNewBusy] = useState(false);

  useEffect(() => {
    if (!auth.hasToken()) {
      router.push('/admin/login');
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh(): Promise<void> {
    setErr('');
    setLoading(true);
    try {
      const r = await api<{ data: ChannelFull[] }>('/admin/channels');
      setList(r.data);
      // Keep current selection if it still exists.
      if (selectedId != null && !r.data.find((c) => c.id === selectedId)) {
        setSelectedId(null);
      }
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

  async function createChannel() {
    setNewBusy(true);
    setErr('');
    try {
      const r = await api<ChannelFull>('/admin/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: newForm.name,
          base_url: newForm.base_url,
          api_key: newForm.api_key,
          provider_type: newForm.provider_type,
          type: newForm.type,
        }),
      });
      setMsg(`${t('added_prefix')}${r.id} · ${t('auto_testing')}`);
      setNewOpen(false);
      setNewForm({ name: '', base_url: 'https://llmapi.pro/v1', api_key: '', provider_type: 'llmapi-wholesale', type: 'wholesale-3api' });
      await refresh();
      setSelectedId(r.id);

      // Auto-test the freshly created channel so the user immediately knows
      // whether the key/url actually works — no "now go hunt for the test
      // button" step. Swallow errors: the row already exists, this is a
      // best-effort confirmation.
      try {
        const tr = await api<any>(`/admin/channels/${r.id}/test`, { method: 'POST' });
        if (tr.ok) {
          setMsg(`${t('added_prefix')}${r.id} · ${t('test_ok_with_latency', { latency: tr.latency_ms ?? '-' })}`);
        } else {
          setErr(`${t('added_prefix')}${r.id} · ${t('test_fail_prefix')}${formatTestError(tr, t)}`);
          setMsg('');
        }
        await refresh();
      } catch { /* channel exists; auto-test failed to dispatch — non-fatal */ }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setNewBusy(false);
    }
  }

  async function testFromHero(channelId: number): Promise<void> {
    try {
      const r = await api<any>(`/admin/channels/${channelId}/test`, { method: 'POST' });
      setMsg(r.ok ? t('test_ok_with_latency', { latency: r.latency_ms ?? '-' }) : t('test_fail_prefix') + formatTestError(r, t));
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  // The currently-selected channel (always re-derived from `list` so edits
  // propagate without a re-select).
  const selected = selectedId != null ? list.find((c) => c.id === selectedId) ?? null : null;

  return (
    <AdminShell
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Button size="sm" onClick={() => setNewOpen(true)} className="gap-1" data-tour="channel-add">
          <Plus className="h-4 w-4" />
          {t('new_btn')}
        </Button>
      }
    >
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

      {/* Hero card — only renders when the tenant has a recommended channel. */}
      {!loading && <ChannelHero channels={list as any} onTest={testFromHero} />}

      {/* Master + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 space-y-2">
          {loading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)
          ) : list.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {t('empty_hint_prefix')} <b>{t('empty_hint_strong')}</b>{t('empty_hint_tail')}
              </CardContent>
            </Card>
          ) : (
            list.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                selected={c.id === selectedId}
                onSelect={() => setSelectedId(c.id)}
                onToggle={async (enabled) => {
                  try {
                    await api(`/admin/channels/${c.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ enabled }),
                    });
                    await refresh();
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
                onQuickTest={async () => {
                  try {
                    const r = await api<any>(`/admin/channels/${c.id}/test`, { method: 'POST' });
                    setMsg(r.ok ? t('test_row_ok', { id: c.id }) : t('test_row_fail_prefix', { id: c.id }) + formatTestError(r, t));
                    await refresh();
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
              />
            ))
          )}
        </div>
        <div className="lg:col-span-2">
          {selected ? (
            <ChannelDetail channel={selected} onChange={refresh} onClose={() => setSelectedId(null)} />
          ) : (
            <Card className="border-dashed">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {t('select_hint')}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* New-channel modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title={t('modal_new_title')}
        width="lg"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={createChannel}
              disabled={newBusy || !newForm.name || !newForm.base_url || !newForm.api_key}
            >
              {newBusy ? t('submit_create_busy') : t('submit_create')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5 col-span-1">
            <Label>{t('field_provider_type')}</Label>
            <select
              value={newForm.provider_type}
              onChange={(e) => {
                const v = e.target.value;
                const p = PROVIDER_TYPES.find((x) => x.v === v);
                setNewForm({
                  ...newForm,
                  provider_type: v,
                  type: v === 'llmapi-wholesale' ? 'wholesale-3api' : 'byok-claude',
                  base_url: p?.defaultBaseUrl ?? newForm.base_url,
                });
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {PROVIDER_TYPES.map((p) => (
                <option key={p.v} value={p.v}>
                  {p.label}{p.status === 'stub' ? ' [v0.4]' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{t('hint_provider_type')}</p>
          </div>
          <div className="space-y-1.5 col-span-1">
            <Label>{t('field_name')}</Label>
            <Input
              value={newForm.name}
              onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
              placeholder={t('ph_name')}
            />
            <p className="text-[11px] text-muted-foreground">{t('hint_name')}</p>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t('field_base_url')}</Label>
            <Input
              value={newForm.base_url}
              onChange={(e) => setNewForm({ ...newForm, base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-muted-foreground">{t('hint_base_url')}</p>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t('field_api_key')}</Label>
            <Input
              type="password"
              value={newForm.api_key}
              onChange={(e) => setNewForm({ ...newForm, api_key: e.target.value })}
              placeholder={t('ph_api_key')}
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-muted-foreground">{t('hint_api_key')}</p>
          </div>
        </div>
      </Modal>
    </AdminShell>
  );
}

// =========================================================================
// Channel row (left column)
// =========================================================================

function ChannelRow({
  channel,
  selected,
  onSelect,
  onToggle,
  onQuickTest,
}: {
  channel: ChannelFull;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onQuickTest: () => Promise<void>;
}) {
  const test = channel.last_test_result;
  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors',
        selected ? 'border-brand-500 bg-brand-50/40 dark:bg-brand-950/20' : 'hover:bg-muted/40',
      )}
      onClick={onSelect}
    >
      <CardContent className="py-3 px-3 flex items-center gap-3">
        <Switch
          checked={channel.enabled}
          onCheckedChange={(v) => {
            onToggle(!!v);
          }}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{channel.name}</span>
            {channel.is_recommended && (
              <Badge variant="default" className="h-4 text-[9px] bg-brand-600 text-white gap-0.5">
                <Star className="w-2.5 h-2.5 fill-current" />
                推荐
              </Badge>
            )}
            {channel.is_default && (
              <Badge variant="outline" className="h-4 text-[9px]">默认</Badge>
            )}
            <Badge variant="outline" className="h-4 text-[9px] font-mono">
              {channel.provider_type}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
            {channel.base_url}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-[11px] shrink-0">
          <div className="text-muted-foreground">
            key {channel.keys_active}/{channel.keys_total}
          </div>
          <div className="flex items-center gap-1">
            {test ? (
              test.ok ? (
                <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" />
                  {test.latency_ms != null ? `${test.latency_ms}ms` : 'ok'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-400">
                  <XCircle className="w-3 h-3" />
                  fail
                </span>
              )
            ) : (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                <Clock className="w-3 h-3" />
                未测
              </span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 gap-1 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onQuickTest();
          }}
        >
          <Activity className="w-3 h-3" />
          测试
        </Button>
      </CardContent>
    </Card>
  );
}
