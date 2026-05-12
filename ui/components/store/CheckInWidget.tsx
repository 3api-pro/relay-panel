'use client';
/**
 * Daily check-in widget for the end-user dashboard (v0.2).
 *
 * Calls /api/storefront/checkin/{status,doCheckin} (see src/routes/storefront/checkin.ts).
 *
 * Empty states surfaced:
 *   - feature disabled by storefront admin   → soft hint, no claim button
 *   - no active subscription (402)           → upsell card linking to /pricing
 *   - already checked-in today               → button disabled, tomorrow preview
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { store, fmtTokens, StoreApiError, type CheckInStatus } from '@/lib/store-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type Phase = 'loading' | 'ready' | 'disabled' | 'no_sub';

export function CheckInWidget() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<CheckInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<'ok' | 'err' | null>(null);

  async function load() {
    try {
      const s = await store.checkin.status();
      setStatus(s);
      if (!s.enabled) setPhase('disabled');
      else setPhase('ready');
    } catch (e: any) {
      // status endpoint is always 200/500 — if it bombs, just hide softly.
      setPhase('disabled');
    }
  }

  useEffect(() => { load(); }, []);

  async function doCheckin() {
    setBusy(true);
    setMsg(null); setMsgKind(null);
    try {
      const r = await store.checkin.doCheckin();
      const bonusTag = r.is_bonus_day ? '  连签奖励！' : '';
      setMsg(`签到成功，获得 ${fmtTokens(r.reward_tokens)} tokens${bonusTag}`);
      setMsgKind('ok');
      await load();
    } catch (e: any) {
      if (e instanceof StoreApiError) {
        if (e.status === 402) {
          setPhase('no_sub');
          setBusy(false);
          return;
        }
        if (e.status === 409) {
          setMsg('今天已经签过到，明天再来吧');
          setMsgKind('err');
          await load();
          setBusy(false);
          return;
        }
        if (e.status === 403) {
          setPhase('disabled');
          setBusy(false);
          return;
        }
      }
      setMsg(e?.message || '签到失败');
      setMsgKind('err');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading') {
    return (
      <Card data-checkin-widget>
        <CardHeader><CardTitle className="text-base">每日签到</CardTitle></CardHeader>
        <CardContent>
          <div className="h-10 rounded bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (phase === 'disabled') {
    // Storefront admin turned check-in off, or status fetch failed. Hide entirely.
    return null;
  }

  if (phase === 'no_sub') {
    return (
      <Card data-checkin-widget data-state="no-sub">
        <CardHeader><CardTitle className="text-base">每日签到</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            购买套餐后可解锁每日签到，连签 7 天有 bonus。
          </div>
          <Link
            href="/pricing"
            className="mt-3 inline-flex items-center justify-center rounded-md text-sm font-medium text-white hover:opacity-90 px-3 py-1.5"
            style={{ background: 'var(--brand-primary, #0e9486)' }}
          >
            查看套餐
          </Link>
        </CardContent>
      </Card>
    );
  }

  // phase === 'ready'
  if (!status) return null;
  const checked = status.already_checked_in;
  const bonusEveryN = status.config.bonus_every_n_days || 7;
  const nextStreak = status.current_streak + 1;
  const nextHitsBonus = !checked && nextStreak > 0 && (nextStreak % bonusEveryN === 0);

  return (
    <Card data-checkin-widget data-state={checked ? 'checked' : 'ready'}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>每日签到</span>
          {status.current_streak > 0 && (
            <Badge variant="secondary" data-streak={status.current_streak}>
              连签 {status.current_streak} 天
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {checked
              ? <>今天已签到。明天可领 <span className="font-semibold text-foreground">{fmtTokens(status.next_reward_tokens)}</span> tokens{status.next_is_bonus ? '（含连签奖励）' : ''}</>
              : <>今天可领 <span className="font-semibold text-foreground">{fmtTokens(status.next_reward_tokens)}</span> tokens{status.next_is_bonus ? '（连签奖励日！）' : (nextHitsBonus ? '' : '')}</>
            }
          </div>
          <Button
            onClick={doCheckin}
            disabled={busy || checked}
            data-checkin-action
            className="w-full text-white hover:opacity-90"
            style={{ background: 'var(--brand-primary, #0e9486)' }}
          >
            {busy ? '签到中…' : checked ? '今天已签到' : '立即签到'}
          </Button>
          {msg && (
            <div
              role="status"
              data-checkin-msg={msgKind}
              className={`text-sm ${msgKind === 'ok' ? 'text-green-700 dark:text-green-300' : 'text-red-600 dark:text-red-400'}`}
            >
              {msg}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
