'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearToken, storeFetch } from '@/lib/store-api';
import { AuthGuard } from '@/components/store/AuthGuard';
import { DashboardNav } from '@/components/store/DashboardNav';
import { Card, Button, Input, Alert, Modal, Spinner } from '@/components/store/ui';

export default function SettingsPage() {
  return (
    <AuthGuard>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-slate-900 mb-6">控制台</h1>
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
          <DashboardNav />
          <SettingsInner />
        </div>
      </div>
    </AuthGuard>
  );
}

function SettingsInner() {
  const router = useRouter();
  const [me, setMe] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [openDelete, setOpenDelete] = useState(false);

  useEffect(() => {
    // best-effort fetch — endpoint might be /me or /auth/me
    (async () => {
      try {
        const r = await storeFetch<any>('/me');
        setMe(r);
      } catch {
        try {
          const r = await storeFetch<any>('/auth/me');
          setMe(r);
        } catch {
          setMe({ email: '—' });
        }
      }
    })();
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    if (newPwd.length < 6) { setErr('新密码至少 6 位'); return; }
    if (newPwd !== newPwd2) { setErr('两次输入不一致'); return; }
    setBusy(true);
    try {
      await storeFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      setMsg('密码已更新');
      setOldPwd(''); setNewPwd(''); setNewPwd2('');
    } catch (e: any) {
      if (e?.status === 404) setErr('该后端暂未开放密码修改接口, 请联系客服。');
      else setErr(e?.message || '修改失败');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setBusy(true); setErr(null);
    try {
      await storeFetch('/auth/delete-account', { method: 'POST' });
      clearToken();
      router.push('/');
    } catch (e: any) {
      if (e?.status === 404) {
        setErr('该后端暂未开放自助删除, 请发送邮件至 contact 客服。');
      } else {
        setErr(e?.message || '删除失败');
      }
    } finally {
      setBusy(false);
      setOpenDelete(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="账号信息">
        {!me ? (
          <div className="flex items-center text-slate-400 text-sm"><Spinner /> <span className="ml-2">加载中…</span></div>
        ) : (
          <dl className="text-sm space-y-2">
            <div className="flex">
              <dt className="w-24 text-slate-500">邮箱</dt>
              <dd className="text-slate-900">{me.email || '—'}</dd>
            </div>
            {me.created_at && (
              <div className="flex">
                <dt className="w-24 text-slate-500">注册时间</dt>
                <dd className="text-slate-900">{me.created_at}</dd>
              </div>
            )}
            {me.aff_code && (
              <div className="flex">
                <dt className="w-24 text-slate-500">邀请码</dt>
                <dd><code className="text-xs bg-slate-100 px-2 py-0.5 rounded">{me.aff_code}</code></dd>
              </div>
            )}
          </dl>
        )}
        <div className="text-xs text-slate-500 mt-3">邮箱地址绑定后不可修改; 如需更换请联系客服。</div>
      </Card>

      <Card title="修改密码">
        <form onSubmit={changePassword} className="space-y-3 max-w-md">
          <Input label="当前密码" type="password" required value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} />
          <Input label="新密码" type="password" required value={newPwd} onChange={(e) => setNewPwd(e.target.value)} minLength={6} />
          <Input label="确认新密码" type="password" required value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)} minLength={6} />
          {err && <Alert kind="error">{err}</Alert>}
          {msg && <Alert kind="success">{msg}</Alert>}
          <Button type="submit" disabled={busy}>{busy ? '提交中…' : '更新密码'}</Button>
        </form>
      </Card>

      <Card title="危险区">
        <div className="text-sm text-slate-600 mb-3">删除账号将永久注销, 已购买的额度不予退款。</div>
        <Button variant="danger" onClick={() => setOpenDelete(true)}>删除账号</Button>
      </Card>

      <Modal open={openDelete} onClose={() => !busy && setOpenDelete(false)}
        title="确认删除账号?"
        footer={<>
          <Button variant="ghost" onClick={() => !busy && setOpenDelete(false)}>取消</Button>
          <Button variant="danger" onClick={deleteAccount} disabled={busy}>{busy ? '处理中…' : '永久删除'}</Button>
        </>}>
        <p className="text-sm text-slate-600">此操作不可恢复。继续吗?</p>
      </Modal>
    </div>
  );
}
