'use client';
/**
 * Client-side auth guard. Redirects unauthenticated visitors to /login
 * with ?next=<current path>. Children render only once we know the user
 * is authed — so first-paint flashes a "loading" state, not a 401 page.
 */
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { hasToken } from '@/lib/store-api';
import { Spinner } from './ui';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (hasToken()) {
      setOk(true);
    } else {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [router, pathname]);

  if (!ok) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-400">
        <Spinner /> <span className="ml-2 text-sm">加载中…</span>
      </div>
    );
  }
  return <>{children}</>;
}
