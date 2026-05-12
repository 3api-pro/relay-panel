'use client';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * Public model catalogue.
 *
 * Why static + hard-coded:
 *   - This is a marketing page; the storefront for each tenant is at /pricing.
 *   - Pricing is a single flat rate (input ¥1/M, output ¥5/M) wired in
 *     src/services/billing.ts. When per-model pricing lands in v0.8, swap
 *     the constants here and wire to /api/public/models — keep the table
 *     shape the same.
 *   - Static export keeps it cacheable on the CDN without an API hit.
 */
type Mode = 'wholesale' | 'byok';

interface ModelRow {
  id: string;
  provider: string;
  contextK: number;     // context window in K tokens
  mode: Mode;
}

// Unified default; resellers can override per plan.
const INPUT_CPM = 100;   // cents per million
const OUTPUT_CPM = 500;

const MODELS: ModelRow[] = [
  // Anthropic — wholesale upstream baked into llmapi.pro
  { id: 'claude-opus-4-7',       provider: 'Anthropic',  contextK: 200, mode: 'wholesale' },
  { id: 'claude-sonnet-4-7',     provider: 'Anthropic',  contextK: 200, mode: 'wholesale' },
  { id: 'claude-sonnet-4-6',     provider: 'Anthropic',  contextK: 200, mode: 'wholesale' },
  { id: 'claude-haiku-4-5',      provider: 'Anthropic',  contextK: 200, mode: 'wholesale' },
  // BYOK — bring-your-own-key channels
  { id: 'gpt-4o',                provider: 'OpenAI',     contextK: 128, mode: 'byok' },
  { id: 'gpt-4o-mini',           provider: 'OpenAI',     contextK: 128, mode: 'byok' },
  { id: 'gemini-2.5-pro',        provider: 'Google',     contextK: 1024, mode: 'byok' },
  { id: 'deepseek-chat',         provider: 'DeepSeek',   contextK: 64,  mode: 'byok' },
  { id: 'moonshot-v1-128k',      provider: 'Moonshot',   contextK: 128, mode: 'byok' },
  { id: 'qwen-max',              provider: 'Alibaba',    contextK: 32,  mode: 'byok' },
  { id: 'minimax-m2.7',          provider: 'MiniMax',    contextK: 200, mode: 'byok' },
];

function fmtPriceCpm(cents: number): string {
  // ¥X per 1M tokens. cents → yuan: /100.
  const yuan = cents / 100;
  return `¥${yuan.toFixed(yuan < 10 ? 2 : 0)}`;
}

export default function ModelsPage() {
  const t = useTranslations('models');
  const tCommon = useTranslations('common');

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-semibold text-sm tracking-tight">3API Panel</Link>
          <div className="flex items-center gap-2 text-sm">
            <Link href="/pricing" className="text-muted-foreground hover:text-foreground transition-colors">{t('nav_pricing')}</Link>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <section className="max-w-5xl mx-auto px-6 py-12">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl">{t('subtitle')}</p>

        {/* Wholesale vs BYOK explainer */}
        <div className="grid sm:grid-cols-2 gap-3 mt-6">
          <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-semibold">{t('mode_wholesale')}</div>
            <p className="text-sm mt-1.5">{t('mode_wholesale_desc')}</p>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{t('mode_byok')}</div>
            <p className="text-sm mt-1.5">{t('mode_byok_desc')}</p>
          </div>
        </div>

        <div className="mt-8 border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t('col_model')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('col_provider')}</th>
                <th className="text-right px-4 py-3 font-medium hidden sm:table-cell">{t('col_context')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('col_input')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('col_output')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('col_mode')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MODELS.map((m) => (
                <tr key={m.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3"><code className="text-xs">{m.id}</code></td>
                  <td className="px-4 py-3 text-muted-foreground">{m.provider}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground tabular-nums hidden sm:table-cell">{m.contextK}K</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtPriceCpm(INPUT_CPM)}<span className="text-xs text-muted-foreground"> / M</span></td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtPriceCpm(OUTPUT_CPM)}<span className="text-xs text-muted-foreground"> / M</span></td>
                  <td className="px-4 py-3">
                    {m.mode === 'wholesale'
                      ? <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{t('badge_wholesale')}</span>
                      : <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">{t('badge_byok')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">{t('footnote_pricing')}</p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/pricing" className="inline-flex items-center px-5 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">
            {t('cta_pricing')}
          </Link>
          <Link href="/create" className="inline-flex items-center px-5 py-2.5 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent">
            {t('cta_create_store')}
          </Link>
        </div>
      </section>

      <footer className="border-t border-border mt-12 py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} 3API Panel · <Link href="https://github.com/3api-pro/relay-panel" className="hover:text-foreground">GitHub</Link>
      </footer>
    </main>
  );
}
