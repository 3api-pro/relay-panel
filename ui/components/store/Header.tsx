'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useBrand } from './BrandContext';
import { clearToken, hasToken } from '@/lib/store-api';

export function Header() {
  const brand = useBrand();
  const router = useRouter();
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);

  useEffect(() => { setAuthed(hasToken()); }, [pathname]);

  function logout() {
    clearToken();
    setAuthed(false);
    router.push('/');
  }

  const inDashboard = pathname?.startsWith('/dashboard');

  return (
    <header className="border-b border-slate-200 bg-white sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 min-w-0">
          {brand.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo_url} alt="" className="h-8 w-8 rounded object-cover" />
          ) : (
            <div className="h-8 w-8 rounded flex items-center justify-center text-white text-sm font-bold"
                 style={{ background: 'var(--brand-primary, #0e9486)' }}>
              {(brand.store_name || 'A').slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="font-semibold text-base sm:text-lg truncate">
            {brand.store_name || 'AI API'}
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-3 text-sm">
          <Link href="/pricing" className="px-2 py-1.5 text-slate-600 hover:text-slate-900 hidden sm:inline">
            价格
          </Link>
          <Link href="/docs" className="px-2 py-1.5 text-slate-600 hover:text-slate-900 hidden sm:inline">
            文档
          </Link>
          {authed ? (
            <>
              {!inDashboard && (
                <Link href="/dashboard/keys"
                  className="px-3 py-1.5 rounded-md text-sm text-white hover:opacity-90"
                  style={{ background: 'var(--brand-primary, #0e9486)' }}>
                  控制台
                </Link>
              )}
              <button onClick={logout}
                className="px-2 py-1.5 text-slate-500 hover:text-red-600">
                退出
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="px-3 py-1.5 text-slate-700 hover:text-slate-900">
                登录
              </Link>
              <Link href="/signup"
                className="px-3 py-1.5 rounded-md text-sm text-white hover:opacity-90"
                style={{ background: 'var(--brand-primary, #0e9486)' }}>
                注册
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
