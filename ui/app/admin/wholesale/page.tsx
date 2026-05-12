'use client';
/**
 * /admin/wholesale — alias for the wholesale section of /admin/finance.
 * Keeps sidebar nav clean while we plan a full split in v0.2 W3.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AdminShell } from '@/components/admin/AdminShell';
import { useTranslations } from '@/lib/i18n';

export default function WholesalePage() {
  const t = useTranslations('admin.wholesale_redirect');
  const router = useRouter();
  useEffect(() => { router.replace('/admin/finance#wholesale'); }, [router]);
  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <div className="text-sm text-muted-foreground">{t('body')}</div>
    </AdminShell>
  );
}
