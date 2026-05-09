'use client';
import { useState, useEffect } from 'react';

interface Info {
  enabled: boolean;
  saas_domain: string | null;
  reserved_slugs: string[];
}

export default function CreatePanelPage() {
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [done, setDone] = useState<{ login_url: string; tenant_slug: string } | null>(null);

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
        body: JSON.stringify({ slug, admin_email: email, admin_password: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      setDone({ login_url: data.login_url, tenant_slug: data.tenant.slug });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (info && !info.enabled) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
        <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8 text-center">
          <h1 className="text-2xl font-semibold mb-2">面板自助开通暂未开放</h1>
          <p className="text-slate-600 text-sm">
            如需开通分销面板, 请联系 <a className="text-brand-600" href="https://github.com/3api-pro/relay-panel/issues">GitHub Issues</a>。
          </p>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
        <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-semibold mb-3">✓ 开通成功</h1>
          <p className="text-slate-600 mb-2">你的面板已就绪:</p>
          <p className="font-mono text-sm bg-slate-100 p-2 rounded mb-4">
            https://{done.tenant_slug}.{info?.saas_domain ?? '...'}
          </p>
          <p className="text-sm text-slate-600 mb-6">
            用刚刚的邮箱 + 密码登录管理后台:
          </p>
          <a
            href={done.login_url}
            className="block w-full text-center px-4 py-2.5 rounded-md bg-brand-600 text-white hover:bg-brand-700"
          >
            前往登录 →
          </a>
        </div>
      </main>
    );
  }

  const slugPreview = slug && info?.saas_domain ? `${slug}.${info.saas_domain}` : '';

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-slate-50 py-12">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-semibold mb-1">开通你的分销面板</h1>
        <p className="text-sm text-slate-500 mb-6">
          5 秒注册, 立刻获得专属子域。免费开店, 仅按使用付费。
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">面板名称 (subdomain)</div>
            <div className="flex items-center">
              <input
                type="text"
                required
                pattern="[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?"
                title="1-32 字符, 只能含小写字母数字和短横线, 首尾必须是字母或数字"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="acme"
                className="flex-1 px-3 py-2 rounded-l-md border border-slate-300 focus:border-brand-500 focus:outline-none font-mono text-sm"
              />
              <span className="px-3 py-2 bg-slate-100 border border-l-0 border-slate-300 rounded-r-md text-sm text-slate-600 font-mono">
                .{info?.saas_domain ?? '...'}
              </span>
            </div>
            {slugPreview && (
              <div className="mt-1 text-xs text-slate-500">
                你的面板地址: <span className="font-mono">https://{slugPreview}</span>
              </div>
            )}
          </label>

          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">管理员邮箱</div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-brand-500 focus:outline-none"
            />
          </label>

          <label className="block">
            <div className="text-sm font-medium text-slate-700 mb-1">密码 (≥8 位)</div>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-brand-500 focus:outline-none"
            />
          </label>

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? '开通中…' : '免费开通'}
          </button>
        </form>

        <p className="mt-6 text-xs text-slate-500 text-center">
          已有面板? <a href="/" className="text-brand-600">返回首页</a>
        </p>
      </div>
    </main>
  );
}
