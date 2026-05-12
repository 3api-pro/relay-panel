'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslations } from '@/lib/i18n';

const EVENT_DEFS: { value: string; hintKey: string }[] = [
  { value: 'order.paid',           hintKey: 'event_order_paid_hint' },
  { value: 'subscription.expired', hintKey: 'event_subscription_expired_hint' },
  { value: 'refund.processed',     hintKey: 'event_refund_processed_hint' },
  { value: 'wholesale.low',        hintKey: 'event_wholesale_low_hint' },
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
  const t = useTranslations('admin.webhooks');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [events, setEvents] = useState<string[]>(initial?.events ?? []);
  const [err, setErr] = useState('');

  function toggle(t: string) {
    setEvents((arr) => (arr.includes(t) ? arr.filter((x) => x !== t) : [...arr, t]));
  }

  function validate(): string | null {
    if (!url.trim()) return t('validation_url_empty');
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return t('validation_url_protocol');
    } catch {
      return t('validation_url_invalid');
    }
    if (events.length === 0) return t('validation_no_event');
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
        <Label htmlFor="webhook-url">{t('form_url_label')}</Label>
        <Input
          id="webhook-url"
          type="url"
          placeholder={t('form_url_placeholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">{t('form_url_help')}</p>
      </div>

      <div className="space-y-2">
        <Label>{t('form_events_label')}</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EVENT_DEFS.map((e) => (
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
                <code className="text-xs">{e.value}</code>
                <span className="text-xs text-muted-foreground">{t(e.hintKey)}</span>
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
          {submitting ? t('form_submit_busy') : (submitLabel ?? t('form_submit_default'))}
        </Button>
      </div>
    </form>
  );
}
