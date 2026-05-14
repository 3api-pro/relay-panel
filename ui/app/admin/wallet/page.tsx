'use client';
/**
 * /admin/wallet — reseller's platform-wallet console.
 *
 * Layout:
 *   Top:  balance card (gradient) + 2 CTA buttons (提现 / 续 llmapi)
 *   Mid:  transactions table (last 50)
 *   Bot:  withdrawal history table
 *
 * Operations (all behind adminAuth cookie/Bearer):
 *   GET  /admin/wallet/balance
 *   GET  /admin/wallet/transactions
 *   GET  /admin/wallet/withdrawals
 *   POST /admin/wallet/topup-llmapi  { amount_cents, plan_slug, llmapi_user_id }
 *   POST /admin/wallet/withdraw      { method:'bank'|'alipay', gross_cents, ... }
 *   POST /admin/wallet/withdraw/:id/confirm   { otp }
 *   POST /admin/wallet/withdraw/:id/cancel
 */
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api } from '@/lib/api';

interface Balance { balance_cents: number; locked_cents: number; spendable_cents: number; currency: string; }
interface Txn { id: number; delta_cents: number; type: string; reference: string | null; note: string | null; created_at: string; }
interface WithdrawalRow {
  id: number; method: 'bank' | 'alipay';
  gross_cents: number; fee_cents: number; net_cents: number; currency: string;
  status: string; cardholder_name: string;
  card_last4: string | null; bank_name: string | null;
  alipay_masked: string | null;
  created_at: string; approved_at: string | null; paid_at: string | null;
  platform_note: string | null;
}

function fmtMoney(cents: number, currency = 'CNY'): string {
  const v = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${v}` : `¥${v}`;
}

const TX_LABEL: Record<string, string> = {
  order_credit: '订单到账',
  order_refund: '订单退款',
  topup_llmapi: '续 llmapi',
  withdrawal_hold: '提现冻结',
  withdrawal_release: '提现释放',
  withdrawal_fee: '提现手续费',
  withdrawal_paid: '提现到账',
  adjustment: '人工调整',
};

const STATUS_LABEL: Record<string, string> = {
  pending_confirm: '待邮件确认',
  pending: '待审核',
  approved: '已批准 待打款',
  paid: '已到账',
  rejected: '已拒绝',
  cancelled: '已取消',
};
const STATUS_COLOR: Record<string, string> = {
  pending_confirm: 'bg-amber-100 text-amber-800',
  pending: 'bg-blue-100 text-blue-800',
  approved: 'bg-violet-100 text-violet-800',
  paid: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-slate-100 text-slate-600',
};

export default function WalletPage() {
  const [bal, setBal] = useState<Balance | null>(null);
  const [txs, setTxs] = useState<Txn[]>([]);
  const [wds, setWds] = useState<WithdrawalRow[]>([]);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showTopup, setShowTopup] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [err, setErr] = useState('');

  async function refresh() {
    setErr('');
    try {
      const [b, t, w] = await Promise.all([
        api<Balance>('/admin/wallet/balance'),
        api<{ transactions: Txn[] }>('/admin/wallet/transactions'),
        api<{ withdrawals: WithdrawalRow[] }>('/admin/wallet/withdrawals'),
      ]);
      setBal(b);
      setTxs(t.transactions || []);
      setWds(w.withdrawals || []);
    } catch (e: any) {
      setErr(e.message || String(e));
    }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <AdminShell title="钱包" subtitle="你的客户付款会进到这里。你可以提现，或直接抵 llmapi 续费。">
      {err && <div className="mb-4 px-3 py-2 rounded-md bg-rose-50 border border-rose-200 text-sm text-rose-700">{err}</div>}

      {/* Balance card */}
      <section className="relative overflow-hidden rounded-2xl mb-6">
        <div className="absolute inset-0 bg-gradient-to-br from-teal-500 via-emerald-500 to-cyan-600" />
        <div className="absolute -top-16 -right-16 w-64 h-64 bg-white/15 rounded-full blur-3xl" />
        <div className="relative px-7 py-7 sm:px-8 sm:py-8 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-end text-white">
          <div>
            <div className="text-sm font-medium opacity-90 mb-1">可用余额</div>
            <div className="text-5xl font-bold tracking-tight">
              {bal ? fmtMoney(bal.spendable_cents, bal.currency) : '—'}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span><span className="opacity-75">总余额 </span><strong>{bal ? fmtMoney(bal.balance_cents, bal.currency) : '—'}</strong></span>
              <span><span className="opacity-75">冻结 </span><strong>{bal ? fmtMoney(bal.locked_cents, bal.currency) : '—'}</strong></span>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 md:gap-3">
            <button
              onClick={() => setShowWithdraw(true)}
              className="px-5 py-2.5 rounded-xl bg-white text-teal-700 font-semibold text-sm shadow-lg shadow-teal-900/20 hover:translate-y-[-1px] transition-all"
            >
              提现
            </button>

          </div>
        </div>
      </section>

      <section className="mb-3 text-xs text-muted-foreground leading-relaxed">
        客户在你的站点付款（Alipay / PayPal / Stripe / USDT 多渠道，走平台收款 — 你不需要自己申请商户号），钱直接进入这里。你有两种用法：① 走 <strong>国内银行卡</strong> 或 <strong>支付宝收款码</strong>（国际兼容）<strong>提现</strong>，平台收 3% 手续费 + T+1 人工审核到账；② 在 llmapi.pro 买套餐时选 <strong>"钱包余额支付"</strong> — 免手续费内部转账。
      </section>

      {/* Transactions */}
      <section className="mb-8 bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-muted/40 text-sm font-semibold">交易流水</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/20">
              <tr>
                <th className="px-4 py-2 text-left">时间</th>
                <th className="px-4 py-2 text-left">类型</th>
                <th className="px-4 py-2 text-right">金额</th>
                <th className="px-4 py-2 text-left">备注</th>
              </tr>
            </thead>
            <tbody>
              {txs.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">还没有流水</td></tr>
              )}
              {txs.map((t) => (
                <tr key={t.id} className="border-t border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2"><span className="inline-block px-2 py-0.5 rounded text-xs bg-muted">{TX_LABEL[t.type] || t.type}</span></td>
                  <td className={`px-4 py-2 text-right font-mono tabular-nums ${t.delta_cents >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {t.delta_cents >= 0 ? '+' : ''}{fmtMoney(t.delta_cents)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{t.note || (t.reference ? `ref ${t.reference}` : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Withdrawals */}
      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-muted/40 text-sm font-semibold">提现记录</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/20">
              <tr>
                <th className="px-4 py-2 text-left">时间</th>
                <th className="px-4 py-2 text-left">方式</th>
                <th className="px-4 py-2 text-right">申请额</th>
                <th className="px-4 py-2 text-right">到手</th>
                <th className="px-4 py-2 text-left">收款</th>
                <th className="px-4 py-2 text-left">状态</th>
                <th className="px-4 py-2 text-left">操作</th>
              </tr>
            </thead>
            <tbody>
              {wds.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">还没有提现记录</td></tr>
              )}
              {wds.map((w) => (
                <tr key={w.id} className="border-t border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(w.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2">{w.method === 'alipay' ? '支付宝' : '银行卡'}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMoney(w.gross_cents, w.currency)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMoney(w.net_cents, w.currency)}</td>
                  <td className="px-4 py-2 text-xs">
                    {w.method === 'bank'
                      ? <span>{w.bank_name} ••{w.card_last4 || '????'}</span>
                      : <span>支付宝 {w.alipay_masked || ''}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[w.status] || 'bg-slate-100'}`}>
                      {STATUS_LABEL[w.status] || w.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {w.status === 'pending_confirm' && (
                      <button className="text-teal-600 hover:underline mr-2" onClick={() => setConfirmId(w.id)}>填入验证码</button>
                    )}
                    {(w.status === 'pending_confirm' || w.status === 'pending') && (
                      <button
                        className="text-rose-600 hover:underline"
                        onClick={async () => {
                          if (!confirm(`取消提现申请 #${w.id}？余额会立即解冻。`)) return;
                          try { await api(`/admin/wallet/withdraw/${w.id}/cancel`, { method: 'POST' }); await refresh(); }
                          catch (e: any) { alert(e.message); }
                        }}
                      >取消</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} onSuccess={refresh} balanceSpendable={bal?.spendable_cents || 0} />}
      {confirmId !== null && <ConfirmOtpModal id={confirmId} onClose={() => setConfirmId(null)} onSuccess={refresh} />}
    </AdminShell>
  );
}

/* ------------------------------------------------------------------ */

function WithdrawModal({ onClose, onSuccess, balanceSpendable }: { onClose: () => void; onSuccess: () => void; balanceSpendable: number; }) {
  const [method, setMethod] = useState<'bank' | 'alipay'>('alipay');
  const [yuanStr, setYuanStr] = useState('');
  const [cardholder, setCardholder] = useState('');
  const [bankName, setBankName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [alipayAccount, setAlipayAccount] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const cents = Math.round(parseFloat(yuanStr || '0') * 100);
  const fee = Math.floor(cents * 3 / 100);
  const net = cents - fee;
  const overdraw = cents > balanceSpendable;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (cents < 1000) { setErr('最低提现金额 ¥10'); return; }
    if (overdraw) { setErr('超过可用余额'); return; }
    setBusy(true); setErr('');
    try {
      await api('/admin/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          method, gross_cents: cents, currency: 'CNY',
          cardholder_name: cardholder,
          bank_name: bankName || undefined,
          card_number: method === 'bank' ? cardNumber : undefined,
          alipay_account: method === 'alipay' ? alipayAccount : undefined,
          contact_email: contactEmail,
        }),
      });
      onSuccess();
      onClose();
      alert(`已发送验证码到 ${contactEmail}，请在 10 分钟内回提现记录处输入。`);
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title="申请提现">
      <form onSubmit={submit} className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-2 p-1 bg-muted rounded-lg">
          <button type="button" onClick={() => setMethod('alipay')}
            className={`py-2 rounded-md text-sm font-medium transition-all ${method === 'alipay' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
            支付宝（国际兼容）
          </button>
          <button type="button" onClick={() => setMethod('bank')}
            className={`py-2 rounded-md text-sm font-medium transition-all ${method === 'bank' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
            国内银行卡
          </button>
        </div>

        <Field label="提现金额 (元)" required>
          <input type="number" step="0.01" min="10" required value={yuanStr} onChange={(e) => setYuanStr(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
        </Field>

        {cents > 0 && (
          <div className="text-xs bg-muted/50 rounded-md px-3 py-2">
            <div>申请金额 <strong>{fmtMoney(cents)}</strong></div>
            <div>手续费 3% <strong className="text-rose-600">-{fmtMoney(fee)}</strong></div>
            <div className="border-t border-border/50 mt-1 pt-1">到手 <strong className="text-emerald-700">{fmtMoney(net)}</strong></div>
            {overdraw && <div className="text-rose-600 mt-1">⚠ 超过可用余额 {fmtMoney(balanceSpendable)}</div>}
          </div>
        )}

        <Field label="收款人姓名" required>
          <input type="text" required value={cardholder} onChange={(e) => setCardholder(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
        </Field>

        {method === 'bank' ? (
          <>
            <Field label="开户行" required>
              <input type="text" required placeholder="例：招商银行 / 工商银行" value={bankName} onChange={(e) => setBankName(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
            </Field>
            <Field label="银行卡号" required>
              <input type="text" required value={cardNumber} onChange={(e) => setCardNumber(e.target.value.replace(/\s/g, ''))}
                className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
            </Field>
          </>
        ) : (
          <Field label="支付宝账号 (手机号 / 邮箱 / Alipay HK ID)" required>
            <input type="text" required placeholder="13xxxxxxxxx 或 邮箱" value={alipayAccount} onChange={(e) => setAlipayAccount(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
          </Field>
        )}

        <Field label="联系邮箱 (验证码发到这里)" required>
          <input type="email" required value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
        </Field>

        {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">{err}</div>}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-input text-sm hover:bg-muted">取消</button>
          <button type="submit" disabled={busy || overdraw || cents < 1000}
            className="px-5 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50">
            {busy ? '提交中…' : '提交申请'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmOtpModal({ id, onClose, onSuccess }: { id: number; onClose: () => void; onSuccess: () => void; }) {
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api(`/admin/wallet/withdraw/${id}/confirm`, { method: 'POST', body: JSON.stringify({ otp }) });
      onSuccess(); onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title="填入邮箱验证码">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted-foreground">把邮箱里收到的 6 位验证码填这里，10 分钟内有效。</p>
        <input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          className="w-full px-3 py-3 rounded-md border border-input bg-background text-center text-2xl font-mono tracking-widest focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
        {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">{err}</div>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-input text-sm hover:bg-muted">取消</button>
          <button type="submit" disabled={busy || otp.length !== 6}
            className="px-5 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50">
            {busy ? '验证中…' : '确认'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const PLAN_PRICES: Record<string, number> = { pro: 2900, max5x: 14900, max20x: 29900, ultra: 59900 };
const PLAN_LABELS: Record<string, string> = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', ultra: 'Ultra' };

function TopupModal({ onClose, onSuccess, balanceSpendable }: { onClose: () => void; onSuccess: () => void; balanceSpendable: number; }) {
  const [planSlug, setPlanSlug] = useState<string>('max5x');
  const [llmapiUserId, setLlmapiUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cents = PLAN_PRICES[planSlug] || 0;
  const overdraw = cents > balanceSpendable;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!llmapiUserId) { setErr('llmapi 用户 ID 必填'); return; }
    setBusy(true); setErr('');
    try {
      await api('/admin/wallet/topup-llmapi', {
        method: 'POST',
        body: JSON.stringify({
          llmapi_user_id: parseInt(llmapiUserId, 10),
          amount_cents: cents,
          plan_slug: planSlug,
        }),
      });
      onSuccess(); onClose();
      alert('续费成功，llmapi 那边的订阅已延长 30 天。');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title="用钱包余额续 llmapi 订阅">
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-muted-foreground">用你的钱包余额抵 llmapi 月度订阅，免手续费。</p>

        <Field label="续哪个套餐" required>
          <div className="grid grid-cols-2 gap-2">
            {(['pro', 'max5x', 'max20x', 'ultra'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setPlanSlug(s)}
                className={`py-2.5 px-3 rounded-lg border text-sm font-medium transition-all ${planSlug === s ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-input hover:bg-muted'}`}>
                <div>{PLAN_LABELS[s]}</div>
                <div className="text-xs opacity-75 mt-0.5">{fmtMoney(PLAN_PRICES[s])}/月</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="llmapi 用户 ID (你的 llmapi 账号 user_id)" required>
          <input type="number" required value={llmapiUserId} onChange={(e) => setLlmapiUserId(e.target.value)}
            placeholder="在 llmapi 控制台个人资料页查"
            className="w-full px-3 py-2 rounded-md border border-input bg-background focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none" />
        </Field>

        <div className="text-xs bg-muted/50 rounded-md px-3 py-2">
          <div>扣款 <strong className="text-rose-600">-{fmtMoney(cents)}</strong></div>
          <div>剩余可用 <strong>{fmtMoney(balanceSpendable - cents)}</strong></div>
          {overdraw && <div className="text-rose-600 mt-1">⚠ 超过可用余额 {fmtMoney(balanceSpendable)}</div>}
        </div>

        {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">{err}</div>}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-input text-sm hover:bg-muted">取消</button>
          <button type="submit" disabled={busy || overdraw}
            className="px-5 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50">
            {busy ? '处理中…' : '确认续费'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string; }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto bg-card rounded-2xl shadow-2xl border border-border" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted">×</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode; }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-foreground mb-1.5">{label}{required && <span className="text-rose-500 ml-0.5">*</span>}</span>
      {children}
    </label>
  );
}
