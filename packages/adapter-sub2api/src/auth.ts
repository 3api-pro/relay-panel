import { Sub2apiHttp, Sub2apiHttpError } from './http.js';

const COMPLIANCE_PHRASE_EN =
  'I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment';

function extractToken(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  for (const k of ['token', 'access_token', 'jwt']) {
    if (typeof d[k] === 'string') return d[k] as string;
  }
  return null;
}

/** email/password 登录换 JWT（不支持 2FA —— 编排器创建的 admin 不开 2FA） */
export async function loginAdmin(baseUrl: string, email: string, password: string): Promise<string> {
  const http = new Sub2apiHttp(baseUrl, null);
  const data = await http.post<unknown>('/api/v1/auth/login', { email, password });
  const token = extractToken(data);
  if (!token) throw new Error('login succeeded but no token in response');
  return token;
}

/** 首次调 admin API 前接受合规承诺（已接受则幂等跳过） */
export async function ensureCompliance(http: Sub2apiHttp): Promise<void> {
  try {
    const status = await http.get<{ accepted?: boolean }>('/api/v1/admin/compliance');
    if (status?.accepted) return;
  } catch {
    /* 状态端点异常时直接尝试 accept */
  }
  try {
    await http.post('/api/v1/admin/compliance/accept', {
      phrase: COMPLIANCE_PHRASE_EN,
      language: 'en',
    });
  } catch (e) {
    // 已接受的情况下部分版本会报错，忽略幂等冲突
    if (e instanceof Sub2apiHttpError && e.status < 500) return;
    throw e;
  }
}

/**
 * 引导长期凭据：admin 密码 → JWT → 合规 → 生成 Admin API Key。
 * 完整 key 只在生成时返回一次，调用方必须立即加密入库。
 */
export async function bootstrapAdminApiKey(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const jwt = await loginAdmin(baseUrl, email, password);
  const http = new Sub2apiHttp(baseUrl, { kind: 'bearer', token: jwt });
  await ensureCompliance(http);
  const data = await http.post<{ key: string }>('/api/v1/admin/settings/admin-api-key/regenerate');
  if (!data?.key) throw new Error('admin-api-key regenerate returned no key');
  return data.key;
}
