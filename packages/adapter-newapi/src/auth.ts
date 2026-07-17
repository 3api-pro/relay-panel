import { NewapiHttp, type NewapiAuth } from './http.js';

/**
 * new-api admin 引导：用 root 用户名/密码登录换 session → 铸 access_token。
 * 此后 access_token + userId 即可无 session 长期调 admin API（双头鉴权）。
 *
 * ⚠️ `GET /api/user/token` 每次调用都会**轮换** access_token（旧的失效）。
 * 因此该函数只在"需要一把长期 token"时显式调用一次，不放进每次 connect。
 * 日常 connect 用已存的 access-token，或临时用 session（见 adapter.connect）。
 */
export async function loginRoot(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ cookie: string; userId: number; role: number }> {
  const http = new NewapiHttp(baseUrl, null);
  const { cookie, data } = await http.loginRaw(username, password);
  if (data.require_2fa) {
    throw new Error('new-api root has 2FA enabled; orchestrator-managed admin must not use 2FA');
  }
  return { cookie, userId: data.id, role: data.role };
}

/** 用 session 铸一把长期 access_token（会作废旧 token）。返回 {token,userId} 供持久化。 */
export async function mintAccessToken(
  baseUrl: string,
  session: { cookie: string; userId: number },
): Promise<{ token: string; userId: number }> {
  const http = new NewapiHttp(baseUrl, { kind: 'session', cookie: session.cookie, userId: session.userId });
  const token = await http.get<string>('/api/user/token');
  if (!token || typeof token !== 'string') throw new Error('mint access_token returned no token');
  return { token, userId: session.userId };
}

/** 从 session 直接构造一个可用于本次会话的鉴权（不铸长期 token，非破坏性） */
export function sessionAuth(cookie: string, userId: number): NewapiAuth {
  return { kind: 'session', cookie, userId };
}
