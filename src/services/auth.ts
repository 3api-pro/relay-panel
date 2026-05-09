import bcrypt from 'bcryptjs';
import { query } from './database';
import { config } from '../config';
import { logger } from './logger';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Ensure a default reseller_admin exists for tenant 1 (single mode).
 * Called once at startup. Idempotent.
 */
export async function ensureDefaultAdmin(): Promise<void> {
  const email = process.env.ADMIN_DEFAULT_EMAIL || 'admin@panel.local';
  const password = config.adminDefaultPassword;

  const existing = await query<{ id: number }>(
    `SELECT id FROM reseller_admin WHERE tenant_id = 1 LIMIT 1`,
  );
  if (existing.length > 0) return;

  const hash = await hashPassword(password);
  await query(
    `INSERT INTO reseller_admin (tenant_id, email, password_hash, display_name, status)
     VALUES (1, $1, $2, $3, 'active')`,
    [email, hash, 'Default Admin'],
  );
  logger.warn(
    { email, password: password === 'admin' ? '<DEFAULT — change immediately>' : '<from env>' },
    'auth:default_admin_created',
  );
}
