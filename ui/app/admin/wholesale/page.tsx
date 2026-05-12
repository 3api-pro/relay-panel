'use client';
/**
 * /admin/wholesale — alias for the wholesale section of /admin/finance.
 * Keeps sidebar nav clean while we plan a full split in v0.2 W3.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AdminShell } from '@/components/admin/AdminShell';

export default function WholesalePage() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/finance#wholesale'); }, [router]);
  return (
    <AdminShell title="批发余额" subtitle="跳转到财务页…">
      <div className="text-sm text-muted-foreground">正在跳转 /admin/finance#wholesale …</div>
    </AdminShell>
  );
}
