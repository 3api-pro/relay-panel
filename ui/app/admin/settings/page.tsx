'use client';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api, safe, auth } from '@/lib/api';

interface Me {
  admin?: { email: string };
  tenant?: { slug: string; saas_domain?: string | null };
}

export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    safe(api<Me>('/admin/me'), { admin: { email: '' }, tenant: { slug: '' } }).then(setMe);
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwBusy(true); setPwMsg(''); setPwErr('');
    try {
      await api('/admin/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      setPwMsg('✓ 已修改 — 下次登录使用新密码');
      setOldPw(''); setNewPw('');
    } catch (e: any) {
      setPwErr(`修改失败（后端接口可能未上线）：${e.message}`);
    } finally {
      setPwBusy(false);
    }
  }

  function deleteAccount() {
    const slug = me?.tenant?.slug ?? '';
    const v = prompt(`此操作将注销整个店铺，不可恢复。请输入店铺 slug 「${slug}」以确认：`);
    if (v !== slug) {
      alert('slug 不匹配，操作取消');
      return;
    }
    alert('删除账号功能将在 v0.2 接入审计流程后上线。当前阶段如确需删除请联系平台。');
  }

  return (
    <AdminShell title="账号设置" subtitle="登录邮箱 / 密码 / API 接入 / 危险操作">
      <div className="space-y-6 max-w-3xl">
        <Section title="账户信息">
          <Row label="登录邮箱" value={me?.admin?.email ?? '—'} />
          <Row label="店铺 slug" value={me?.tenant?.slug ?? '—'} mono />
          <Row label="自定义域名" value={me?.tenant?.saas_domain ?? '未绑定（默认走 <slug>.3api.pro）'} />
        </Section>

        <Section title="修改密码">
          <form onSubmit={changePassword} className="space-y-3 text-sm">
            <input type="password" required placeholder="当前密码" value={oldPw} onChange={(e) => setOldPw(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300" />
            <input type="password" required minLength={6} placeholder="新密码（≥6 位）" value={newPw} onChange={(e) => setNewPw(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-slate-300" />
            <div className="flex items-center justify-between">
              <div className="text-xs">
                {pwMsg && <span className="text-emerald-600">{pwMsg}</span>}
                {pwErr && <span className="text-amber-700">{pwErr}</span>}
              </div>
              <button disabled={pwBusy}
                className="px-4 py-1.5 rounded-md bg-slate-800 text-white text-sm hover:bg-slate-900 disabled:opacity-50">
                {pwBusy ? '修改中…' : '保存新密码'}
              </button>
            </div>
          </form>
        </Section>

        <Section title="二步验证（占位）">
          <p className="text-sm text-slate-500">
            2FA 将在 v0.2 接入。当前请确保使用强密码 + 邮箱安全。
          </p>
        </Section>

        <Section title="API 文档 / Webhook">
          <div className="space-y-1.5 text-sm">
            <a href="/api/openapi" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
              查看 OpenAPI 描述
            </a>
            <div className="text-xs text-slate-500">
              Webhook 用于把订单 / 用户事件推到你的服务（v0.2 提供）。
            </div>
          </div>
        </Section>

        <Section title="危险操作" danger>
          <p className="text-sm text-rose-700 mb-3">
            注销店铺会清除所有用户、订单、订阅记录，且不可恢复。
          </p>
          <button onClick={deleteAccount}
            className="px-4 py-1.5 rounded-md border border-rose-300 text-rose-700 text-sm hover:bg-rose-50">
            注销店铺
          </button>
        </Section>
      </div>
    </AdminShell>
  );
}

function Section({ title, children, danger }: { title: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <section className={
      'bg-white rounded-lg border p-5 ' +
      (danger ? 'border-rose-200' : 'border-slate-200')
    }>
      <h2 className={'font-semibold mb-3 ' + (danger ? 'text-rose-700' : 'text-slate-900')}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center py-1.5 text-sm">
      <div className="w-28 text-slate-500">{label}</div>
      <div className={mono ? 'font-mono text-slate-800' : 'text-slate-800'}>{value}</div>
    </div>
  );
}
