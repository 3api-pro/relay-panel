'use client';
import { useBrand } from './BrandContext';

export function Footer() {
  const brand = useBrand();
  return (
    <footer className="border-t border-slate-200 bg-white mt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 text-sm text-slate-500">
        {brand.footer_html ? (
          <div dangerouslySetInnerHTML={{ __html: brand.footer_html }} />
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              © {new Date().getFullYear()} {brand.store_name || 'AI API'}.
              {brand.contact_email && <> · 联系: <a className="hover:underline" href={`mailto:${brand.contact_email}`}>{brand.contact_email}</a></>}
            </div>
            <div className="text-xs">
              Powered by <a href="https://github.com/3api-pro/relay-panel" className="hover:underline">3api</a>
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
