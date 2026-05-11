'use client';
/**
 * BrandContext — client-side fetch of /storefront/brand once per page
 * and exposed via React context. The Next.js export is static (no SSR),
 * so brand colors are applied on hydration rather than at SSR time.
 */
import { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { store, type Brand } from '@/lib/store-api';

const DEFAULT: Brand = {
  store_name: null,
  logo_url: null,
  primary_color: '#0e9486',
  announcement: null,
  footer_html: null,
  contact_email: null,
};

const Ctx = createContext<Brand>(DEFAULT);

export function useBrand(): Brand {
  return useContext(Ctx);
}

export function BrandProvider({ children }: { children: React.ReactNode }) {
  const [brand, setBrand] = useState<Brand>(DEFAULT);

  useEffect(() => {
    let cancelled = false;
    store.brand().then((b) => {
      if (cancelled) return;
      setBrand({
        store_name: b.store_name || null,
        logo_url: b.logo_url || null,
        primary_color: b.primary_color || DEFAULT.primary_color,
        announcement: b.announcement || null,
        footer_html: b.footer_html || null,
        contact_email: b.contact_email || null,
      });
    }).catch(() => { /* gracefully fall back to defaults */ });
    return () => { cancelled = true; };
  }, []);

  // Apply --brand-primary to document root for child components
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (brand.primary_color) {
      document.documentElement.style.setProperty('--brand-primary', brand.primary_color);
    }
    if (brand.store_name) {
      document.title = brand.store_name;
    }
  }, [brand.primary_color, brand.store_name]);

  const value = useMemo(() => brand, [brand]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
