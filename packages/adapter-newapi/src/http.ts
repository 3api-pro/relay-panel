/**
 * new-api HTTP 客户端。两个关键差异（vs sub2api）：
 * 1. 成败以信封 `success` 字段判定 —— 业务错误多返回 HTTP 200 + {success:false}。
 * 2. admin 鉴权是**双头**：Authorization: <access_token> + New-Api-User: <userId>。
 */

export class NewapiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PageInfo<T> {
  page: number;
  page_size: number;
  total: number;
  items: T[];
}

// new-api 的 admin 中间件强制要求 New-Api-User 头 —— session 模式也必须带 userId。
export type NewapiAuth =
  | { kind: 'session'; cookie: string; userId: number }
  | { kind: 'access-token'; token: string; userId: number };

export class NewapiHttp {
  constructor(
    private readonly baseUrl: string,
    private auth: NewapiAuth | null,
  ) {}

  setAuth(auth: NewapiAuth): void {
    this.auth = auth;
  }

  /** 供需要读非标准返回体（如 channel test 的 time 字段）的裸 fetch 复用鉴权头 */
  authHeadersForRawFetch(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.auth?.kind === 'access-token') {
      h['authorization'] = this.auth.token;
      h['new-api-user'] = String(this.auth.userId);
    } else if (this.auth?.kind === 'session') {
      h['cookie'] = this.auth.cookie;
      h['new-api-user'] = String(this.auth.userId);
    }
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.auth?.kind === 'access-token') {
      headers['authorization'] = this.auth.token;
      headers['new-api-user'] = String(this.auth.userId);
    } else if (this.auth?.kind === 'session') {
      headers['cookie'] = this.auth.cookie;
      headers['new-api-user'] = String(this.auth.userId); // 中间件强制要求
    }

    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });

    const text = await res.text();
    let envelope: { success?: boolean; message?: string; data?: unknown } = {};
    try {
      envelope = text ? JSON.parse(text) : {};
    } catch {
      throw new NewapiHttpError(res.status, `non-JSON response: ${text.slice(0, 200)}`);
    }
    // 成败以 success 字段为准（HTTP code 不可靠）；未登录类才看 401/500。
    if (res.status === 401 || res.status === 403) {
      throw new NewapiHttpError(res.status, envelope.message ?? `HTTP ${res.status}`);
    }
    if (envelope.success === false) {
      throw new NewapiHttpError(res.status, envelope.message ?? 'request failed');
    }
    return envelope.data as T;
  }

  /** 登录需要读 Set-Cookie，单独走一个不解析信封鉴权的方法 */
  async loginRaw(username: string, password: string): Promise<{ cookie: string; data: NewapiLoginData }> {
    const res = await fetch(`${this.baseUrl}/api/user/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(',').map((c) => c.split(';')[0]!.trim()).filter(Boolean).join('; ');
    const env = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: NewapiLoginData };
    if (env.success === false || !env.data) {
      throw new NewapiHttpError(res.status, env.message ?? 'login failed');
    }
    return { cookie, data: env.data };
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async listAll<T>(path: string, pageSize = 100): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.get<PageInfo<T> | T[]>(`${path}${sep}p=${page}&page_size=${pageSize}`);
      if (Array.isArray(data)) return data;
      out.push(...data.items);
      if (data.page * data.page_size >= data.total || data.items.length === 0) return out;
    }
  }
}

export interface NewapiLoginData {
  id: number;
  username: string;
  role: number;
  status: number;
  require_2fa?: boolean;
}
