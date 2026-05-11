'use client';
/**
 * Public tenant self-signup page. Auto-generates a slug (market convention —
 * Vercel/Supabase/Netlify style). Operators can rename later from /admin/settings.
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Info {
  enabled: boolean;
  saas_domain: string | null;
  slug_auto_assigned: boolean;
}

interface Done {
  tenant_slug: string;
  store_url: string;
  login_url: string;
}

export default function CreatePanelPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/signup-tenant/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/signup-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_email: email, admin_password: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      setDone({
        tenant_slug: data.tenant.slug,
        store_url: data.store_url,
        login_url: data.login_url,
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  if (info && !info.enabled) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-lg border border-slate-200 p-8 text-center">
          <h1 className="text-xl font-semibold mb-2">注册暂未开放</h1>
          <p className="text-sm text-slate-500">
            当前 panel 运行在私有模式。操作员可设置 <code className="px-1.5 py-0.5 bg-slate-100 rounded">TENANT_SELF_SIGNUP=on</code> 开启公开注册。
          </p>
          <Link href="/" className="inline-block mt-6 text-sm text-teal-600 hover:text-teal-700">← 返回首页</Link>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
        <div className="max-w-lg w-full bg-white rounded-lg border border-slate-200 p-8">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded-full bg-teal-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-teal-600" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.4 7.4a1 1 0 0 1-1.4 0L3.3 9.5a1 1 0 1 1 1.4-1.4l3.2 3.2 6.7-6.7a1 1 0 0 1 1.4 0z" clipRule="evenodd"/>
              </svg>
            </div>
            <h1 className="text-xl font-semibold">店铺创建成功</h1>
          </div>
          <p className="text-sm text-slate-500 mb-6">你的专属子域已就绪，可以开始接客了。</p>

          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">你的店铺地址</div>
              <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50 rounded-md border border-slate-200">
                <code className="flex-1 text-sm font-mono text-slate-800 truncate">{done.store_url}</code>
                <button onClick={() => copy(done.store_url)} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">登录后台</div>
              <a
                href={done.login_url}
                className="block w-full py-2.5 text-center rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium"
              >
                进入管理后台 →
              </a>
            </div>

            <div className="pt-4 border-t border-slate-100 text-xs text-slate-500 space-y-1">
              <p>· 子域名 <strong className="text-slate-700">{done.tenant_slug}</strong> 是系统自动分配，登录后可在「设置 → 店铺信息」修改</p>
              <p>· 想用自己的域名? 设置里可绑定 CNAME（v0.2 上线）</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
      <div className="max-w-md w-full bg-white rounded-lg border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1">免费开店</h1>
        <p className="text-sm text-slate-500 mb-6">
          已有账号? <Link href="/admin/login/" className="text-teal-600 hover:text-teal-700">登录</Link>
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1.5">邮箱</div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              placeholder="you@example.com"
            />
          </label>

          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1.5">密码 <span className="text-slate-400 font-normal">(≥ 8 位)</span></div>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
            />
          </label>

          <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-3 py-2.5 leading-relaxed">
            <div className="font-medium text-slate-700 mb-0.5">系统将自动为你分配子域名</div>
            注册后可在后台修改，或绑定自己的域名（CNAME）。
          </div>

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '创建中…' : '创建店铺'}
          </button>
        </form>

        <p className="text-xs text-slate-400 mt-6 text-center">
          点击「创建店铺」即表示同意我们的 <Link href="/" className="underline">服务条款</Link>
        </p>
      </div>
    </main>
  );
}
