'use client';
/**
 * Top-level "/dashboard" page. Host-aware (Task #17, extended v0.2).
 *   - root marketing host  → legacy customer dashboard (/api/customer)
 *   - tenant subdomain     → branded store dashboard home (check-in, nav)
 *
 * NOTE: this page lives OUTSIDE app/(store)/, so the (store)/layout.tsx
 * chrome (BrandProvider + Header + Footer + AnnouncementBar) doesn't wrap
 * us automatically. For store mode we mount it inline.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, auth } from '@/lib/api';
import { useHostMode } from '@/components/HostAware';
import { BrandProvider } from '@/components/store/BrandContext';
import { Header } from '@/components/store/Header';
import { Footer } from '@/components/store/Footer';
import { AnnouncementBar } from '@/components/store/AnnouncementBar';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { CheckInWidget } from '@/components/store/CheckInWidget';
import { store, fmtTokens } from '@/lib/store-api';

interface Me {
  id: number;
  email: string;
  groupName: string;
  quotaCents: number;
  usedQuotaCents: number;
  remain_cents: number;
}
interface Token {
  id: number;
  name: string;
  key_prefix: string;
  status: string;
  used_quota_cents: number;
  remain_quota_cents: number;
  unlimited_quota: boolean;
  last_used_at: string | null;
  created_at: string;
}

function MarketingDashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!auth.hasToken()) { router.push('/login'); return; }
    refresh();
  }, []);

  async function refresh() {
    try {
      const m = await api<Me>('/customer/me');
      setMe(m);
      const t = await api<{ data: Token[] }>('/customer/tokens');
      setTokens(t.data);
    } catch (e: any) {
      setMsg(e.message);
      if (e.message.includes('401')) { auth.clearToken(); router.push('/login'); }
    }
  }

  async function issueToken() {
    setIssued(null); setMsg('');
    try {
      const r = await api<{ id: number; key: string }>('/customer/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'My Key', unlimited_quota: false, remain_quota_cents: 0 }),
      });
      setIssued(r.key);
      refresh();
    } catch (e: any) { setMsg(e.message); }
  }

  async function redeem() {
    if (!code) return;
    setMsg('');
    try {
      const r = await api<{ added_cents: number }>('/customer/redeem', {
        method: 'POST', body: JSON.stringify({ code }),
      });
      setMsg(`兑换成功 +¥${(r.added_cents / 100).toFixed(2)}`);
      setCode('');
      refresh();
    } catch (e: any) { setMsg(e.message); }
  }

  function logout() { auth.clearToken(); router.push('/'); }

  if (!me) return <main className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</main>;

  return (
    <main className="min-h-screen" data-marketing-dashboard>
      <header className="bg-card border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold text-brand-700">3API Panel</div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">{me.email}</span>
            <button onClick={logout} className="text-muted-foreground hover:text-red-600">退出</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        <section className="grid grid-cols-3 gap-4">
          <Card label="账户余额" value={`¥${(me.remain_cents / 100).toFixed(2)}`} />
          <Card label="累计消费" value={`¥${(me.usedQuotaCents / 100).toFixed(2)}`} />
          <Card label="账户级别" value={me.groupName.toUpperCase()} />
        </section>

        <section className="bg-card rounded-lg border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">API Keys</h2>
            <button onClick={issueToken} className="px-3 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
              + 生成新 Key
            </button>
          </div>
          {issued && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded text-sm">
              <div className="font-medium text-amber-900">新 Key (仅显示一次, 复制保存)</div>
              <code className="block mt-2 break-all">{issued}</code>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground border-b">
              <tr><th className="py-2">名称</th><th>前缀</th><th>状态</th><th>已用</th><th>创建时间</th></tr>
            </thead>
            <tbody>
              {tokens.length === 0 ? (
                <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">还没有 API Key</td></tr>
              ) : tokens.map(t => (
                <tr key={t.id} className="border-b border-border/50">
                  <td className="py-3">{t.name}</td>
                  <td><code className="text-xs">{t.key_prefix}…</code></td>
                  <td><span className={`text-xs px-2 py-0.5 rounded ${t.status==='active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>{t.status}</span></td>
                  <td>¥{(t.used_quota_cents / 100).toFixed(2)}</td>
                  <td className="text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="bg-card rounded-lg border border-border p-6">
          <h2 className="font-semibold mb-4">兑换码</h2>
          <div className="flex gap-2">
            <input type="text" value={code} onChange={(e)=>setCode(e.target.value)}
              placeholder="输入兑换码"
              className="flex-1 px-3 py-2 rounded-md border border-input focus:border-brand-500 focus:outline-none" />
            <button onClick={redeem} className="px-4 py-2 rounded-md bg-brand-600 text-white hover:bg-brand-700">
              兑换
            </button>
          </div>
          {msg && <div className="mt-3 text-sm text-muted-foreground">{msg}</div>}
        </section>
      </div>
    </main>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-foreground">{value}</div>
    </div>
  );
}

/**
 * Store-mode dashboard home — landed page after login on a tenant subdomain.
 * Pulls the user's subscription summary + surfaces the daily check-in widget.
 */
function StoreDashboardHome() {
  const [sub, setSub] = useState<any>(null);
  const [subErr, setSubErr] = useState<string | null>(null);

  useEffect(() => {
    store.subscriptions()
      .then((r) => setSub(r))
      .catch((e) => setSubErr(e?.message || '加载失败'));
  }, []);

  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-foreground mb-6">控制台</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SummaryCard
                label="当前套餐"
                value={sub?.subscription?.plan_name ? String(sub.subscription.plan_name) : (sub === null ? '加载中…' : '未订阅')}
              />
              <SummaryCard
                label="剩余 tokens"
                value={sub?.subscription?.remaining_tokens != null
                  ? fmtTokens(Number(sub.subscription.remaining_tokens))
                  : '—'}
              />
              <SummaryCard
                label="到期时间"
                value={sub?.subscription?.expires_at
                  ? new Date(sub.subscription.expires_at).toLocaleDateString('zh-CN')
                  : '—'}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <CheckInWidget />
              <QuickLinksCard />
            </div>

            {subErr && (
              <div className="text-sm text-muted-foreground">订阅信息加载失败：{subErr}</div>
            )}
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-1 text-foreground truncate" title={value}>{value}</div>
    </div>
  );
}

function QuickLinksCard() {
  return (
    <div className="bg-card rounded-lg border border-border p-5">
      <div className="font-semibold mb-3 text-foreground">快速入口</div>
      <ul className="space-y-2 text-sm">
        <li><Link href="/dashboard/keys" className="text-foreground hover:underline">→ 管理 API Keys</Link></li>
        <li><Link href="/dashboard/usage" className="text-foreground hover:underline">→ 查看用量统计</Link></li>
        <li><Link href="/dashboard/billing" className="text-foreground hover:underline">→ 订单 & 续费</Link></li>
        <li><Link href="/pricing" className="text-muted-foreground hover:text-foreground hover:underline">→ 升级套餐</Link></li>
        <li><Link href="/docs" className="text-muted-foreground hover:text-foreground hover:underline">→ API 文档</Link></li>
      </ul>
    </div>
  );
}

/** Wraps StoreDashboardHome with BrandProvider + store chrome (since this
 *  page lives outside app/(store)/ and doesn't inherit (store)/layout.tsx). */
function StoreDashboardShell() {
  return (
    <BrandProvider>
      <div className="min-h-screen flex flex-col bg-background" data-store-dashboard>
        <AnnouncementBar />
        <Header />
        <main className="flex-1">
          <StoreDashboardHome />
        </main>
        <Footer />
      </div>
    </BrandProvider>
  );
}

export default function CustomerDashboard() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-background" />;
  if (mode === 'store') return <StoreDashboardShell />;
  return <MarketingDashboard />;
}
