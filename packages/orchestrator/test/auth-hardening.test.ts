import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeEmail } from '../src/auth/ratelimit.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 开放注册前置闸 §3：注册/登录限速（内存滑窗，CF-Connecting-IP 取真实 IP）+ 邮箱归一化。
 * 覆盖：gmail 别名去重(409)、单 IP 超限(429)、单邮箱跨 IP 超限(429)、
 * CF-Connecting-IP 分桶正确、登录失败退避锁定/成功清零、登录归一化匹配。
 */

vi.setConfig({ testTimeout: 30_000 });

function signupPayload(email: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { email, password: 'Str0ng-pass-123456', ...extra };
}

describe('normalizeEmail', () => {
  it('gmail/googlemail 去点、去 +tag 并统一到 gmail.com', () => {
    expect(normalizeEmail('John.Doe+promo@Gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('a.b.c@googlemail.com')).toBe('abc@gmail.com');
    expect(normalizeEmail('  Foo.Bar@GMAIL.COM  ')).toBe('foobar@gmail.com');
  });

  it('非 gmail 仅 trim+lowercase（点/+tag 保留语义）', () => {
    expect(normalizeEmail('User+x@Example.COM')).toBe('user+x@example.com');
    expect(normalizeEmail('  A.B@corp.io ')).toBe('a.b@corp.io');
  });
});

describe('signup 限速与归一化', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await makeTestServer({
      config: { signupMode: 'open', signupMaxPerIp: 3, signupMaxPerEmail: 2 },
    });
  }, 60_000);
  afterAll(async () => {
    await ts.close();
  });

  function signup(email: string, cfIp: string, extra: Record<string, unknown> = {}) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'cf-connecting-ip': cfIp },
      payload: signupPayload(email, extra),
    });
  }

  it('gmail 别名注册第二次 → 409（归一化去重）', async () => {
    const first = await signup('Test.User@Gmail.com', '203.0.113.1');
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { email: string }).email).toBe('testuser@gmail.com');

    const alias = await signup('testuser+promo@googlemail.com', '203.0.113.1');
    expect(alias.statusCode).toBe(409);
    expect((alias.json() as { message: string }).message).toBe('邮箱已注册');
  });

  it('单 IP 超限 → 429；换 CF-Connecting-IP 即新桶放行', async () => {
    expect((await signup('ip-a@corp.com', '198.51.100.7')).statusCode).toBe(200);
    expect((await signup('ip-b@corp.com', '198.51.100.7')).statusCode).toBe(200);
    expect((await signup('ip-c@corp.com', '198.51.100.7')).statusCode).toBe(200);
    const blocked = await signup('ip-d@corp.com', '198.51.100.7');
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { message: string }).message).toBe('操作过于频繁，请稍后再试');
    // 真实 IP 从 CF-Connecting-IP 取——换 IP 即独立桶
    expect((await signup('ip-e@corp.com', '198.51.100.8')).statusCode).toBe(200);
  });

  it('单邮箱跨不同 IP 也受限 → 429（防别名邮箱换 IP 收割）', async () => {
    expect((await signup('shared@corp.com', '203.0.113.4')).statusCode).toBe(200);
    // 第二次同邮箱不同 IP：dup 409（邮箱计数达 2）
    expect((await signup('shared@corp.com', '203.0.113.5')).statusCode).toBe(409);
    // 第三次同邮箱再换 IP：邮箱维度已超限 → 429（先于 dup 判定）
    expect((await signup('shared@corp.com', '203.0.113.6')).statusCode).toBe(429);
  });
});

describe('login 限速与归一化', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await makeTestServer({ config: { loginMaxFails: 3 } });
  }, 60_000);
  afterAll(async () => {
    await ts.close();
  });

  function login(email: string, password: string, cfIp?: string) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      ...(cfIp !== undefined ? { headers: { 'cf-connecting-ip': cfIp } } : {}),
      payload: { email, password },
    });
  }

  it('登录归一化：别名输入登录到归一化账号', async () => {
    await ts.seedLogin({ email: 'johndoe@gmail.com', password: 'Str0ng-pass-123456', role: 'operator' });
    const res = await login('John.Doe+ads@Gmail.com', 'Str0ng-pass-123456');
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { email: string }).email).toBe('johndoe@gmail.com');
  });

  it('连续失败达阈值 → 429 退避（即便随后给对口令）', async () => {
    await ts.seedLogin({ email: 'lockme@example.com', password: 'Correct-pass-123456', role: 'operator' });
    for (let i = 0; i < 3; i++) {
      expect((await login('lockme@example.com', 'wrong-pass')).statusCode, `fail ${i}`).toBe(401);
    }
    // 第 4 次即使口令正确也 429（检查在校验之前）
    const locked = await login('lockme@example.com', 'Correct-pass-123456');
    expect(locked.statusCode).toBe(429);
  });

  it('登录成功清零失败计数', async () => {
    await ts.seedLogin({ email: 'clearme@example.com', password: 'Correct-pass-123456', role: 'operator' });
    expect((await login('clearme@example.com', 'wrong-pass')).statusCode).toBe(401);
    expect((await login('clearme@example.com', 'wrong-pass')).statusCode).toBe(401);
    // 成功一次 → 清零
    expect((await login('clearme@example.com', 'Correct-pass-123456')).statusCode).toBe(200);
    // 再连续失败两次仍是 401（未累积到 429）
    expect((await login('clearme@example.com', 'wrong-pass')).statusCode).toBe(401);
    expect((await login('clearme@example.com', 'wrong-pass')).statusCode).toBe(401);
  });

  it('失败锁定按 (真实IP, 账号) 分桶：换 CF-Connecting-IP 不被前一 IP 的失败连累', async () => {
    await ts.seedLogin({ email: 'cfacct@example.com', password: 'Correct-pass-123456', role: 'operator' });
    for (let i = 0; i < 3; i++) {
      expect((await login('cfacct@example.com', 'wrong-pass', '10.10.10.1')).statusCode).toBe(401);
    }
    expect((await login('cfacct@example.com', 'Correct-pass-123456', '10.10.10.1')).statusCode).toBe(429);
    // 另一 IP 同账号仍可尝试（不是同一桶）
    expect((await login('cfacct@example.com', 'wrong-pass', '10.10.10.2')).statusCode).toBe(401);
  });
});
