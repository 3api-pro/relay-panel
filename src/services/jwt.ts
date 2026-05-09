import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AdminSession {
  type: 'admin';
  adminId: number;
  tenantId: number;
  email: string;
}

export interface CustomerSession {
  type: 'customer';
  endUserId: number;
  tenantId: number;
  email: string;
}

export type Session = AdminSession | CustomerSession;

const ALG = 'HS256';
const TTL_SECONDS = 7 * 24 * 60 * 60;

export function signSession(payload: Session): string {
  return jwt.sign(payload, config.jwtSecret, { algorithm: ALG, expiresIn: TTL_SECONDS });
}

export function verifySession(token: string): Session | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: [ALG] }) as any;
    if (decoded?.type === 'admin' && typeof decoded.adminId === 'number') return decoded;
    if (decoded?.type === 'customer' && typeof decoded.endUserId === 'number') return decoded;
    return null;
  } catch {
    return null;
  }
}
