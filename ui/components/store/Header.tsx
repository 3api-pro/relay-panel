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
  const maintenance = brand.maintenance_mode === true;
  // signup_enabled defaults to true if not present
  const signupOn = brand.signup_enabled !== false;

  return (
    <>
      {maintenance && (
        <div
          data-maintenance-banner
          role="status"
          className="text-center text-sm py-2 px-4 border-b bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-100 border-amber-300 dark:border-amber-900"
        >
          <span className="font-medium">维护中 ·</span> 服务维护中，部分功能不可用。
        </div>
      )}
      <header className="border-b border-border bg-card sticky top-0 z-30">
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
            <Link href="/pricing" className="px-2 py-1.5 text-muted-foreground hover:text-foreground hidden sm:inline">
              价格
            </Link>
            <Link href="/docs" className="px-2 py-1.5 text-muted-foreground hover:text-foreground hidden sm:inline">
              文档
            </Link>
            {authed ? (
              <>
                {!inDashboard && (
                  <Link href="/dashboard"
                    className="px-3 py-1.5 rounded-md text-sm text-white hover:opacity-90"
                    style={{ background: 'var(--brand-primary, #0e9486)' }}>
                    控制台
                  </Link>
                )}
                <button onClick={logout}
                  className="px-2 py-1.5 text-muted-foreground hover:text-red-600">
                  退出
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className="px-3 py-1.5 text-foreground hover:text-foreground">
                  登录
                </Link>
                {signupOn ? (
                  <Link href="/signup"
                    className="px-3 py-1.5 rounded-md text-sm text-white hover:opacity-90"
                    style={{ background: 'var(--brand-primary, #0e9486)' }}>
                    注册
                  </Link>
                ) : (
                  <span
                    data-signup-disabled
                    title="店铺暂停注册"
                    className="px-3 py-1.5 rounded-md text-sm bg-muted text-muted-foreground cursor-not-allowed"
                    aria-disabled="true"
                  >
                    暂停注册
                  </span>
                )}
              </>
            )}
          </nav>
        </div>
      </header>
    </>
  );
}
