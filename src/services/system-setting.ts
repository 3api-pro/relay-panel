/**
 * Per-tenant system settings (P1 #10).
 *
 *   signup_enabled       — POST /storefront/auth/signup honours.
 *   maintenance_mode     — /storefront/* + /v1/* return 503.
 *   announcement / level — surfaced via GET /admin/system-setting and
 *                          forwarded into /storefront/brand for the UI
 *                          to render as a top-of-page banner.
 *
 * Schema lives in db/migrations/008-system-setting.sql. One row per
 * tenant; new tenants are seeded by the migration and by upsert in
 * getForTenant() on first read.
 *
 * Cached 30 s per tenant in-process so middleware doesn't slam the DB.
 * Cache is invalidated by patchForTenant().
 */
import { query } from './database';
import { logger } from './logger';

export interface SystemSetting {
  tenant_id: number;
  signup_enabled: boolean;
  maintenance_mode: boolean;
  announcement: string | null;
  announcement_level: 'info' | 'warn' | 'error';
  updated_at: string | null;
}

const DEFAULTS: Omit<SystemSetting, 'tenant_id' | 'updated_at'> = {
  signup_enabled: true,
  maintenance_mode: false,
  announcement: null,
  announcement_level: 'info',
};

const cache = new Map<number, { v: SystemSetting; expires: number }>();
const CACHE_TTL_MS = 30 * 1000;

function defaultFor(tenantId: number): SystemSetting {
  return { tenant_id: tenantId, ...DEFAULTS, updated_at: null };
}

function normaliseLevel(s: unknown): 'info' | 'warn' | 'error' {
  return s === 'warn' || s === 'error' ? s : 'info';
}

/**
 * Get the system setting for a tenant. Read-through cache + upsert on miss.
 * Failures (DB down) fall back to DEFAULTS so the relay does NOT 503 the
 * whole world just because system_setting is unavailable.
 */
export async function getForTenant(tenantId: number): Promise<SystemSetting> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expires > now) return hit.v;

  try {
    const rows = await query<any>(
      `SELECT tenant_id, signup_enabled, maintenance_mode, announcement,
              announcement_level, updated_at::text AS updated_at
         FROM system_setting WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0) {
      // Seed on demand (idempotent — migration already seeded existing
      // tenants, but new tenants created after deploy land here).
      await query(
        `INSERT INTO system_setting (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      ).catch(() => {});
      const v = defaultFor(tenantId);
      cache.set(tenantId, { v, expires: now + CACHE_TTL_MS });
      return v;
    }
    const r = rows[0];
    const v: SystemSetting = {
      tenant_id: r.tenant_id,
      signup_enabled: Boolean(r.signup_enabled),
      maintenance_mode: Boolean(r.maintenance_mode),
      announcement: r.announcement ?? null,
      announcement_level: normaliseLevel(r.announcement_level),
      updated_at: r.updated_at ?? null,
    };
    cache.set(tenantId, { v, expires: now + CACHE_TTL_MS });
    return v;
  } catch (err: any) {
    logger.warn({ err: err.message, tenantId }, 'system-setting:read:fallback');
    // Soft-fail to defaults — never let an admin DB outage break the
    // public storefront.
    return defaultFor(tenantId);
  }
}

/**
 * Convenience helper for the /v1/messages hot path — returns just
 * maintenance_mode. Same caching as getForTenant.
 */
export async function isMaintenanceMode(tenantId: number): Promise<boolean> {
  const v = await getForTenant(tenantId);
  return v.maintenance_mode === true;
}

export async function isSignupEnabled(tenantId: number): Promise<boolean> {
  const v = await getForTenant(tenantId);
  return v.signup_enabled !== false;
}

export interface PatchInput {
  signup_enabled?: boolean;
  maintenance_mode?: boolean;
  announcement?: string | null;
  announcement_level?: 'info' | 'warn' | 'error';
}

export function validatePatch(p: any): string | null {
  if (!p || typeof p !== 'object') return 'body must be an object';
  if (p.signup_enabled != null && typeof p.signup_enabled !== 'boolean') {
    return 'signup_enabled must be boolean';
  }
  if (p.maintenance_mode != null && typeof p.maintenance_mode !== 'boolean') {
    return 'maintenance_mode must be boolean';
  }
  if (p.announcement != null && p.announcement !== null && typeof p.announcement !== 'string') {
    return 'announcement must be string or null';
  }
  if (p.announcement && p.announcement.length > 2000) {
    return 'announcement must be ≤2000 chars';
  }
  if (p.announcement_level != null && !['info', 'warn', 'error'].includes(p.announcement_level)) {
    return "announcement_level must be one of: 'info', 'warn', 'error'";
  }
  return null;
}

/**
 * Partial update. Idempotent. Invalidates the cache so subsequent
 * reads see the new value within milliseconds.
 */
export async function patchForTenant(
  tenantId: number,
  patch: PatchInput,
): Promise<SystemSetting> {
  // Ensure the row exists first (race-safe; INSERT is no-op on conflict).
  await query(
    `INSERT INTO system_setting (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );

  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, val: any): void => {
    sets.push(`${col} = $${sets.length + 1}`);
    vals.push(val);
  };
  if (patch.signup_enabled != null)    push('signup_enabled', patch.signup_enabled);
  if (patch.maintenance_mode != null)  push('maintenance_mode', patch.maintenance_mode);
  if (patch.announcement !== undefined) push('announcement', patch.announcement); // allow explicit null to clear
  if (patch.announcement_level != null) push('announcement_level', normaliseLevel(patch.announcement_level));
  push('updated_at', new Date());

  vals.push(tenantId);
  const rows = await query<any>(
    `UPDATE system_setting SET ${sets.join(', ')}
       WHERE tenant_id = $${vals.length}
     RETURNING tenant_id, signup_enabled, maintenance_mode,
               announcement, announcement_level, updated_at::text AS updated_at`,
    vals,
  );
  cache.delete(tenantId);

  const r = rows[0];
  return {
    tenant_id: r.tenant_id,
    signup_enabled: Boolean(r.signup_enabled),
    maintenance_mode: Boolean(r.maintenance_mode),
    announcement: r.announcement ?? null,
    announcement_level: normaliseLevel(r.announcement_level),
    updated_at: r.updated_at ?? null,
  };
}

/** Test helper — drop the cache so the next read hits the DB. */
export function invalidateCache(tenantId?: number): void {
  if (tenantId == null) cache.clear();
  else cache.delete(tenantId);
}
