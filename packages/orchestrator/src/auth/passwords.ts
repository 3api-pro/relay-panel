import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * 口令散列（规格 §4）：node:crypto scrypt，无新依赖。
 * 存储格式（schema operators.password_hash 注释）：
 *   "scrypt:N=16384,r=8,p=1:<salt hex>:<hash hex>"
 * verify 从存储串解析参数再计算，未来调参不影响旧散列的校验。
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      keylen,
      // maxmem 需大于 128*N*r（scrypt 内存占用），留一倍余量
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}:${salt.toString('hex')}:${key.toString('hex')}`;
}

/** stored 为空/格式非法/参数非法一律返回 false，不抛错（登录路径统一失败文案） */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]!);
  if (!m) return false;
  const params: ScryptParams = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  // Buffer.from(非法 hex) 会得到截断/空 buffer，长度校验兜底
  if (salt.length === 0 || expected.length === 0 || parts[3]!.length !== expected.length * 2) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, params);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
