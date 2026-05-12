'use client';
import Link from 'next/link';
import { Plan, fmtCents, fmtTokens, parseAllowedModels } from '@/lib/store-api';
import { Badge } from './ui';
import { useTranslations } from '@/lib/i18n';

export function PlanCard({ plan, recommended = false }: { plan: Plan; recommended?: boolean }) {
  const models = parseAllowedModels(plan.allowed_models);
  const isPack = plan.billing_type === 'token_pack';
  const t = useTranslations('storefront.plan_card');
  return (
    <div className={`relative rounded-xl border bg-card p-6 flex flex-col ${recommended ? 'border-2 shadow-md' : 'border-border'}`}
         style={recommended ? { borderColor: 'var(--brand-primary, #0e9486)' } : undefined}>
      {recommended && (
        <div className="absolute -top-3 right-4">
          <Badge tone="brand">{t('badge_recommended')}</Badge>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold text-foreground">{plan.name}</div>
        {/* v0.3 billing-type badge — distinguishes 订阅 vs token pack at a glance */}
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          isPack
            ? 'border-amber-300 bg-amber-50 text-amber-700'
            : 'border-emerald-300 bg-emerald-50 text-emerald-700'
        }`}>
          {isPack ? t('badge_pack') : t('badge_sub')}
        </span>
      </div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-foreground">{fmtCents(plan.price_cents)}</span>
        <span className="text-sm text-muted-foreground">
          {isPack ? t('one_time') : t('per_days_suffix', { days: plan.period_days })}
        </span>
      </div>
      <ul className="mt-5 space-y-2 text-sm text-foreground flex-1">
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>
            {fmtTokens(plan.quota_tokens)} {isPack ? t('tokens_pack_suffix') : t('tokens_sub_suffix')}
          </span>
        </li>
        {isPack && (
          <li className="flex items-start gap-2">
            <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
            <span>{t('no_month_limit')}</span>
          </li>
        )}
        {models.length > 0 && (
          <li className="flex items-start gap-2">
            <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
            <span className="break-all">
              {t('models_support', {
                models: models.slice(0, 3).join(', ') + (models.length > 3 ? '…' : ''),
              })}
            </span>
          </li>
        )}
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>{t('anthropic_compat')}</span>
        </li>
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>{t('multi_key')}</span>
        </li>
      </ul>
      <Link href={`/signup?plan=${plan.slug}`}
        className="mt-6 inline-flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium text-white hover:opacity-90"
        style={{ background: 'var(--brand-primary, #0e9486)' }}>
        {isPack ? t('cta_pack') : t('cta_sub')}
      </Link>
    </div>
  );
}
