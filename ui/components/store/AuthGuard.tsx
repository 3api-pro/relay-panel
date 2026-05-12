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
import { useTranslations } from '@/lib/i18n';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations('storefront.auth_guard');
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
      <div className="min-h-[60vh] flex items-center justify-center text-muted-foreground">
        <Spinner /> <span className="ml-2 text-sm">{t('loading')}</span>
      </div>
    );
  }
  return <>{children}</>;
}
