'use client';
import { useEffect, useState } from 'react';
import { store, fmtDate } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Input, Alert, Modal, Badge, Spinner } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

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
  const t = useTranslations('storefront.keys');
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">{t('title')}</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <KeysInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function KeysInner() {
  const t = useTranslations('storefront.keys');
  const tCommon = useTranslations('common');
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
      else setErr(e?.message || t('load_failed'));
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
      setErr(e?.message || t('create_failed'));
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
      setErr(e?.message || t('revoke_failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {issued && (
        <Alert kind="warn">
          <div className="font-medium">{t('issued_title')}</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all bg-card border border-amber-300 px-2 py-1.5 rounded text-xs">{issued}</code>
            <Button size="sm" variant="ghost" onClick={() => {
              if (navigator?.clipboard) navigator.clipboard.writeText(issued).catch(() => {});
            }}>{t('copy')}</Button>
            <Button size="sm" variant="subtle" onClick={() => setIssued(null)}>{t('close')}</Button>
          </div>
        </Alert>
      )}

      {err && <Alert kind="error">{err}</Alert>}

      <Card title={t('card_title')}
        action={<Button onClick={() => setOpenCreate(true)} size="sm">{t('new_btn')}</Button>}>
        {keys === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">{t('loading_inline')}</span>
          </div>
        ) : keys.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">{t('empty_hint')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t('th_name')}</th>
                  <th className="pr-3 font-medium">{t('th_key')}</th>
                  <th className="pr-3 font-medium">{t('th_status')}</th>
                  <th className="pr-3 font-medium">{t('th_last_used')}</th>
                  <th className="pr-3 font-medium">{t('th_created')}</th>
                  <th className="font-medium">{t('th_actions')}</th>
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
                        {k.status || t('active_default')}
                      </Badge>
                    </td>
                    <td className="pr-3 text-muted-foreground">{fmtDate(k.last_used_at)}</td>
                    <td className="pr-3 text-muted-foreground">{fmtDate(k.created_at)}</td>
                    <td>
                      <button onClick={() => setRevokeId(k)}
                        className="text-red-600 hover:underline text-xs">{t('revoke_btn')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('card_howto')}>
        <div className="text-sm text-foreground space-y-2">
          <p>{t('howto_p1')}</p>
          <pre className="bg-foreground text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST {your-domain}/v1/messages \\
  -H "Authorization: Bearer sk-xxxx" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`}</pre>
          <p>{t('howto_docs_pre')}<a href="/docs" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('howto_docs_link')}</a>{t('howto_docs_post')}</p>
        </div>
      </Card>

      <Modal open={openCreate} onClose={() => !busy && setOpenCreate(false)}
        title={t('modal_new_title')}
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setOpenCreate(false)}>{tCommon('cancel')}</Button>
          <Button onClick={createKey} disabled={busy}>{busy ? t('submit_create_busy') : t('submit_create')}</Button>
        </>}>
        <Input label={t('field_name')} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('ph_name')} />
        <p className="text-xs text-muted-foreground mt-2">{t('name_hint')}</p>
      </Modal>

      <Modal open={!!revokeId} onClose={() => !busy && setRevokeId(null)}
        title={`${t('modal_revoke_title_pre')}${revokeId?.name ?? ''}${t('modal_revoke_title_suffix')}`}
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setRevokeId(null)}>{tCommon('cancel')}</Button>
          <Button variant="danger" onClick={doRevoke} disabled={busy}>{busy ? t('submit_revoke_busy') : t('submit_revoke')}</Button>
        </>}>
        <p className="text-sm text-muted-foreground">{t('revoke_body')}</p>
      </Modal>
    </div>
  );
}
