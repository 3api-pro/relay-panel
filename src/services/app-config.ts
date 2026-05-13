/**
 * app-config — DB-backed runtime config (KV).
 *
 * Authoritative source for any runtime setting/secret. Env is bootstrap-only
 * (DATABASE_URL, PORT, NODE_ENV). All other config — OAuth credentials,
 * outbound proxy, third-party API keys — must live in app_config.
 *
 * Pattern:
 *   - Load full table into memory on startup (initAppConfig)
 *   - Poll every REFRESH_MS to pick up admin-side updates without restart
 *   - getConfig(key, fallback?) reads the in-memory cache (synchronous)
 *   - setConfig(key, value) writes through to DB and refreshes the cache
 *
 * Failure mode: if DB read fails, the previous cache is retained — never
 * crash on poll. First-load failure is fatal (logged + throws).
 */
import { query } from './database';
import { logger } from './logger';

const REFRESH_MS = 5 * 60 * 1000;

const cache = new Map<string, string>();
let initialized = false;
let pollTimer: NodeJS.Timeout | null = null;

async function loadAll(): Promise<void> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_config`,
  );
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
}

export async function initAppConfig(): Promise<void> {
  if (initialized) return;
  await loadAll();
  initialized = true;
  logger.info({ keys: cache.size }, 'app-config:loaded');
  pollTimer = setInterval(() => {
    loadAll().catch((err) => {
      logger.warn({ err: err.message }, 'app-config:refresh:error');
    });
  }, REFRESH_MS);
  if (pollTimer.unref) pollTimer.unref();
}

export function getConfig(key: string): string | undefined;
export function getConfig(key: string, fallback: string): string;
export function getConfig(key: string, fallback?: string): string | undefined {
  const v = cache.get(key);
  return v !== undefined ? v : fallback;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
  cache.set(key, value);
}

export async function deleteConfig(key: string): Promise<void> {
  await query(`DELETE FROM app_config WHERE key = $1`, [key]);
  cache.delete(key);
}

/** Test-only: reset module state. */
export function _resetForTests(): void {
  cache.clear();
  initialized = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
