'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';

interface EndUser {
  id: number; email: string; display_name: string | null; status: string;
  quota_cents: number; used_quota_cents: number; created_at: string;
}

export default function AdminDashboard() {
  const router = useRouter();
  const [users, setUsers] = useState<EndUser[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!auth.hasToken()) { router.push('/admin/login'); return; }
    api<{ data: EndUser[] }>('/admin/end-users')
      .then(r => setUsers(r.data))
      .catch(e => { setErr(e.message); if (e.message.includes('401')) { auth.clearToken(); router.push('/admin/login'); } });
  }, []);

  function logout() { auth.clearToken(); router.push('/'); }

  return (
    <main className="min-h-screen">
      <header className="bg-slate-800 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold">3API Admin</div>
          <nav className="flex items-center gap-5 text-sm">
            <a href="/admin/dashboard/" className="text-amber-400">客户</a>
            <a href="/admin/channels/" className="hover:text-amber-400">上游 Channel</a>
            <button onClick={logout} className="hover:text-amber-400">退出</button>
          </nav>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold mb-6">客户管理</h1>
        {err && <div className="mb-4 text-sm text-red-600">{err}</div>}
        <div className="bg-white rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500 border-b">
              <tr><th className="px-4 py-2">ID</th><th>邮箱</th><th>状态</th><th>余额</th><th>已用</th><th>注册时间</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-slate-100">
                  <td className="px-4 py-3">{u.id}</td>
                  <td>{u.email}</td>
                  <td><span className={`text-xs px-2 py-0.5 rounded ${u.status==='active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{u.status}</span></td>
                  <td>¥{(u.quota_cents / 100).toFixed(2)}</td>
                  <td>¥{(u.used_quota_cents / 100).toFixed(2)}</td>
                  <td className="text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
