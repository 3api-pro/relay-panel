'use client';
import { useBrand } from './BrandContext';

export function AnnouncementBar() {
  const brand = useBrand();
  if (!brand.announcement) return null;
  return (
    <div className="text-center text-sm py-2 px-4 text-white"
         style={{ background: 'var(--brand-primary, #0e9486)' }}>
      {brand.announcement}
    </div>
  );
}
