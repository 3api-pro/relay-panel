/**
 * Storefront API client — end-user (B2C) facing.
 *
 * Talks to /api/storefront/* (also reachable at /storefront/* directly).
 * Host header is auto-resolved to a tenant by backend tenant-resolver,
 * so this client never needs to pass a tenant slug.
 */
'use client';

const API_BASE =
  (typeof process !== 'undefined' && (process.env as any).NEXT_PUBLIC_STORE_API_BASE) ||
  '/api/storefront';

const TOKEN_KEY = 'sf_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
}
export function hasToken(): boolean { return !!getToken(); }

export class StoreApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function storeFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const t = getToken();
  if (t) headers['Authorization'] = `Bearer ${t}`;

  const url = path.startsWith('http') ? path : API_BASE + path;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch (err: any) {
    throw new StoreApiError(0, null, `网络异常: ${err?.message || String(err)}`);
  }

  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      clearToken();
      if (!window.location.pathname.endsWith('/login')) {
        window.location.href = '/login';
      }
    }
    throw new StoreApiError(401, null, 'unauthorized');
  }

  const text = await res.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }

  if (!res.ok) {
    const msg = (body && body.error && body.error.message)
      || (body && body.message)
      || (typeof body === 'string' && body)
      || `HTTP ${res.status}`;
    throw new StoreApiError(res.status, body, msg);
  }
  return body as T;
}

export interface Brand {
  store_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  announcement: string | null;
  footer_html: string | null;
  contact_email: string | null;
  // System-level fields (v0.2): merged from system_setting by /storefront/brand.
  system_announcement?: string | null;
  system_announcement_level?: 'info' | 'warn' | 'error' | null;
  maintenance_mode?: boolean;
  signup_enabled?: boolean;
}

export interface Plan {
  id: number;
  name: string;
  slug: string;
  period_days: number;
  quota_tokens: number;
  price_cents: number;
  allowed_models: string[] | string | null;
  sort_order: number;
}

// --- Check-in (v0.2) ---------------------------------------------------------
// Response shapes match src/routes/storefront/checkin.ts.
export interface CheckInStatus {
  enabled: boolean;
  already_checked_in: boolean;
  current_streak: number;
  next_reward_tokens: number;
  next_is_bonus: boolean;
  config: {
    reward_tokens_per_day: number;
    streak_bonus_tokens: number;
    bonus_every_n_days: number;
  };
}
export interface CheckInResult {
  ok: true;
  reward_tokens: number;
  streak_days: number;
  is_bonus_day: boolean;
  subscription_id: number | null;
  remaining_tokens: number | null;
}
export interface CheckInHistoryRow {
  check_date: string;
  reward_tokens: number;
  streak_days: number;
  is_bonus_day: boolean;
}

export const store = {
  brand: () => storeFetch<Brand>('/brand'),
  plans: () => storeFetch<{ data: Plan[] }>('/plans'),

  signup: (email: string, password: string) =>
    storeFetch<any>('/auth/signup', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }).then((r: any) => { if (r?.token) setToken(r.token); return r; }),

  login: (email: string, password: string) =>
    storeFetch<any>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }).then((r: any) => { if (r?.token) setToken(r.token); return r; }),

  verifyEmail: (token: string) =>
    storeFetch(`/auth/verify-email/${encodeURIComponent(token)}`, { method: 'POST' }),

  forgotPassword: (email: string) =>
    storeFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (token: string, password: string) =>
    storeFetch('/auth/reset-password', {
      method: 'POST', body: JSON.stringify({ token, password }),
    }),

  createOrder: (planId: number, opts: { coupon_code?: string; payment_provider?: string; idempotency_key?: string } = {}) =>
    storeFetch('/orders', {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId, ...opts }),
    }),

  listOrders: () => storeFetch<{ data: any[] }>('/orders'),
  getOrder:   (id: string | number) => storeFetch(`/orders/${id}`),
  subscriptions: () => storeFetch<any>('/subscriptions'),

  listKeys: () => storeFetch<{ data: any[] }>('/keys'),
  createKey: (name: string, model_allowlist?: string[]) =>
    storeFetch('/keys', { method: 'POST', body: JSON.stringify({ name, model_allowlist }) }),
  revokeKey: (id: string | number) => storeFetch(`/keys/${id}`, { method: 'DELETE' }),

  usage: (period: '7d' | '30d' = '7d') => storeFetch<any>(`/usage?period=${period}`),

  payAlipay: (orderId: string | number) =>
    storeFetch(`/payments/alipay/create`, {
      method: 'POST', body: JSON.stringify({ order_id: orderId }),
    }),
  payUsdtCreate: (orderId: string | number, network: 'trc20' | 'erc20') =>
    storeFetch(`/payments/usdt/create`, {
      method: 'POST', body: JSON.stringify({ order_id: orderId, network }),
    }),
  payUsdtCheck: (orderId: string | number) =>
    storeFetch(`/payments/usdt/check`, {
      method: 'POST', body: JSON.stringify({ order_id: orderId }),
    }),

  // --- Check-in (v0.2) -----------------------------------------------------
  checkin: {
    status: () => storeFetch<CheckInStatus>('/checkin/status'),
    doCheckin: () => storeFetch<CheckInResult>('/checkin', { method: 'POST' }),
    history: (days = 30) => storeFetch<{ data: CheckInHistoryRow[] }>(`/checkin/history?days=${days}`),
  },
};

export function fmtCents(n: number | null | undefined): string {
  const v = (n ?? 0) / 100;
  return `¥${v.toFixed(2)}`;
}
export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return '—'; }
}
export function fmtDateShort(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN');
  } catch { return '—'; }
}
export function parseAllowedModels(v: Plan['allowed_models']): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const j = JSON.parse(String(v));
    return Array.isArray(j) ? j : [];
  } catch {
    return String(v).split(',').map(s => s.trim()).filter(Boolean);
  }
}
