const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';

function token(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

function setToken(t: string): void {
  localStorage.setItem('token', t);
}

export function clearToken(): void {
  localStorage.removeItem('token');
}

export async function api<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const t = token();
  if (t) headers['Authorization'] = `Bearer ${t}`;

  const res = await fetch(API_BASE + path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    let errMsg: string;
    try {
      errMsg = JSON.parse(text).error?.message || text;
    } catch {
      errMsg = text;
    }
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }
  return res.json();
}

export const auth = {
  setToken,
  clearToken,
  hasToken: () => !!token(),
  signup: (email: string, password: string, displayName?: string) =>
    api('/customer/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    }).then((r: any) => { setToken(r.token); return r; }),
  login: (email: string, password: string) =>
    api('/customer/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r: any) => { setToken(r.token); return r; }),
  adminLogin: (email: string, password: string) =>
    api('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r: any) => { setToken(r.token); return r; }),
};

/**
 * Try an API call; return `fallback` on any error.
 * Used for endpoints that may not exist yet (orders, brand, payment-config)
 * so the dashboard renders empty-state instead of crashing.
 */
export async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

/** Format cents as ¥X.XX */
export function fmtCNY(cents: number | null | undefined): string {
  const n = Number(cents ?? 0);
  return `¥${(n / 100).toFixed(2)}`;
}

/** Format an ISO timestamp as YYYY-MM-DD HH:mm */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
