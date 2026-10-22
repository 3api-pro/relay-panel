import { describe, it, expect, vi } from 'vitest';
import { Sub2apiAdminClient } from '../src/adapter.js';
import { parsePlatformQuotas, quotaUserPath } from '../src/quotas.js';
const row = () => ({ platform: 'anthropic', daily_usage_usd: 0, daily_limit_usd: 0, daily_window_resets_at: null, weekly_usage_usd: 4, weekly_limit_usd: null, weekly_window_resets_at: '2026-10-26T00:00:00Z', monthly_usage_usd: 8, monthly_limit_usd: 200, monthly_window_resets_at: null });
describe('quota full replacement contract', () => {
  it('preserves zero, null and real usage; supports empty unlimited lists', () => {
    expect(parsePlatformQuotas({ platform_quotas: [row()] })).toEqual([{ platform: 'anthropic', daily: { usageUsd: 0, limitUsd: 0 }, weekly: { usageUsd: 4, limitUsd: null, resetsAt: '2026-10-26T00:00:00Z' }, monthly: { usageUsd: 8, limitUsd: 200 } }]);
    expect(parsePlatformQuotas({ platform_quotas: [] })).toEqual([]);
  });
  it('refuses missing limits, malformed lists, duplicate platforms and unknown usage', () => {
    for (const body of [undefined, {}, { platform_quotas: null }, { platform_quotas: [row(), row()] }, ...['daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd', 'daily_usage_usd'].map(k => ({ platform_quotas: [{ ...row(), [k]: undefined }] })), { platform_quotas: [{ ...row(), hourly_limit_usd: 10 }] }, { platform_quotas: [{ ...row(), daily_limit_usd: '10' }] }, { platform_quotas: [{ ...row(), monthly_usage_usd: NaN }] }]) expect(() => parsePlatformQuotas(body)).toThrow('Invalid platform quota response');
  });
  it('validates user IDs before either HTTP request', async () => {
    const get = vi.fn(), put = vi.fn(), c = new Sub2apiAdminClient({} as never, { get, put } as never);
    for (const id of ['0', '-1', '01', '1/../../accounts', '9223372036854775808']) {
      await expect(c.users.getPlatformQuotas!(id)).rejects.toThrow('Invalid quota user ID');
      await expect(c.users.setPlatformQuotas!(id, [])).rejects.toThrow('Invalid quota user ID');
    }
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(quotaUserPath('9223372036854775807')).toContain('9223372036854775807');
  });
  it('rejects malformed GET and PUT envelopes instead of silently clearing limits', async () => {
    const get = vi.fn().mockResolvedValue({}), put = vi.fn().mockResolvedValue({});
    const c = new Sub2apiAdminClient({} as never, { get, put } as never);
    await expect(c.users.getPlatformQuotas!('1')).rejects.toThrow('Invalid platform quota response');
    await expect(c.users.setPlatformQuotas!('1', [])).rejects.toThrow('Invalid platform quota response');
  });
});
