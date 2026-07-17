/**
 * Caddy admin API 客户端（规格 §9）。每站一条路由对象，`@id` 固定 `rp-<slug>`，
 * 幂等语义：先按 @id 删除旧路由（404 忽略），再在 domains 非空时向
 * /config/apps/http/servers/rp/routes 追加新路由。fetch 统一 5s 超时。
 * 本模块只抛普通 Error（中文消息，不含凭据）；HTTP 状态语义由路由层决定。
 */

const FETCH_TIMEOUT_MS = 5_000;

export function caddyRouteId(slug: string): string {
  return `rp-${slug}`;
}

/** 路由对象形状（Caddy JSON config 的 http 路由子集） */
export interface CaddyRoute {
  '@id': string;
  match: { host: string[] }[];
  handle: { handler: 'reverse_proxy'; upstreams: { dial: string }[] }[];
}

export function buildRoute(slug: string, domains: string[], hostPort: number): CaddyRoute {
  return {
    '@id': caddyRouteId(slug),
    match: [{ host: [...domains] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${hostPort}` }] }],
  };
}

function baseOf(caddyUrl: string): string {
  return caddyUrl.replace(/\/+$/, '');
}

async function caddyFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Caddy admin API 请求失败: ${msg}`);
  }
}

/** 按 @id 删除站点路由；404（不存在）视为成功，其余非 2xx 报错 */
async function deleteRoute(caddyUrl: string, slug: string): Promise<void> {
  const res = await caddyFetch(`${baseOf(caddyUrl)}/id/${caddyRouteId(slug)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Caddy admin API 删除路由响应 ${res.status}`);
  }
}

/**
 * 下发（覆盖）某站域名路由：DELETE 旧路由 → domains 非空时追加新路由。
 * domains 为空等价于 removeDomains（只删不加）。
 */
export async function applyDomains(
  caddyUrl: string,
  slug: string,
  domains: string[],
  hostPort: number,
): Promise<void> {
  await deleteRoute(caddyUrl, slug);
  if (domains.length === 0) return;
  const res = await caddyFetch(`${baseOf(caddyUrl)}/config/apps/http/servers/rp/routes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildRoute(slug, domains, hostPort)),
  });
  if (!res.ok) {
    throw new Error(`Caddy admin API 写入路由响应 ${res.status}`);
  }
}

/** 摘除某站全部域名路由（站点销毁等场景用），404 忽略 */
export async function removeDomains(caddyUrl: string, slug: string): Promise<void> {
  await deleteRoute(caddyUrl, slug);
}
