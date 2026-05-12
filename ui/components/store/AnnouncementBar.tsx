'use client';
/**
 * AnnouncementBar — surfaces either a system-level (platform-set) announcement
 * or a tenant-owned announcement. System wins to avoid stacking banners; level
 * controls colour.
 */
import { useBrand } from './BrandContext';

type Level = 'info' | 'warn' | 'error';

const LEVEL_CLASSES: Record<Level, string> = {
  info:  'bg-blue-50 dark:bg-blue-950 text-blue-900 dark:text-blue-100 border-blue-200 dark:border-blue-900',
  warn:  'bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-100 border-amber-200 dark:border-amber-900',
  error: 'bg-red-50 dark:bg-red-950 text-red-900 dark:text-red-100 border-red-200 dark:border-red-900',
};

function normalizeLevel(v: unknown): Level {
  if (v === 'warn' || v === 'error' || v === 'info') return v;
  return 'info';
}

export function AnnouncementBar() {
  const brand = useBrand();
  const sys = (brand.system_announcement || '').trim();
  const tenant = (brand.announcement || '').trim();

  // System-level wins over tenant. (Avoid stacking two banners.)
  if (sys) {
    const lvl = normalizeLevel(brand.system_announcement_level);
    return (
      <div
        role="status"
        data-system-announcement
        className={`text-center text-sm py-2 px-4 border-b ${LEVEL_CLASSES[lvl]}`}
      >
        {sys}
      </div>
    );
  }
  if (tenant) {
    // Tenant announcement keeps the historical brand-primary background.
    return (
      <div
        className="text-center text-sm py-2 px-4 text-white"
        style={{ background: 'var(--brand-primary, #0e9486)' }}
      >
        {tenant}
      </div>
    );
  }
  return null;
}
