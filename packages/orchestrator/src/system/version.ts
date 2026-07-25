import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, requireRoot } from '../auth/rbac.js';

/**
 * 面板自身版本 + 可用更新检查（站长视角，仿 sub2api 的版本徽章）。
 *   GET /api/system/version[?force=1] → root
 * 当前版本 = orchestrator package.json 的 version（源码树/dist 都在 ../../package.json）。
 * 最新版本 = GitHub releases 列表第一条（**不能用 /releases/latest**：它跳过 prerelease，
 * 而本仓库 v2.x 线全是 beta，latest 会误报成 legacy 的 v0.5.0）。
 *
 * 🔴 只提示，不自更新：面板由 docker compose / 源码部署，升级动作留给站长自己执行。
 * 拉不到就如实回 error 文案 + hasUpdate=false，绝不猜测“已是最新”。
 */

/** 发行仓库（fork 自建可用 RP_RELEASE_REPO 覆盖，形如 owner/repo） */
const DEFAULT_REPO = '3api-pro/relay-panel';
const CACHE_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 8000;

export interface ReleaseCheck {
  /** 归一后的版本号（去掉前导 v）；拉取失败为 null */
  latest: string | null;
  /** release 页面 URL */
  url: string | null;
  /** release 标题 */
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  /** 拉取失败原因（中文），成功为 null */
  error: string | null;
  /** 本次结果的产生时刻 */
  checkedAt: string;
}

export interface VersionInfo extends ReleaseCheck {
  current: string;
  hasUpdate: boolean;
  /** 本次是否命中缓存（未真正请求 GitHub） */
  cached: boolean;
  repo: string;
}

interface GithubRelease {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

// ---------------------------------------------------------------------------
// semver 比较（含 prerelease 优先级，2.1.0-beta.1 < 2.1.0）
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** 标准 semver 优先级：a<b 返回负数，相等 0，a>b 正数 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0; // 任一不可解析 → 视作相等，宁可不提示也不误报更新
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // 有 prerelease 的一方更小；都有则逐段比较
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // 段少者更小（beta.1 < beta.1.1）
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    if (nx !== null) return -1; // 数字段 < 字符串段
    if (ny !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** releases 列表 → 最新一条（跳过草稿；已发布顺序即 GitHub 返回顺序=创建时间倒序） */
export function pickLatestRelease(list: GithubRelease[]): GithubRelease | null {
  for (const r of list) {
    if (r.draft === true) continue;
    if (typeof r.tag_name !== 'string' || r.tag_name === '') continue;
    return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 当前版本（读自身 package.json，进程内只读一次）
// ---------------------------------------------------------------------------

let currentVersionCache: string | null = null;

export async function readCurrentVersion(): Promise<string> {
  if (currentVersionCache !== null) return currentVersionCache;
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: unknown };
    currentVersionCache = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    currentVersionCache = 'unknown';
  }
  return currentVersionCache;
}

// ---------------------------------------------------------------------------
// GitHub 查询（6h 缓存，force 跳缓存）
// ---------------------------------------------------------------------------

let releaseCache: ReleaseCheck | null = null;
let releaseCacheAt = 0;

export async function fetchLatestRelease(
  repo: string,
  fetchFn: typeof fetch,
): Promise<ReleaseCheck> {
  const checkedAt = new Date().toISOString();
  const empty = (error: string): ReleaseCheck => ({
    latest: null,
    url: null,
    name: null,
    publishedAt: null,
    prerelease: false,
    error,
    checkedAt,
  });
  try {
    const resp = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'relay-panel' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return empty(`GitHub 返回 HTTP ${resp.status}`);
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) return empty('GitHub 返回格式异常');
    const rel = pickLatestRelease(data as GithubRelease[]);
    if (!rel) return empty('仓库暂无已发布版本');
    const tag = rel.tag_name as string;
    return {
      latest: tag.replace(/^v/, ''),
      url: rel.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`,
      name: rel.name ?? tag,
      publishedAt: rel.published_at ?? null,
      prerelease: rel.prerelease === true,
      error: null,
      checkedAt,
    };
  } catch {
    return empty('无法连接 GitHub（网络受限或超时）');
  }
}

export function resetVersionCacheForTests(): void {
  releaseCache = null;
  releaseCacheAt = 0;
  currentVersionCache = null;
}

export async function getVersionInfo(
  opts: { force?: boolean; repo?: string; fetchImpl?: typeof fetch } = {},
): Promise<VersionInfo> {
  const repo = opts.repo ?? process.env.RP_RELEASE_REPO ?? DEFAULT_REPO;
  const current = await readCurrentVersion();
  const fresh = releaseCache !== null && Date.now() - releaseCacheAt < CACHE_TTL_MS;
  let cached = false;
  let check: ReleaseCheck;
  if (fresh && opts.force !== true) {
    check = releaseCache as ReleaseCheck;
    cached = true;
  } else {
    check = await fetchLatestRelease(repo, opts.fetchImpl ?? fetch);
    // 失败结果不写缓存：下次访问立刻重试，不把“查不到”钉住 6 小时
    if (check.error === null) {
      releaseCache = check;
      releaseCacheAt = Date.now();
    }
  }
  const hasUpdate =
    check.latest !== null && current !== 'unknown' && compareSemver(current, check.latest) < 0;
  return { ...check, current, hasUpdate, cached, repo };
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: { fetchImpl?: typeof fetch } = {},
): void {
  app.get('/api/system/version', async (req) => {
    // root only：更新提示是部署者的事，托管版的 operator 站长管不到面板本体
    requireRoot(requireCtx(req));
    const q = (req.query ?? {}) as { force?: string };
    const force = q.force === '1' || q.force === 'true';
    return getVersionInfo({
      force,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  });
}
