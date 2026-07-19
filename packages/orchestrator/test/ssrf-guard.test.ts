import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { credentials, sites, subscriptions } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { assertPublicUrl, isBlockedIp } from '../src/net/guard.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 出站地址守卫（开放注册前置闸 §2）：
 *  - isBlockedIp 分类（v4/v6/IPv4-mapped）
 *  - assertPublicUrl：IP 字面量直判、主机名 DNS 全地址判定（防 rebinding）、
 *    non-http 拒、skip(root) 放行、failClosed 语义。
 *  - adopt 集成：operator 打内网 → 统一模糊 400 不落行；公网放行；root 豁免。
 */

vi.setConfig({ testTimeout: 30_000 });

const resolveTo =
  (addrs: string[]) =>
  async (): Promise<string[]> =>
    addrs;

async function expectBlocked(url: string, opts?: Parameters<typeof assertPublicUrl>[1]): Promise<void> {
  await expect(assertPublicUrl(url, opts)).rejects.toMatchObject({
    statusCode: 400,
    message: '不允许的目标地址',
  });
}
async function expectAllowed(url: string, opts?: Parameters<typeof assertPublicUrl>[1]): Promise<void> {
  await expect(assertPublicUrl(url, opts)).resolves.toBeUndefined();
}

describe('isBlockedIp 分类', () => {
  it('IPv4 内网/保留/元数据 → true', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('IPv4 公网 → false', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10', '93.184.216.34', '172.32.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('IPv6 回环/ULA/link-local/多播 与 IPv4-mapped → true', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('IPv6 全局单播 → false', () => {
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('IP 字面量内网一律拒（含 IPv6 括号形式）', async () => {
    await expectBlocked('http://127.0.0.1:8080/x');
    await expectBlocked('http://10.0.0.5/');
    await expectBlocked('https://192.168.1.1/');
    await expectBlocked('http://169.254.169.254/latest/meta-data/');
    await expectBlocked('http://[::1]:9200/');
    await expectBlocked('http://[fe80::1]/');
  });

  it('公网 IP 字面量放行（不触网）', async () => {
    await expectAllowed('http://8.8.8.8/');
    await expectAllowed('http://203.0.113.10:3272/');
    await expectAllowed('http://[2001:4860:4860::8888]/');
  });

  it('非 http/https 一律拒', async () => {
    await expectBlocked('ftp://8.8.8.8/');
    await expectBlocked('file:///etc/passwd');
    await expectBlocked('gopher://127.0.0.1/');
    await expectBlocked('not a url');
  });

  it('主机名解析到内网 → 拒（防 DNS rebinding）', async () => {
    await expectBlocked('http://rebind.attacker.example/', { resolve: resolveTo(['127.0.0.1']) });
    await expectBlocked('http://meta.attacker.example/', { resolve: resolveTo(['169.254.169.254']) });
    // 多地址任一内网即拒
    await expectBlocked('http://mixed.example/', { resolve: resolveTo(['1.2.3.4', '10.0.0.1']) });
  });

  it('主机名解析到公网 → 放行', async () => {
    await expectAllowed('https://relay.example.com/', { resolve: resolveTo(['93.184.216.34']) });
    await expectAllowed('https://relay.example.com/', { resolve: resolveTo(['2001:4860:4860::8888']) });
  });

  it('skip=true（root 豁免）内网也放行', async () => {
    await expectAllowed('http://127.0.0.1:9200/', { skip: true });
    await expectAllowed('http://169.254.169.254/', { skip: true });
  });

  it('解析失败：failClosed=false 放行，failClosed=true 拒绝', async () => {
    const boom = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    };
    await expectAllowed('http://nope.invalid/', { resolve: boom });
    await expectBlocked('http://nope.invalid/', { resolve: boom, failClosed: true });
  });
});

describe('adopt 集成：SSRF 守卫 + 模糊错误', () => {
  let ts: TestServer;
  let opCookie: string;
  let rootCookie: string;

  beforeAll(async () => {
    ts = await makeTestServer();
    const op = await ts.seedLogin({ email: 'ssrf-op@example.com', password: 'op-pass-1234', role: 'operator' });
    opCookie = op.cookie;
    const root = await ts.seedLogin({ email: 'ssrf-root@example.com', password: 'root-pass-1234', role: 'root' });
    rootCookie = root.cookie;
    // 给 operator 足量配额，排除配额对 SSRF 用例的干扰
    await ts.db.orm.insert(subscriptions).values({
      operatorId: op.operatorId,
      planKey: 'pro',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 30 * 86_400_000)),
    });
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  function payload(slug: string, baseUrl: string): Record<string, unknown> {
    return { slug, label: slug, baseUrl, engine: 'sub2api', adminApiKey: 'sk-x' };
  }

  it('operator adopt 内网/回环/元数据 → 统一 400「不允许的目标地址」且不落行', async () => {
    for (const [i, url] of ['http://127.0.0.1:3272', 'http://10.0.0.9:80', 'http://169.254.169.254'].entries()) {
      const slug = `ssrf-block-${i}`;
      const res = await ts.app.inject({
        method: 'POST',
        url: '/api/sites/adopt',
        cookies: { rp_session: opCookie },
        payload: payload(slug, url),
      });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { message: string }).message).toBe('不允许的目标地址');
      // 守卫在插入前，绝不落半接入行/凭据
      expect(await ts.db.orm.select().from(sites).where(eq(sites.slug, slug))).toHaveLength(0);
      expect(
        await ts.db.orm.select().from(credentials).where(eq(credentials.ref, `enc:${slug}`)),
      ).toHaveLength(0);
    }
  });

  it('operator adopt 公网地址 → 放行（201）', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: opCookie },
      payload: payload('ssrf-public', 'http://203.0.113.20:3272'),
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('root adopt 回环 → 豁免放行（我方 4 站即回环 adopt）', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/adopt',
      cookies: { rp_session: rootCookie },
      payload: payload('ssrf-root-loopback', 'http://127.0.0.1:3272'),
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
