/**
 * Storefront layout — applies to every route under app/(store)/.
 *
 * The Next.js build target is `output: 'export'` (static), so /brand
 * is fetched on the client. Defaults render immediately; the brand
 * (logo, color, store name, announcement) hydrates a beat later.
 *
 * NOTE: this is a NESTED layout. The root <html>/<body> live in
 * app/layout.tsx; we only wrap children in our context + chrome.
 */
'use client';

import { BrandProvider } from '@/components/store/BrandContext';
import { Header } from '@/components/store/Header';
import { Footer } from '@/components/store/Footer';
import { AnnouncementBar } from '@/components/store/AnnouncementBar';

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <BrandProvider>
      <div className="min-h-screen flex flex-col bg-slate-50">
        <AnnouncementBar />
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </div>
    </BrandProvider>
  );
}
