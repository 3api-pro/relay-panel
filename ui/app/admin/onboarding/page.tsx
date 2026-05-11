'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OnboardingRoot() {
  const router = useRouter();
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('onboarding_step') : null;
    const step = saved && /^[1-5]$/.test(saved) ? saved : '1';
    router.replace(`/admin/onboarding/${step}`);
  }, [router]);
  return (
    <main className="min-h-screen flex items-center justify-center text-slate-500 text-sm">
      正在跳转到向导…
    </main>
  );
}
