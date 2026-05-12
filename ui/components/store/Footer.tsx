'use client';
import { useBrand } from './BrandContext';
import { useTranslations } from '@/lib/i18n';

export function Footer() {
  const t = useTranslations('storefront.footer');
  const brand = useBrand();
  return (
    <footer className="border-t border-border bg-card mt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 text-sm text-muted-foreground">
        {brand.footer_html ? (
          <div dangerouslySetInnerHTML={{ __html: brand.footer_html }} />
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              © {new Date().getFullYear()} {brand.store_name || t('default_shop_name')}.
              {brand.contact_email && <> · {t('contact_prefix')}<a className="hover:underline" href={`mailto:${brand.contact_email}`}>{brand.contact_email}</a></>}
            </div>
            <div className="text-xs">
              {t('powered_by_prefix')}<a href="https://github.com/3api-pro/relay-panel" className="hover:underline">3api</a>
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
