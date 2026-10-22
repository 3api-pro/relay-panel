import type { PlatformQuota } from '@relay-panel/adapter-core';

export function quotaUserPath(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('Invalid quota user ID');
  return `/api/v1/admin/users/${id}/platform-quotas`;
}

/** A missing quota field is unknown, never permission to remove an existing limit. */
export function parsePlatformQuotas(data: unknown): PlatformQuota[] {
  const fail = (): never => { throw new Error('Invalid platform quota response; refusing an incomplete quota snapshot'); };
  if (!data || typeof data !== 'object' || !('platform_quotas' in data)) return fail();
  const rows = data.platform_quotas;
  if (!Array.isArray(rows) || rows.length > 64) return fail();
  const seen = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object') return fail();
    const q = row as Record<string, unknown>, platform = q.platform;
    if (Object.keys(q).some(key => key.endsWith('_limit_usd') && !['daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd'].includes(key))) return fail();
    if (typeof platform !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(platform) || seen.has(platform)) return fail();
    seen.add(platform);
    const window = (name: string) => {
      const usage = q[`${name}_usage_usd`], limit = q[`${name}_limit_usd`], reset = q[`${name}_window_resets_at`];
      if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) return fail();
      if (limit !== null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) return fail();
      if (reset != null && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset)))) return fail();
      return { usageUsd: usage, limitUsd: limit as number | null, ...(typeof reset === 'string' ? { resetsAt: reset } : {}) };
    };
    return { platform, daily: window('daily'), weekly: window('weekly'), monthly: window('monthly') };
  });
}
