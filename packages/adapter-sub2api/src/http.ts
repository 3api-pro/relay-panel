/** sub2api HTTP 客户端：统一 {code,message,data} 信封 + 两种鉴权（x-api-key / Bearer JWT） */

export type AuthHeader = { kind: 'api-key'; key: string } | { kind: 'bearer'; token: string };

export class Sub2apiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export class Sub2apiHttp {
  constructor(
    private readonly baseUrl: string,
    private auth: AuthHeader | null,
  ) {}

  setAuth(auth: AuthHeader): void {
    this.auth = auth;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.auth?.kind === 'api-key') headers['x-api-key'] = this.auth.key;
    if (this.auth?.kind === 'bearer') headers['authorization'] = `Bearer ${this.auth.token}`;

    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    let envelope: { code?: number; message?: string; data?: unknown } = {};
    const text = await res.text();
    try {
      envelope = text ? JSON.parse(text) : {};
    } catch {
      throw new Sub2apiHttpError(res.status, undefined, `non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!res.ok || (envelope.code !== undefined && envelope.code !== 0)) {
      throw new Sub2apiHttpError(res.status, envelope.code, envelope.message ?? `HTTP ${res.status}`);
    }
    return envelope.data as T;
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

  /** 翻完所有分页 */
  async listAll<T>(path: string, pageSize = 100): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.get<PaginatedData<T> | T[]>(`${path}${sep}page=${page}&page_size=${pageSize}`);
      if (Array.isArray(data)) return data; // 非分页端点
      out.push(...data.items);
      if (page >= data.pages || data.items.length === 0) return out;
    }
  }
}
