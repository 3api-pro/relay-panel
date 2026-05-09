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
