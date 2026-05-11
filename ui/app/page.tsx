'use client';
/**
 * Top-level "/" page. Host-aware: subdomains see the brand store landing,
 * the root marketing domain sees the 3api marketing page. See HostAware.tsx
 * for the rationale (Task #17).
 */
import Link from 'next/link';
import { useHostMode } from '@/components/HostAware';
import { StoreLanding } from '@/components/store/StoreLanding';

function Marketing() {
  return (
    <main className="min-h-screen flex flex-col" data-marketing-landing>
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold text-brand-700">3API Panel</div>
          <nav className="flex gap-4 text-sm">
            <Link href="/pricing" className="hover:text-brand-700">价格</Link>
            <Link href="/login"   className="hover:text-brand-700">登录</Link>
            <Link href="/signup"  className="px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700">注册</Link>
          </nav>
        </div>
      </header>

      <section className="flex-1 flex items-center">
        <div className="max-w-4xl mx-auto px-6 py-20 text-center">
          <h1 className="text-5xl font-bold tracking-tight text-slate-900">
            Opus 级体验, Claude API 兼容
          </h1>
          <p className="mt-6 text-xl text-slate-600">
            按 token 计费, 包月套餐任选。Claude Code、Cursor、Cline 等开箱即用。
          </p>
          <div className="mt-10 flex justify-center gap-4">
            <Link href="/signup"
              className="px-6 py-3 rounded-md bg-brand-600 text-white text-lg hover:bg-brand-700">
              立即开始
            </Link>
            <Link href="/pricing"
              className="px-6 py-3 rounded-md border border-slate-300 text-slate-700 text-lg hover:bg-slate-50">
              查看价格
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-6 text-sm text-slate-500 text-center">
          Powered by 3API Panel · Open source under MIT
        </div>
      </footer>
    </main>
  );
}

export default function Landing() {
  const mode = useHostMode();
  if (mode === null) {
    // Pre-hydration: render a tiny neutral shell so neither variant flashes.
    return <main className="min-h-screen bg-slate-50" />;
  }
  return mode === 'store' ? <StoreLanding /> : <Marketing />;
}
