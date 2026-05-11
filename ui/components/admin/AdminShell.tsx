'use client';
import { useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';
import { Sidebar } from './Sidebar';

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Layout wrapper: gates on token, renders sidebar + top bar.
 * Use on every /admin/* page (except /admin/login which has no sidebar).
 */
export function AdminShell({ title, subtitle, actions, children }: Props) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!auth.hasToken()) {
      router.push('/admin/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center text-slate-500 text-sm">
        加载中…
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 flex">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <header className="bg-white border-b border-slate-200 px-8 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
            {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
        <div className="px-8 py-6">{children}</div>
      </div>
    </main>
  );
}
