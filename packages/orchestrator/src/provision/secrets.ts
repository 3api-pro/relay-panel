import { randomBytes } from 'node:crypto';

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
