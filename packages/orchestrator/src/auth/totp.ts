import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of secret) {
    const n = alphabet.indexOf(ch);
    if (n < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | n; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); }
  }
  return Buffer.from(out);
}
export const newTotpSecret = (): string => base32(randomBytes(20));
/** RFC 6238, SHA-1, 30 second steps; the optional width is for RFC test vectors. */
export function totp(secret: string, counter: number, digits = 6): string {
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decode(secret)).update(moving).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
}
export function totpCounter(secret: string, code: string, lastCounter: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30_000);
  for (const step of [counter, counter - 1, counter + 1]) {
    if (step <= lastCounter || step < 0) continue;
    if (timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}
