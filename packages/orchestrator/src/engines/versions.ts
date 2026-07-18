import type { FastifyInstance } from 'fastify';
import type { EngineKind } from '@relay-panel/adapter-core';
import { ApiError } from '../auth/rbac.js';

/**
 * 引擎可选版本（provision 版本下拉数据源）。版本 = 官方 docker 镜像 tag，
 * 不是 exe —— 我们从不收集/托管引擎二进制，provision 直接拉官方镜像。
 * GET /api/engines/versions → { sub2api: string[], newapi: string[] }
 * 尽力从 Docker Hub 拉近版 tag（6h 缓存），失败回落内置精选列表。
 * 一律剔除 latest 与架构后缀(-amd64/-arm64)，只留可钉版本。
 */

const REPO: Record<EngineKind, string> = {
  sub2api: 'weishaw/sub2api',
  newapi: 'calciumion/new-api',
};

/** 内置回落（拉取失败时用；定期更新即可，非唯一真源） */
const FALLBACK: Record<EngineKind, string[]> = {
  sub2api: ['0.1.161', '0.1.160', '0.1.159', '0.1.158', '0.1.157', '0.1.156'],
  newapi: ['v1.0.0-rc.21', 'v1.0.0-rc.20', 'v1.0.0-rc.19'],
};

const CACHE_TTL_MS = 6 * 3600_000;
const cache = new Map<EngineKind, { at: number; versions: string[] }>();

/** 架构/摘要后缀 tag 一律丢弃，只保留干净可钉版本 */
function isPinnableTag(name: string): boolean {
  if (name === 'latest' || name === '') return false;
  if (/-(amd64|arm64|arm|armv7|amd|i18nfix.*)$/i.test(name)) return false;
  return /^v?\d/.test(name);
}

async function fetchTags(engine: EngineKind, fetchFn: typeof fetch): Promise<string[]> {
  const cached = cache.get(engine);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.versions;
  try {
    const url = `https://hub.docker.com/v2/repositories/${REPO[engine]}/tags?page_size=100&ordering=last_updated`;
    const resp = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { results?: Array<{ name: string }> };
    const versions = (data.results ?? [])
      .map((r) => r.name)
      .filter(isPinnableTag)
      .slice(0, 24);
    if (versions.length === 0) throw new Error('no pinnable tags');
    cache.set(engine, { at: Date.now(), versions });
    return versions;
  } catch {
    return FALLBACK[engine];
  }
}

export function registerEngineVersionRoutes(
  app: FastifyInstance,
  deps: { fetchImpl?: typeof fetch } = {},
): void {
  const fetchFn = deps.fetchImpl ?? fetch;
  app.get('/api/engines/versions', async (req) => {
    if (!req.ctx) throw new ApiError(401, '未登录或会话已过期');
    const [sub2api, newapi] = await Promise.all([
      fetchTags('sub2api', fetchFn),
      fetchTags('newapi', fetchFn),
    ]);
    return { sub2api, newapi };
  });
}
