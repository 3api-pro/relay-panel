'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { AffiliateStats, type AffiliateStatsData } from '@/components/admin/AffiliateStats';
import { ReferralTable, type ReferralRow } from '@/components/admin/ReferralTable';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Modal } from '@/components/admin/Modal';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { api, safe, fmtCNY, fmtDate } from '@/lib/api';

interface Withdrawal {
  id: number;
  amount_cents: number;
  method: string | null;
  status: string;
  note: string | null;
  requested_at: string;
  processed_at: string | null;
}

const METHODS = [
  { value: 'alipay', label: '支付宝' },
  { value: 'wholesale_credit', label: '抵扣批发余额' },
  { value: 'usdt', label: 'USDT (TRC20)' },
  { value: 'bank', label: '银行卡' },
];

function methodLabel(m: string | null): string {
  if (!m) return '—';
  const f = METHODS.find((x) => x.value === m);
  return f ? f.label : m;
}

function statusBadge(s: string) {
  const base = 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium';
  if (s === 'paid') return <span className={`${base} bg-primary/10 text-primary`}>已支付</span>;
  if (s === 'pending') return <span className={`${base} bg-amber-500/10 text-amber-600`}>审核中</span>;
  if (s === 'rejected') return <span className={`${base} bg-rose-500/10 text-rose-600`}>已驳回</span>;
  return <span className={base}>{s}</span>;
}

export default function AffiliatePage() {
  const [stats, setStats] = useState<AffiliateStatsData | null>(null);
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Withdraw modal
  const [open, setOpen] = useState(false);
  const [amountYuan, setAmountYuan] = useState('');
  const [method, setMethod] = useState('alipay');
  const [accountInfo, setAccountInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalErr, setModalErr] = useState('');

  async function refresh() {
    setLoading(true);
    setErr('');
    try {
      const [s, r, w] = await Promise.all([
        api<AffiliateStatsData>('/admin/affiliate'),
        safe(api<{ data: ReferralRow[] }>('/admin/affiliate/referrals'), { data: [] }),
        safe(api<{ data: Withdrawal[] }>('/admin/affiliate/withdrawals'), { data: [] }),
      ]);
      setStats(s);
      setReferrals(r.data || []);
      setWithdrawals(w.data || []);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function submitWithdraw() {
    setModalErr('');
    const amt = Math.round(Number(amountYuan) * 100);
    if (!Number.isFinite(amt) || amt <= 0) {
      setModalErr('金额必须大于 0');
      return;
    }
    if (stats && amt > stats.available_balance_cents) {
      setModalErr(`超过可提现余额 ${fmtCNY(stats.available_balance_cents)}`);
      return;
    }
    if (!accountInfo.trim()) {
      setModalErr('请填写收款账号');
      return;
    }
    setSubmitting(true);
    try {
      await api('/admin/affiliate/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          amount_cents: amt,
          method,
          account_info: accountInfo.trim(),
        }),
      });
      setOpen(false);
      setAmountYuan('');
      setAccountInfo('');
      await refresh();
    } catch (e: any) {
      setModalErr(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canWithdraw = (stats?.available_balance_cents ?? 0) > 0;

  return (
    <AdminShell
      title="站长邀请站长"
      subtitle="分享你的邀请链接 — 被邀请站长产生的订单，你拿 10% 终身分成"
    >
      {err && (
        <div className="mb-4 px-4 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-sm">
          {err}
        </div>
      )}

      <AffiliateStats data={stats} loading={loading} />

      <div className="mt-6">
        <Tabs defaultValue="referrals">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <TabsList>
              <TabsTrigger value="referrals">邀请列表 ({referrals.length})</TabsTrigger>
              <TabsTrigger value="withdrawals">提现历史 ({withdrawals.length})</TabsTrigger>
            </TabsList>
            <Button
              onClick={() => setOpen(true)}
              disabled={!canWithdraw}
              title={canWithdraw ? '' : '可提余额为 0'}
            >
              申请提现
            </Button>
          </div>

          <TabsContent value="referrals">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">被邀请的站长</CardTitle>
                <CardDescription>每个 paid 订单自动累计佣金，无需手动结算</CardDescription>
              </CardHeader>
              <CardContent>
                <ReferralTable rows={referrals} loading={loading} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="withdrawals">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">提现申请</CardTitle>
                <CardDescription>审核中的不可重复提交；可提余额已扣除审核中金额</CardDescription>
              </CardHeader>
              <CardContent>
                {!withdrawals.length ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">
                    还没有提现记录
                  </div>
                ) : (
                  <div className="rounded-md border border-border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>申请时间</TableHead>
                          <TableHead className="text-right">金额</TableHead>
                          <TableHead>方式</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>处理时间</TableHead>
                          <TableHead>备注</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {withdrawals.map((w) => (
                          <TableRow key={w.id}>
                            <TableCell className="text-muted-foreground text-sm">{fmtDate(w.requested_at)}</TableCell>
                            <TableCell className="text-right tabular-nums font-medium">{fmtCNY(w.amount_cents)}</TableCell>
                            <TableCell>{methodLabel(w.method)}</TableCell>
                            <TableCell>{statusBadge(w.status)}</TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {w.processed_at ? fmtDate(w.processed_at) : '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">{w.note ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Withdraw modal */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="申请提现"
        width="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submitWithdraw} disabled={submitting}>
              {submitting ? '提交中…' : '提交申请'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-md bg-muted/40 px-3 py-2 text-muted-foreground">
            可提余额: <strong className="text-foreground">{fmtCNY(stats?.available_balance_cents)}</strong>
          </div>
          <div className="space-y-1">
            <Label htmlFor="amt">提现金额 (元)</Label>
            <Input
              id="amt"
              type="number"
              min="0"
              step="0.01"
              value={amountYuan}
              onChange={(e) => setAmountYuan(e.target.value)}
              placeholder="例如 100.00"
            />
          </div>
          <div className="space-y-1">
            <Label>方式</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="acct">收款账号 / 备注</Label>
            <Input
              id="acct"
              value={accountInfo}
              onChange={(e) => setAccountInfo(e.target.value)}
              placeholder="支付宝账号 / USDT 地址 / 银行卡号"
            />
            <p className="text-xs text-muted-foreground">仅运营方可见，不会出现在站点</p>
          </div>
          {modalErr && (
            <div className="px-3 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-xs">
              {modalErr}
            </div>
          )}
        </div>
      </Modal>
    </AdminShell>
  );
}
