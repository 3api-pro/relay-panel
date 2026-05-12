'use client';
/**
 * Subdomain (storefront) pricing UI — renders the tenant's configured plans.
 * Reusable component invoked from app/pricing/page.tsx in host=store mode.
 */
import { useEffect, useState } from 'react';
import { Plan, store } from '@/lib/store-api';
import { PlanCard } from '@/components/store/PlanCard';
import { Alert, Spinner } from '@/components/store/ui';
import { useTranslations } from '@/lib/i18n';

export function StorePricing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = useTranslations('storefront.pricing');
  const tCommon = useTranslations('common');

  useEffect(() => {
    store.plans()
      .then((r) => setPlans(r.data || []))
      .catch((e) => setErr(e.message));
  }, []);

  // v0.3 dual-billing: split by billing_type.
  const subPlans = (plans || []).filter(
    (p) => (p.billing_type ?? 'subscription') === 'subscription',
  );
  const packPlans = (plans || []).filter((p) => p.billing_type === 'token_pack');

  // "Recommended": middle-ish of subscription tier (token packs don't tag a
  // recommended — they're add-ons).
  const subRecommendedIdx = (() => {
    if (subPlans.length === 0) return -1;
    if (subPlans.length === 1) return 0;
    if (subPlans.length >= 4) return 1;
    return Math.floor(subPlans.length / 2);
  })();

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-3 text-muted-foreground">{t('subtitle')}</p>
      </div>

      {err && (
        <div className="mt-8 max-w-xl mx-auto">
          <Alert kind="error">{t('load_failed_prefix')}{err}</Alert>
        </div>
      )}

      {plans === null && !err && (
        <div className="mt-12 flex items-center justify-center text-muted-foreground">
          <Spinner /> <span className="ml-2 text-sm">{tCommon('loading')}</span>
        </div>
      )}

      {plans && plans.length === 0 && !err && (
        <div className="mt-12 max-w-xl mx-auto">
          <Alert kind="info">{t('empty')}</Alert>
        </div>
      )}

      {/* --- 月度订阅 -------------------------------------------------- */}
      {subPlans.length > 0 && (
        <section className="mt-12">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-xl font-semibold text-foreground">{t('section_sub')}</h2>
            <p className="text-sm text-muted-foreground hidden sm:block">{t('section_sub_desc')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {subPlans.map((p, i) => (
              <PlanCard key={p.id} plan={p} recommended={i === subRecommendedIdx} />
            ))}
          </div>
        </section>
      )}

      {/* --- Token 套餐 ------------------------------------------------ */}
      {packPlans.length > 0 && (
        <section className="mt-12">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-xl font-semibold text-foreground">{t('section_pack')}</h2>
            <p className="text-sm text-muted-foreground hidden sm:block">{t('section_pack_desc')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {packPlans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>
        </section>
      )}

      <div className="mt-16 max-w-3xl mx-auto">
        <h2 className="text-xl font-semibold text-foreground mb-4">{t('faq_title')}</h2>
        <FAQ q={t('faq_api_q')}>
          {t('faq_api_a_1')}
          {' '}{t('faq_api_a_2')}
          <code className="px-1 py-0.5 bg-muted rounded text-xs">/v1</code>
          {t('faq_api_a_3')}
          <code className="px-1 py-0.5 bg-muted rounded text-xs">sk-*</code>
          {t('faq_api_a_4')}
          <a href="/docs" className="underline">{t('faq_api_a_5')}</a>
          {t('faq_api_a_dot')}
        </FAQ>
        <FAQ q={t('faq_topup_q')}>
          {t('faq_topup_a')}
        </FAQ>
        <FAQ q={t('faq_refund_q')}>
          {t('faq_refund_a')}
        </FAQ>
        <FAQ q={t('faq_quota_q')}>
          {t('faq_quota_a')}
        </FAQ>
        <FAQ q={t('faq_contact_q')}>
          {t('faq_contact_a')}
        </FAQ>
      </div>
    </div>
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
