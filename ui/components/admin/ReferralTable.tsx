'use client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fmtCNY, fmtDate } from '@/lib/api';

export interface ReferralRow {
  id: number;
  referred_tenant_id: number;
  slug: string;
  commission_pct: number;
  commission_cents: number;
  status: string;
  joined_at: string;
  monthly_revenue_cents: number;
}

interface Props {
  rows: ReferralRow[];
  loading?: boolean;
  empty?: string;
}

function statusBadge(status: string) {
  const base = 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium';
  if (status === 'active') return <span className={`${base} bg-primary/10 text-primary`}>活跃</span>;
  if (status === 'paused') return <span className={`${base} bg-muted text-muted-foreground`}>暂停</span>;
  if (status === 'withdrawn') return <span className={`${base} bg-rose-500/10 text-rose-600`}>已退出</span>;
  return <span className={base}>{status}</span>;
}

export function ReferralTable({ rows, loading, empty = '还没有邀请记录' }: Props) {
  if (loading) {
    return <div className="text-sm text-muted-foreground py-6 text-center">加载中…</div>;
  }
  if (!rows.length) {
    return <div className="text-sm text-muted-foreground py-6 text-center">{empty}</div>;
  }

  return (
    <div className="rounded-md border border-border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>站长 (slug)</TableHead>
            <TableHead>加入时间</TableHead>
            <TableHead className="text-right">近 30d 流水</TableHead>
            <TableHead className="text-right">累计佣金</TableHead>
            <TableHead>分成</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono">{r.slug}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{fmtDate(r.joined_at)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtCNY(r.monthly_revenue_cents)}</TableCell>
              <TableCell className="text-right tabular-nums font-medium">{fmtCNY(r.commission_cents)}</TableCell>
              <TableCell className="text-muted-foreground">{r.commission_pct}%</TableCell>
              <TableCell>{statusBadge(r.status)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
