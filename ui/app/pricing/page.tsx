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
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useTranslations } from '@/lib/i18n';

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
  const t = useTranslations('storefront.marketing_pricing');
  return (
    <main className="min-h-screen flex flex-col bg-background" data-marketing-pricing>
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-semibold text-brand-700">3API Panel</Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/pricing" className="text-brand-700 font-medium">{t('nav_pricing')}</Link>
            <Link href="/login"   className="hover:text-brand-700">{t('nav_login')}</Link>
            <Link href="/signup"  className="px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700">{t('nav_signup')}</Link>
            <LanguageSwitcher />
          </nav>
        </div>
      </header>

      <section className="border-b border-border">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground">
            {t('hero_title')}
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            {t('hero_body_pre')}<span className="font-semibold text-brand-700">{t('hero_body_strong')}</span>{t('hero_body_post')}
          </p>
          <div className="mt-8 flex justify-center gap-4 flex-wrap">
            <Link href="/create"
              className="px-6 py-3 rounded-md bg-brand-600 text-white text-base font-medium hover:bg-brand-700">
              {t('cta_create')}
            </Link>
            <Link href="https://github.com/3api-pro/3api-relay-panel" target="_blank" rel="noopener"
              className="px-6 py-3 rounded-md border border-input text-foreground text-base font-medium hover:bg-background">
              {t('cta_byok')}
            </Link>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-muted/30">
        <div className="max-w-5xl mx-auto px-6 py-14">
          <h2 className="text-2xl font-semibold text-foreground text-center">{t('compare_title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground text-center">
            {t('compare_subtitle_pre')}<Link href="https://github.com/3api-pro/relay-panel/blob/main/docs/COMPARISON.md" className="underline" target="_blank" rel="noopener">{t('compare_subtitle_link')}</Link>{t('compare_subtitle_post')}
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full text-sm border border-border rounded-lg overflow-hidden bg-card">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border bg-muted/40">
                  <th className="py-3 px-4 font-medium"></th>
                  <th className="py-3 px-4 font-medium text-brand-700">{t('compare_th_3api')}</th>
                  <th className="py-3 px-4 font-medium">{t('compare_th_newapi')}</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4 text-muted-foreground">{t('compare_row1_label')}</td>
                  <td className="py-3 px-4 font-medium">{t('compare_row1_3api')}</td>
                  <td className="py-3 px-4">{t('compare_row1_newapi')}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4 text-muted-foreground">{t('compare_row2_label')}</td>
                  <td className="py-3 px-4 font-medium">{t('compare_row2_3api')}</td>
                  <td className="py-3 px-4">{t('compare_row2_newapi')}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 px-4 text-muted-foreground">{t('compare_row3_label')}</td>
                  <td className="py-3 px-4 font-medium">{t('compare_row3_3api')}</td>
                  <td className="py-3 px-4">{t('compare_row3_newapi')}</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-muted-foreground">{t('compare_row4_label')}</td>
                  <td className="py-3 px-4 font-medium">{t('compare_row4_3api')}</td>
                  <td className="py-3 px-4">{t('compare_row4_newapi')}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground text-center">
            {t('compare_footnote')}
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto w-full px-6 py-16">
        <h2 className="text-2xl font-semibold text-foreground">{t('plans_title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('plans_subtitle')}
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {MARKETING_PLANS.map((p) => (
            <div
              key={p.name}
              className={`relative rounded-xl border p-5 flex flex-col ${p.highlight ? 'border-2 shadow-md border-brand-600' : 'border-border'} bg-card`}
            >
              {p.highlight && (
                <div className="absolute -top-3 right-4 text-xs font-semibold rounded-full bg-brand-600 text-white px-2.5 py-0.5">
                  {t('most_sold')}
                </div>
              )}
              <div className="text-lg font-semibold text-foreground">{p.name}</div>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-foreground">¥{p.monthly_cny}</span>
                <span className="text-sm text-muted-foreground">{t('per_month')}</span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">{t('face_value_prefix')}{p.face_value_cny}</div>
              <div className="mt-4 text-sm text-foreground">{p.tokens_label}</div>
              <div className="mt-2 text-xs text-muted-foreground">{p.notes}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 text-sm text-muted-foreground">
          {t('profit_explain')}
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
        <FAQ q="我可以同时用 llmapi 推荐上游 + 自己的 key (BYOK) 吗？">
          可以。后台 Channels 里加一个 BYOK channel (粘贴你的 Anthropic / OpenAI key), 给它设 priority。
          系统按 priority + 模型 allowlist 选最便宜的通道；任一通道失败自动 failover 到下一个。
          推荐策略：BYOK 走小流量降本, llmapi 批发兜底高峰。</FAQ>
      </section>

      <footer className="border-t border-border bg-card mt-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 text-sm text-muted-foreground text-center">
          {t('footer')}
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
