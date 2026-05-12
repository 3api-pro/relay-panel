'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from '@/lib/i18n';

export default function OnboardingRoot() {
  const t = useTranslations('admin.onboarding_root');
  const router = useRouter();
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('onboarding_step') : null;
    const step = saved && /^[1-5]$/.test(saved) ? saved : '1';
    router.replace(`/admin/onboarding/${step}`);
  }, [router]);
  return (
    <main className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
      {t('redirecting')}
    </main>
  );
}
