import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** URL-safe 强随机密码（admin 初始密码等） */
export function randomPassword(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[buf[i]! % alphabet.length];
  return out;
}

/** masterKey 为 64hex 时直接作为 32 字节 key，否则 sha256(utf8) 派生 */
function deriveKey(masterKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(masterKey)) return Buffer.from(masterKey, 'hex');
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_PREFIX = 'v1:';

/**
 * AES-256-GCM 加密，输出 'v1:' + base64(iv|tag|ct)。
 * 凭据密文入库用；明文只在进程内存，绝不落日志。
 */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FORMAT_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(payload: string, masterKey: string): string {
  if (!payload.startsWith(FORMAT_PREFIX)) {
    throw new Error('unsupported secret format (expected v1: prefix)');
  }
  const buf = Buffer.from(payload.slice(FORMAT_PREFIX.length), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new Error('secret payload too short');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(masterKey), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败（密钥不对或密文被篡改）——不透出底层细节
    throw new Error('secret decryption failed: bad key or tampered ciphertext');
  }
}
