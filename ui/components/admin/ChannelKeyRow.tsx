'use client';
import { useEffect, useState } from 'react';
import { Trash2, KeyRound, Pencil, Copy, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/lib/i18n';

export type KeyStatus = 'active' | 'dead' | 'cooling';

export interface ChannelKey {
  preview: string;
  status: string | null;
  added_at?: string | null;
  cooled_until?: string | null;
  last_error?: string | null;
}

interface Props {
  idx: number;
  current: boolean;
  k: ChannelKey;
  onDelete: () => void;
  /** Replace the secret at this index with a new value. */
  onEdit?: (newKey: string) => Promise<void>;
  /** Fetch the plaintext key (for clipboard copy). */
  onReveal?: () => Promise<string | null>;
  busy?: boolean;
}

function normaliseStatus(s: string | null | undefined): KeyStatus {
  const v = (s || '').toLowerCase();
  if (v === 'dead' || v === 'banned' || v === 'disabled') return 'dead';
  if (v === 'cooling' || v === 'cooldown') return 'cooling';
  return 'active';
}

function useCountdown(target: string | null | undefined, restoredLabel: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);
  if (!target) return null;
  const ts = new Date(target).getTime();
  if (Number.isNaN(ts)) return null;
  const diff = ts - now;
  if (diff <= 0) return restoredLabel;
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * One row inside the per-channel keys[] list. Shows masked preview, status
 * badge, cool-down countdown (if any), and a delete button with confirm.
 */
export function ChannelKeyRow({ idx, current, k, onDelete, onEdit, onReveal, busy }: Props) {
  const t = useTranslations('admin.channel.key_row');
  const status = normaliseStatus(k.status);
  const cooldown = useCountdown(k.cooled_until, t('cooldown_restored'));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  async function commit() {
    if (!onEdit || !draft.trim() || draft.trim().length < 8) return;
    setSaving(true);
    try {
      await onEdit(draft.trim());
      setEditing(false);
      setDraft('');
    } finally {
      setSaving(false);
    }
  }

  async function copyPlain() {
    if (!onReveal) return;
    const plain = await onReveal();
    if (!plain) return;
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: show in prompt so user can manually copy if clipboard
      // API is blocked (older browser / insecure context).
      window.prompt(t('copy_fallback_label'), plain);
    }
  }

  if (editing) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 border rounded-md text-sm',
          'border-primary/40 bg-primary/[0.04]',
        )}
      >
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('edit_placeholder')}
          className="h-7 font-mono text-xs flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setEditing(false); setDraft(''); }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={commit}
          disabled={saving || draft.trim().length < 8}
          className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-500/10"
          aria-label={t('edit_confirm')}
          title={t('edit_confirm')}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setEditing(false); setDraft(''); }}
          disabled={saving}
          className="h-7 w-7 p-0 text-muted-foreground"
          aria-label={t('edit_cancel')}
          title={t('edit_cancel')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2 border rounded-md text-sm',
        current
          ? 'border-primary/40 bg-primary/[0.04]'
          : 'border-border bg-card',
      )}
    >
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <code className="font-mono text-xs text-foreground truncate min-w-0">
        {k.preview || '—'}
      </code>
      <span className="text-[10px] text-muted-foreground shrink-0">#{idx}</span>
      {current && (
        <Badge variant="secondary" className="h-5 text-[10px] shrink-0">
          {t('current')}
        </Badge>
      )}
      <div className="flex-1" />
      {status === 'active' && (
        <Badge
          variant="outline"
          className="h-5 text-[10px] shrink-0 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
        >
          active
        </Badge>
      )}
      {status === 'dead' && (
        <Badge
          variant="outline"
          className="h-5 text-[10px] shrink-0 border-rose-500/40 text-rose-700 dark:text-rose-400 bg-rose-500/10"
          title={k.last_error || undefined}
        >
          dead
        </Badge>
      )}
      {status === 'cooling' && (
        <Badge
          variant="outline"
          className="h-5 text-[10px] shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/10"
          title={k.last_error || undefined}
        >
          cooling{cooldown ? ` · ${cooldown}` : ''}
        </Badge>
      )}
      {onReveal && (
        <Button
          variant="ghost"
          size="sm"
          onClick={copyPlain}
          disabled={busy}
          className={cn(
            'h-7 w-7 p-0 text-muted-foreground hover:text-foreground',
            copied && 'text-emerald-600',
          )}
          aria-label={t('copy_aria')}
          title={copied ? t('copy_done') : t('copy_title')}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      )}
      {onEdit && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setEditing(true); setDraft(''); }}
          disabled={busy}
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label={t('edit_aria')}
          title={t('edit_title')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        disabled={busy}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-600"
        aria-label={t('delete_aria')}
        title={t('delete_title')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
