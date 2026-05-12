'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const EVENT_TYPES: { value: string; label: string; hint: string }[] = [
  { value: 'order.paid',           label: 'order.paid',           hint: '订单支付成功' },
  { value: 'subscription.expired', label: 'subscription.expired', hint: '订阅到期' },
  { value: 'refund.processed',     label: 'refund.processed',     hint: '退款已处理' },
  { value: 'wholesale.low',        label: 'wholesale.low',        hint: '批发余额低' },
];

export interface WebhookFormValues {
  url: string;
  events: string[];
}

interface Props {
  initial?: { url?: string; events?: string[] };
  onSubmit: (v: WebhookFormValues) => Promise<void>;
  submitting?: boolean;
  submitLabel?: string;
}

export function WebhookForm({ initial, onSubmit, submitting, submitLabel }: Props) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [events, setEvents] = useState<string[]>(initial?.events ?? []);
  const [err, setErr] = useState('');

  function toggle(t: string) {
    setEvents((arr) => (arr.includes(t) ? arr.filter((x) => x !== t) : [...arr, t]));
  }

  function validate(): string | null {
    if (!url.trim()) return 'URL 不能为空';
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL 必须是 http(s)';
    } catch {
      return 'URL 格式无效';
    }
    if (events.length === 0) return '至少选择一个事件';
    return null;
  }

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr('');
    await onSubmit({ url: url.trim(), events });
  }

  return (
    <form onSubmit={handle} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="webhook-url">URL</Label>
        <Input
          id="webhook-url"
          type="url"
          placeholder="https://example.com/3api-webhook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          收到事件时, 我们会以 POST + JSON body 调用此 URL, 并附带 X-3api-Signature
          (HMAC-SHA256) 与 X-3api-Event 头。
        </p>
      </div>

      <div className="space-y-2">
        <Label>订阅事件</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EVENT_TYPES.map((e) => (
            <label
              key={e.value}
              className="flex items-start gap-2 p-2.5 rounded-md border border-border hover:bg-muted/40 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={events.includes(e.value)}
                onChange={() => toggle(e.value)}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <code className="text-xs">{e.label}</code>
                <span className="text-xs text-muted-foreground">{e.hint}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {err && (
        <div className="text-sm text-rose-600 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {err}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={!!submitting}>
          {submitting ? '提交中…' : submitLabel ?? '保存'}
        </Button>
      </div>
    </form>
  );
}
