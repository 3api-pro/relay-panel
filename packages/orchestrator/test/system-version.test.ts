import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareSemver,
  fetchLatestRelease,
  getVersionInfo,
  parseSemver,
  pickLatestRelease,
  readCurrentVersion,
  resetVersionCacheForTests,
} from '../src/system/version.js';
import { makeTestServer } from './helpers.js';

/**
 * 面板自身版本 + 可用更新检查单测：
 *  ① semver 比较（prerelease 优先级：2.1.0-beta.1 < 2.1.0-beta.2 < 2.1.0）
 *  ② releases 列表取最新：跳草稿、含 prerelease（🔴 用 /releases 而非 /releases/latest 的理由）
 *  ③ 取数失败如实回 error 且 hasUpdate=false（绝不谎报"已是最新"），且失败不写缓存
 *  ④ HTTP：非 root 403、root 200 且带 current/hasUpdate
 * makeTestServer + scrypt 登录较慢，放宽超时（同 upstream.test.ts）。
 */
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  resetVersionCacheForTests();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// ① semver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('主/次/修订位逐级比较', () => {
    expect(compareSemver('2.0.0', '2.1.0')).toBeLessThan(0);
    expect(compareSemver('2.1.0', '2.0.9')).toBeGreaterThan(0);
    expect(compareSemver('2.1.3', '2.1.3')).toBe(0);
    expect(compareSemver('v2.1.0', '2.1.0')).toBe(0); // 前导 v 无所谓
  });

  it('prerelease 恒小于正式版；同名段按数字/字典序', () => {
    expect(compareSemver('2.1.0-beta.1', '2.1.0')).toBeLessThan(0);
    expect(compareSemver('2.1.0-beta.1', '2.1.0-beta.2')).toBeLessThan(0);
    expect(compareSemver('2.1.0-beta.2', '2.1.0-beta.10')).toBeLessThan(0); // 数字段按数值不按字典
    expect(compareSemver('2.1.0-alpha.1', '2.1.0-beta.1')).toBeLessThan(0);
    expect(compareSemver('2.0.0-beta.1', '2.1.0-beta.1')).toBeLessThan(0);
  });

  it('不可解析的版本视作相等（宁可不提示也不误报更新）', () => {
    expect(compareSemver('unknown', '2.1.0')).toBe(0);
    expect(parseSemver('not-a-version')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ② releases 列表挑选
// ---------------------------------------------------------------------------

describe('pickLatestRelease', () => {
  it('跳过草稿，保留 prerelease（v2 线全是 beta，跳过就会漏报）', () => {
    const picked = pickLatestRelease([
      { tag_name: 'v9.9.9', draft: true },
      { tag_name: 'v2.1.0-beta.1', prerelease: true, html_url: 'u' },
      { tag_name: 'v0.5.0' },
    ]);
    expect(picked?.tag_name).toBe('v2.1.0-beta.1');
  });

  it('空列表 / 无 tag → null', () => {
    expect(pickLatestRelease([])).toBeNull();
    expect(pickLatestRelease([{ draft: false }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ 取数与判定
// ---------------------------------------------------------------------------

describe('fetchLatestRelease / getVersionInfo', () => {
  it('成功：去前导 v、透出 url/发布时间', async () => {
    const fake = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v2.2.0',
          name: 'v2.2.0 — x',
          html_url: 'https://github.com/o/r/releases/tag/v2.2.0',
          published_at: '2026-07-26T00:00:00Z',
          prerelease: false,
        },
      ]),
    ) as unknown as typeof fetch;
    const r = await fetchLatestRelease('o/r', fake);
    expect(r.latest).toBe('2.2.0');
    expect(r.error).toBeNull();
    expect(r.url).toContain('/releases/tag/v2.2.0');
    expect(r.publishedAt).toBe('2026-07-26T00:00:00Z');
  });

  it('HTTP 失败 / 网络异常：error 有中文原因、latest=null、hasUpdate=false 且不写缓存', async () => {
    const err = await fetchLatestRelease('o/r', (async () => jsonResponse({}, 503)) as unknown as typeof fetch);
    expect(err.latest).toBeNull();
    expect(err.error).toContain('503');

    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const info = await getVersionInfo({ repo: 'o/r', fetchImpl: boom });
    expect(info.latest).toBeNull();
    expect(info.hasUpdate).toBe(false);
    expect(info.error).not.toBeNull();
    expect(info.cached).toBe(false);

    // 失败不落缓存：下一次仍真实发起请求
    const info2 = await getVersionInfo({ repo: 'o/r', fetchImpl: boom });
    expect(info2.cached).toBe(false);
  });

  it('比当前版本新才 hasUpdate；同版/更旧一律 false，第二次命中 6h 缓存', async () => {
    const current = await readCurrentVersion();
    const newer = `${Number(current.split('.')[0]) + 1}.0.0`;
    const fake = vi.fn(async () => jsonResponse([{ tag_name: `v${newer}`, html_url: 'u' }])) as unknown as typeof fetch;

    const up = await getVersionInfo({ repo: 'o/r', fetchImpl: fake });
    expect(up.hasUpdate).toBe(true);
    expect(up.cached).toBe(false);

    const again = await getVersionInfo({ repo: 'o/r', fetchImpl: fake });
    expect(again.cached).toBe(true);
    expect(fake).toHaveBeenCalledTimes(1);

    resetVersionCacheForTests();
    const same = vi.fn(async () => jsonResponse([{ tag_name: `v${current}`, html_url: 'u' }])) as unknown as typeof fetch;
    const eq = await getVersionInfo({ repo: 'o/r', fetchImpl: same });
    expect(eq.hasUpdate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ④ HTTP 装配
// ---------------------------------------------------------------------------

describe('GET /api/system/version', () => {
  it('非 root 403；root 200 且带 current/hasUpdate（不出网，stub 全局 fetch）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([{ tag_name: 'v0.0.1', html_url: 'u' }])),
    );
    const ts = await makeTestServer();
    try {
      const op = await ts.seedLogin({ email: 'op@x.com', password: 'pw-123456', role: 'operator' });
      const denied = await ts.app.inject({
        method: 'GET',
        url: '/api/system/version',
        cookies: { rp_session: op.cookie },
      });
      expect(denied.statusCode).toBe(403);

      const root = await ts.seedLogin({ email: 'root@x.com', password: 'pw-123456', role: 'root' });
      const ok = await ts.app.inject({
        method: 'GET',
        url: '/api/system/version',
        cookies: { rp_session: root.cookie },
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(typeof body.current).toBe('string');
      expect(body.hasUpdate).toBe(false); // v0.0.1 远旧于当前版本
    } finally {
      await ts.close();
    }
  });
});
