'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminShell } from '@/components/admin/AdminShell';
import { WebhookForm, WebhookFormValues } from '@/components/admin/WebhookForm';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface CreatedWebhook {
  id: number;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  created_at: string;
}

export default function NewWebhookPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [err, setErr] = useState('');

  async function submit(v: WebhookFormValues) {
    setSubmitting(true);
    setErr('');
    try {
      const r = await api<CreatedWebhook>('/admin/webhooks', {
        method: 'POST',
        body: JSON.stringify(v),
      });
      setCreated(r);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">添加 Webhook</h1>
          <p className="text-sm text-muted-foreground mt-1">
            创建后会返回一次性密钥 secret, 请妥善保存 (后续无法再查看)。
          </p>
        </div>

        {err && (
          <div className="text-sm text-rose-600 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
            {err}
          </div>
        )}

        {!created && (
          <div className="bg-card rounded-lg border border-border p-5">
            <WebhookForm onSubmit={submit} submitting={submitting} submitLabel="创建" />
          </div>
        )}

        {created && (
          <div className="space-y-4">
            <div className="bg-card rounded-lg border border-border p-5 space-y-3">
              <div>
                <div className="text-sm text-muted-foreground">URL</div>
                <code className="text-sm break-all">{created.url}</code>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">事件</div>
                <code className="text-xs">{created.events.join(', ')}</code>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Secret (HMAC SHA256, 仅显示一次)</div>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs bg-muted px-3 py-2 rounded flex-1 break-all">{created.secret}</code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      try { navigator.clipboard.writeText(created.secret); } catch {}
                    }}
                  >复制</Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  接收端验证: header <code>X-3api-Signature: sha256=&lt;hex&gt;</code> 等于
                  HMAC-SHA256(secret, request body)。
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => router.push('/admin/webhooks')}>返回列表</Button>
              <Button variant="outline" onClick={() => { setCreated(null); }}>再创建一个</Button>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
