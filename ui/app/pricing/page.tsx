'use client';
/**
 * /pricing — host-aware. (Task #17 pattern, v0.2 extension.)
 *
 *   - root marketing host  → 3api Panel marketing/wholesale pricing page
 *   - tenant subdomain     → branded storefront plan list (StorePricing)
 *
 * Lives at app/pricing/page.tsx so it owns the URL exclusively. The
 * subdomain rendering manually mounts BrandProvider + Header + Footer
 * since this page is outside app/(store)/.
 */
import Link from 'next/link';
import { useHostMode } from '@/components/HostAware';
import { BrandProvider } from '@/components/store/BrandContext';
import { Header } from '@/components/store/Header';
import { Footer } from '@/components/store/Footer';
import { AnnouncementBar } from '@/components/store/AnnouncementBar';
import { StorePricing } from '@/components/store/StorePricing';

/* ------------------------------------------------------------------ */
/* Marketing (root domain) — 3api.pro/pricing                           */
/* ------------------------------------------------------------------ */

interface MarketingPlan {
  name: string;
  monthly_cny: number;
  tokens_label: string;
  face_value_cny: number;
  highlight?: boolean;
  notes: string;
}

const MARKETING_PLANS: MarketingPlan[] = [
  {
    name: 'Pro',
    monthly_cny: 29,
    tokens_label: '5M tokens / 月',
    face_value_cny: 29,
    notes: '入门档，留学生/独立开发者常用',
  },
  {
    name: 'Max 5×',
    monthly_cny: 149,
    tokens_label: '25M tokens / 月',
    face_value_cny: 149,
    highlight: true,
    notes: '小团队最常买的档位',
  },
  {
    name: 'Max 20×',
    monthly_cny: 299,
    tokens_label: '100M tokens / 月',
    face_value_cny: 299,
    notes: '重度 Cursor / Claude Code 用户',
  },
  {
    name: 'Ultra',
    monthly_cny: 599,
    tokens_label: '300M tokens / 月',
    face_value_cny: 599,
    notes: '团队 / 工作室档',
  },
];

function MarketingPricing() {
  return (
    <main className="min-h-screen flex flex-col bg-background" data-marketing-pricing>
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-semibold text-brand-700">3API Panel</Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/pricing" className="text-brand-700 font-medium">价格</Link>
            <Link href="/login"   className="hover:text-brand-700">登录</Link>
            <Link href="/signup"  className="px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700">注册</Link>
          </nav>
        </div>
      </header>

      <section className="border-b border-border">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground">
            你的 Claude 中转开店平台
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            站长按 face value 批发上游额度，自由加价转售。
            利润 = 卖价 − face value，平台不抽成。
          </p>
          <div className="mt-8 flex justify-center gap-4">
            <Link href="/create"
              className="px-6 py-3 rounded-md bg-brand-600 text-white text-base font-medium hover:bg-brand-700">
              开始 →
            </Link>
            <Link href="https://github.com/3api-pro/3api-relay-panel" target="_blank" rel="noopener"
              className="px-6 py-3 rounded-md border border-input text-foreground text-base font-medium hover:bg-background">
              查看源码
            </Link>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto w-full px-6 py-16">
        <h2 className="text-2xl font-semibold text-foreground">默认套餐（站长可自定义价格）</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          以下 4 档是平台的 face value（站长进货价）。站长在自己店铺设定的零售价 = 利润来源。
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {MARKETING_PLANS.map((p) => (
            <div
              key={p.name}
              className={`relative rounded-xl border p-5 flex flex-col ${p.highlight ? 'border-2 shadow-md border-brand-600' : 'border-border'} bg-card`}
            >
              {p.highlight && (
                <div className="absolute -top-3 right-4 text-xs font-semibold rounded-full bg-brand-600 text-white px-2.5 py-0.5">
                  最常售出
                </div>
              )}
              <div className="text-lg font-semibold text-foreground">{p.name}</div>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-foreground">¥{p.monthly_cny}</span>
                <span className="text-sm text-muted-foreground">/ 月</span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">站长进货价 ¥{p.face_value_cny}</div>
              <div className="mt-4 text-sm text-foreground">{p.tokens_label}</div>
              <div className="mt-2 text-xs text-muted-foreground">{p.notes}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 text-sm text-muted-foreground">
          站长加价 multiplexing 套利 = 利润源。
          例：以 face ¥29 进货 Pro，自家店挂 ¥39 → 每卖一单赚 ¥10；
          挂 ¥59 → 赚 ¥30。利润空间由站长自己决定。
        </div>
      </section>

      <section className="border-t border-border bg-muted/30">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-semibold text-foreground">和现有方案对比</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            摘自 <Link href="https://github.com/3api-pro/3api-relay-panel/blob/main/docs/COMPARISON.md" className="underline" target="_blank" rel="noopener">docs/COMPARISON.md</Link>，完整 25 行矩阵看仓库。
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full text-sm border border-border rounded-lg overflow-hidden bg-card">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-3 px-4 font-medium">能力</th>
                  <th className="py-3 px-4 font-medium">3api / relay-panel</th>
                  <th className="py-3 px-4 font-medium">new-api</th>
                  <th className="py-3 px-4 font-medium">sub2api</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4">多租户 SaaS-ready</td>
                  <td className="py-3 px-4 font-medium">是</td>
                  <td className="py-3 px-4 text-muted-foreground">否（单租户）</td>
                  <td className="py-3 px-4 text-muted-foreground">否</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4">每个分销开独立子域</td>
                  <td className="py-3 px-4 font-medium">是 (Caddy on-demand TLS)</td>
                  <td className="py-3 px-4 text-muted-foreground">否</td>
                  <td className="py-3 px-4 text-muted-foreground">否</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4">内置上游额度池</td>
                  <td className="py-3 px-4 font-medium">是 (api.llmapi.pro/wholesale)</td>
                  <td className="py-3 px-4 text-muted-foreground">否（要自配）</td>
                  <td className="py-3 px-4">建议自配</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4">订阅 + Token 双轨计费</td>
                  <td className="py-3 px-4 font-medium">是</td>
                  <td className="py-3 px-4">部分</td>
                  <td className="py-3 px-4">是</td>
                </tr>
                <tr>
                  <td className="py-3 px-4">技术栈</td>
                  <td className="py-3 px-4">TypeScript + Postgres</td>
                  <td className="py-3 px-4 text-muted-foreground">Go + Postgres/MySQL</td>
                  <td className="py-3 px-4 text-muted-foreground">Go + Postgres</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="max-w-3xl mx-auto w-full px-6 py-16">
        <h2 className="text-2xl font-semibold text-foreground">常见问题</h2>
        <FAQ q="多久能开起来？">
          注册账号 + 配置店铺名/Logo/收款渠道，5-10 分钟可上线。
          可以先用默认 subdomain（<code className="px-1 py-0.5 bg-muted rounded text-xs">{`{slug}.3api.pro`}</code>），后面再换自定义域名（Caddy on-demand TLS 自动签）。
        </FAQ>
        <FAQ q="上游怎么保证不挂？">
          平台维护多 base 上游池（Anthropic 官方 / Claude Code 兼容多通道），任一通道挂了自动 failover。
          挂的不是中转，是上游基座。我们做的就是把 base 切换的代价从客户身上拿掉。
        </FAQ>
        <FAQ q="收款方式？">
          内置支付宝扫码 / USDT-TRC20 / USDT-ERC20；v0.2 接入 Stripe。账款直接进站长的收款账户，平台不过手。
        </FAQ>
        <FAQ q="我能自由修改套餐价格吗？">
          完全可以。后台 / Plans 任意改名字、价格、token 额度、模型 allowlist。
          face value 是平台进货价，零售价你说了算。
        </FAQ>
        <FAQ q="自定义域名怎么接？">
          站长在后台填入自己的域名 → 把 DNS A 记录指向 3api.pro 服务 IP → Caddy 自动签证书。
          整个过程无需登录 Cloudflare，无需手贴证书。
        </FAQ>
      </section>

      <footer className="border-t border-border bg-card mt-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 text-sm text-muted-foreground text-center">
          Powered by 3API Panel · Open source under MIT
        </div>
      </footer>
    </main>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="border-b border-border py-3">
      <summary className="cursor-pointer text-foreground font-medium list-none flex items-center justify-between">
        {q} <span className="text-muted-foreground ml-2">+</span>
      </summary>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Store-mode wrapper (subdomain): mount own chrome since outside (store)/ */
/* ------------------------------------------------------------------ */

function StorePricingShell() {
  return (
    <BrandProvider>
      <div className="min-h-screen flex flex-col bg-background" data-store-pricing>
        <AnnouncementBar />
        <Header />
        <main className="flex-1">
          <StorePricing />
        </main>
        <Footer />
      </div>
    </BrandProvider>
  );
}

export default function Pricing() {
  const mode = useHostMode();
  if (mode === null) return <main className="min-h-screen bg-background" />;
  return mode === 'store' ? <StorePricingShell /> : <MarketingPricing />;
}
