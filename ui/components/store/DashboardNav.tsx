'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from '@/lib/i18n';

export function DashboardNav() {
  const t = useTranslations('storefront.dashboard_nav');
  const items = [
    { href: '/dashboard/keys',     label: t('keys') },
    { href: '/dashboard/usage',    label: t('usage') },
    { href: '/dashboard/billing',  label: t('billing') },
    { href: '/dashboard/settings', label: t('settings') },
  ];
  const path = usePathname() || '';
  return (
    <nav className="bg-card border border-border rounded-lg overflow-hidden">
      <ul className="flex sm:block">
        {items.map((it) => {
          const active = path === it.href || path.startsWith(it.href + '/');
          return (
            <li key={it.href} className="flex-1">
              <Link href={it.href}
                className={`block px-4 py-3 text-sm border-b border-border/50 last:border-b-0 ${active ? 'font-medium text-foreground bg-background' : 'text-muted-foreground hover:bg-background'}`}
                style={active ? { borderLeft: '3px solid var(--brand-primary, #0e9486)' } : undefined}>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
