'use client';
import { useEffect, useState, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { auth } from '@/lib/api';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useTranslations } from '@/lib/i18n';

interface Props {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Layout wrapper: gates on token, renders new sidebar + topbar shell.
 * - Sidebar: 4 workspace groups, collapsible on desktop, drawer on mobile (<md).
 * - TopBar: hamburger (mobile only) + breadcrumb + Cmd-K + theme + avatar.
 */
export function AdminShell({ title, subtitle, actions, children }: Props) {
  const t = useTranslations('admin.shell');
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!auth.hasToken()) {
      router.push('/admin/login');
      return;
    }
    setReady(true);
  }, [router]);

  // Close the mobile drawer when the user navigates.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted-foreground text-sm bg-background">
        {t('loading')}
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          title={title}
          subtitle={subtitle}
          actions={actions}
          onMobileMenu={() => setMobileOpen(true)}
        />
        <main className="flex-1 px-4 py-5 md:px-6 md:py-6">
          {(title || subtitle) && (
            <div className="mb-5">
              {title && <h1 className="text-2xl font-semibold text-foreground tracking-tight">{title}</h1>}
              {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
