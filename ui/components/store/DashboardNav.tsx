'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/dashboard/keys',     label: 'API Keys' },
  { href: '/dashboard/usage',    label: '使用统计' },
  { href: '/dashboard/billing',  label: '订单 & 续费' },
  { href: '/dashboard/settings', label: '账号设置' },
];

export function DashboardNav() {
  const path = usePathname() || '';
  return (
    <nav className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <ul className="flex sm:block">
        {items.map((it) => {
          const active = path === it.href || path.startsWith(it.href + '/');
          return (
            <li key={it.href} className="flex-1">
              <Link href={it.href}
                className={`block px-4 py-3 text-sm border-b border-slate-100 last:border-b-0 ${active ? 'font-medium text-slate-900 bg-slate-50' : 'text-slate-600 hover:bg-slate-50'}`}
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
