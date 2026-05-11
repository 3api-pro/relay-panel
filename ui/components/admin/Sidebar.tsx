'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { auth } from '@/lib/api';

interface NavItem {
  href: string;
  label: string;
  icon: string; // emoji-style glyph; svg would also work
}

const NAV: NavItem[] = [
  { href: '/admin',          label: '总览',       icon: '◫' },
  { href: '/admin/plans',    label: '套餐管理',   icon: '☰' },
  { href: '/admin/users',    label: '终端用户',   icon: '◉' },
  { href: '/admin/orders',   label: '订单',       icon: '⎙' },
  { href: '/admin/finance',  label: '财务',       icon: '$' },
  { href: '/admin/channels', label: '上游 Channel', icon: '⇄' },
  { href: '/admin/branding', label: '品牌',       icon: '◐' },
  { href: '/admin/settings', label: '账号设置',   icon: '⚙' },
];

export function Sidebar() {
  const pathname = usePathname() || '';
  const router = useRouter();

  function logout() {
    auth.clearToken();
    router.push('/');
  }

  function isActive(href: string) {
    if (href === '/admin') return pathname === '/admin' || pathname === '/admin/';
    return pathname.startsWith(href);
  }

  return (
    <aside className="w-56 shrink-0 bg-slate-900 text-slate-200 min-h-screen flex flex-col">
      <div className="px-5 py-5 border-b border-slate-800">
        <Link href="/admin" className="text-lg font-semibold text-white">3API Admin</Link>
        <div className="text-xs text-slate-400 mt-0.5">站长后台</div>
      </div>
      <nav className="flex-1 px-2 py-4 space-y-0.5 text-sm">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={
              'flex items-center gap-3 px-3 py-2 rounded-md transition-colors ' +
              (isActive(n.href)
                ? 'bg-brand-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white')
            }
          >
            <span className="w-5 text-center text-base opacity-80">{n.icon}</span>
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="px-3 py-4 border-t border-slate-800">
        <button
          onClick={logout}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          退出登录
        </button>
      </div>
    </aside>
  );
}
