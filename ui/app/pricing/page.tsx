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
import { ThemeToggle } from '@/components/ThemeToggle';
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
      <header className="sticky top-0 z-50 border-b border-border bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70">
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center font-semibold text-foreground text-base">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-teal-600 to-teal-400 text-white text-xs font-bold mr-2.5">3</span>
            3API Panel
          </Link>
          <nav className="flex items-center gap-0.5 text-sm">
            <Link href="/pricing" className="px-2.5 py-2 text-foreground rounded-md hover:bg-accent transition-colors">{t('nav_pricing')}</Link>
            <a href="https://github.com/3api-pro/relay-panel#readme" target="_blank" rel="noopener" className="px-2.5 py-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors hidden sm:inline-block">{t('nav_docs')}</a>
            <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener" className="px-2.5 py-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors hidden sm:inline-block">GitHub</a>
            <Link href="/login" className="px-2.5 py-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">{t('nav_login')}</Link>
            <Link href="/create" className="ml-1.5 px-3.5 py-2 rounded-md bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors">{t('nav_signup')}</Link>
            <span className="inline-flex items-center gap-0.5 ml-1.5">
              <LanguageSwitcher />
              <ThemeToggle />
            </span>
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

      {/* Second compare table removed in v0.8.4 — was a duplicate of the
          i18n'd one above; kept causing inconsistent terminology and didn't
          add new information. */}

      <section className="max-w-3xl mx-auto w-full px-6 py-16">
        <h2 className="text-2xl font-semibold text-foreground">常见问题</h2>
        <FAQ q="多久可以上线？">
          创建账户后填入站点名、Logo、收款渠道，约 5–10 分钟即可对外提供服务。可先使用默认子域名
          (<code className="px-1 py-0.5 bg-muted rounded text-xs">{`{slug}.3api.pro`}</code>)
          ，后续在管理后台绑定自定义域名（自动签发并续期 TLS 证书）。
        </FAQ>
        <FAQ q="上游稳定性如何保障？">
          平台维护多通道上游池（Anthropic 官方 + Claude Code 兼容多通道），任一通道异常将自动 failover
          到可用通道。base 切换由平台承担，对终端用户透明。
        </FAQ>
        <FAQ q="支持哪些收款方式？">
          内置支付宝扫码、USDT-TRC20 / USDT-ERC20。Stripe 接入将在后续版本提供。款项直接结算至运营方账户，平台不过手。
        </FAQ>
        <FAQ q="可以自定义套餐价格吗？">
          可以。管理后台 → 套餐 可调整名称、价格、Token 额度、模型 allowlist。基础价为平台批发价，对外零售价由运营方自定。
        </FAQ>
        <FAQ q="如何接入自定义域名？">
          管理后台填入域名，将 DNS A 记录指向 3api.pro 的服务 IP，Caddy 将自动签发并续期 TLS 证书，无需手动配置。
        </FAQ>
        <FAQ q="可以同时使用平台批发上游与自有 key (BYOK) 吗？">
          可以。在「上游 Channel」新增一个 BYOK channel（填入自有 Anthropic / OpenAI key）并设置优先级。
          系统按优先级 + 模型 allowlist 选择通道，单通道失败时自动 failover 至下一通道。
        </FAQ>
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
