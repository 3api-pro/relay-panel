import { toast } from '../components/ui/toast';

/**
 * fetch 包装：JSON、same-origin 凭据、统一错误处理。
 * - 非 2xx：抛 ApiError（message 取后端 {error} 中文文案），默认弹错误 toast
 * - 401：额外触发 unauthorizedHandler（router.ts 装配为清会话并跳 /login）
 * - opts.silent = true 时不弹 toast（探测类请求自理错误）
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RequestOptions {
  /** 不弹错误 toast（调用方自行处理） */
  silent?: boolean;
  /** 401 时不触发跳登录（登录前的会话探测用） */
  skipAuthRedirect?: boolean;
  /** 查询参数（undefined 值自动跳过） */
  query?: Record<string, string | number | boolean | undefined>;
}

let unauthorizedHandler: (() => void) | null = null;

/** router.ts 装配：401 时清会话并带 redirect 跳 /login（避免 client → router 循环依赖） */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const err = new ApiError(0, '网络异常，请检查连接');
    if (!opts.silent) toast.error(err.message);
    throw err;
  }

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    // 后端两种错误体：fastify 默认序列化 {statusCode, error:'Bad Request', message:'中文'}（ApiError 路径）
    // 与手写 {error:'中文'}（jobs/404 等）。优先取 message（中文），回落 error。
    const body = (data ?? {}) as { message?: unknown; error?: unknown };
    const message =
      typeof body.message === 'string' && body.message
        ? body.message
        : typeof body.error === 'string' && body.error
          ? body.error
          : `请求失败（${res.status}）`;
    const err = new ApiError(res.status, message);
    if (res.status === 401 && !opts.skipAuthRedirect) {
      unauthorizedHandler?.();
    } else if (!opts.silent) {
      toast.error(message);
    }
    throw err;
  }

  return data as T;
}

export function get<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts);
}

export function post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('POST', path, body, opts);
}

export function patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('PATCH', path, body, opts);
}

export function put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('PUT', path, body, opts);
}

export function del<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('DELETE', path, body, opts);
}

export const api = { get, post, patch, put, del };
