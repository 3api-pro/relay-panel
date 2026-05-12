'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface EndUser {
  id: number; email: string; display_name: string | null; status: string;
  quota_cents: number; used_quota_cents: number; created_at: string;
}

export default function AdminDashboard() {
  const t = useTranslations('admin.dashboard_legacy');
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
      <header className="bg-accent text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold">{t('brand')}</div>
          <nav className="flex items-center gap-5 text-sm">
            <a href="/admin/dashboard/" className="text-amber-400">{t('nav_customers')}</a>
            <a href="/admin/channels/" className="hover:text-amber-400">{t('nav_channels')}</a>
            <button onClick={logout} className="hover:text-amber-400">{t('nav_logout')}</button>
          </nav>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold mb-6">{t('page_title')}</h1>
        {err && <div className="mb-4 text-sm text-red-600">{err}</div>}
        <div className="bg-card rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground border-b">
              <tr><th className="px-4 py-2">{t('th_id')}</th><th>{t('th_email')}</th><th>{t('th_status')}</th><th>{t('th_balance')}</th><th>{t('th_used')}</th><th>{t('th_created')}</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-border/50">
                  <td className="px-4 py-3">{u.id}</td>
                  <td>{u.email}</td>
                  <td><span className={`text-xs px-2 py-0.5 rounded ${u.status==='active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>{u.status}</span></td>
                  <td>¥{(u.quota_cents / 100).toFixed(2)}</td>
                  <td>¥{(u.used_quota_cents / 100).toFixed(2)}</td>
                  <td className="text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
