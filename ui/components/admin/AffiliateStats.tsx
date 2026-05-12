'use client';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy, Check, Link as LinkIcon } from 'lucide-react';
import { StatCard } from '@/components/admin/StatCard';
import { fmtCNY } from '@/lib/api';

export interface AffiliateStatsData {
  aff_code: string | null;
  invite_link: string | null;
  referred_count: number;
  active_referred_count: number;
  total_commission_cents: number;
  pending_withdrawal_cents: number;
  paid_withdrawal_cents: number;
  available_balance_cents: number;
  commission_pct_default: number;
}

interface Props {
  data: AffiliateStatsData | null;
  loading?: boolean;
}

/**
 * Hero invite-link card + 4 stat cards.
 * Single brand-teal (no rainbow / no AI gradient).
 */
export function AffiliateStats({ data, loading }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!data?.invite_link) return;
    try {
      await navigator.clipboard.writeText(data.invite_link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select+copy is overkill — just leave the text in the input
    }
  }

  const link = data?.invite_link ?? '—';
  const pct = data?.commission_pct_default ?? 10;

  return (
    <div className="space-y-4">
      {/* Hero invite link */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-2 text-muted-foreground text-sm">
            <LinkIcon className="h-4 w-4" />
            <span>邀请链接 · {pct}% 终身分成</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              readOnly
              value={loading ? '加载中…' : link}
              className="flex-1 h-10 rounded-md border border-input bg-background px-3 text-sm font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="default"
              onClick={copy}
              disabled={!data?.invite_link || loading}
              className="shrink-0"
            >
              {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
              {copied ? '已复制' : '复制链接'}
            </Button>
          </div>
          {data?.aff_code && (
            <div className="mt-3 text-xs text-muted-foreground">
              邀请码: <code className="font-mono">{data.aff_code}</code>
              {' · '}把链接分享给其他站长，TA 注册并产生付费订单后，你自动获得
              <strong className="text-foreground"> {pct}% </strong>
              佣金（终身有效）
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4 stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="邀请站长数"
          value={data?.referred_count ?? '—'}
          hint={`活跃 ${data?.active_referred_count ?? 0}`}
        />
        <StatCard
          label="累计佣金"
          value={fmtCNY(data?.total_commission_cents)}
          hint={`${pct}% 分成`}
        />
        <StatCard
          label="待提现"
          value={fmtCNY(data?.pending_withdrawal_cents)}
          hint="审核中"
        />
        <StatCard
          label="可提余额"
          value={fmtCNY(data?.available_balance_cents)}
          hint={`已付 ${fmtCNY(data?.paid_withdrawal_cents)}`}
        />
      </div>
    </div>
  );
}
