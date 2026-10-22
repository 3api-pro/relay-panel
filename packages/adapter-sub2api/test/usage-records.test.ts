import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageRecord, usageRecords } from '../src/usage-records.js';
import { Sub2apiHttp } from '../src/http.js';

const raw = { id: 7, created_at: '2026-10-20T12:00:00Z', request_id: 'r-7', model: 'm', user_id: 2,
  billing_type: 0, actual_cost: 0, total_cost: 3, rate_multiplier: 1,
  account_stats_cost: 2, account_rate_multiplier: 0.5, input_tokens: 10,
  api_key: { key: 'DO-NOT-EXPOSE' }, user: { email: 'private@example.com' }, ip_address: '192.0.2.1' };
describe('allowlisted request evidence', () => {
  it('matches the account dashboard formula and omits private nested DTOs', () => {
    const item = normalizeUsageRecord(raw);
    expect(item.accountCost).toBe(1);
    expect(item.actualCost).toBe(0);
    expect(item.settlementProof).toBe('unavailable');
    expect(JSON.stringify(item)).not.toMatch(/DO-NOT-EXPOSE|private@example|192\.0\.2/);
    expect(item).not.toHaveProperty('api_key');
  });
  it('keeps missing and invalid costs unknown and honors engine null multiplier default', () => {
    expect(normalizeUsageRecord({ ...raw, actual_cost: undefined, account_stats_cost: null, account_rate_multiplier: null }))
      .toMatchObject({ actualCost: null, accountCost: 3, accountRateMultiplier: 1 });
    expect(normalizeUsageRecord({ ...raw, actual_cost: -1, account_stats_cost: '2' })).toMatchObject({ actualCost: null, accountCost: null });
  });
  it('rejects unsafe identities', () => {
    expect(() => normalizeUsageRecord({ ...raw, id: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
  it('uses exact bounded pagination and rejects a mismatched response', async () => {
    const http = new Sub2apiHttp('https://unused.invalid', null);
    const get = vi.spyOn(http, 'get').mockResolvedValue({ items: [raw], page: 1, page_size: 100, pages: 1, total: 1 });
    await usageRecords(http, { from: '2026-10-20', to: '2026-10-20', page: 1, requestId: 'r-7' });
    const url = new URL(get.mock.calls[0]![0], 'https://unused.invalid');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ exact_total: 'true', timezone: 'Asia/Shanghai', sort_by: 'id', sort_order: 'asc', request_id: 'r-7', page_size: '100' });
    await expect(usageRecords(http, { from: '2026-10-20', to: '2026-10-20', page: 2 })).rejects.toThrow('pagination');
    await expect(usageRecords(http, { from: '2026-10-21', to: '2026-10-21', page: 1 })).rejects.toThrow('range');
    await expect(usageRecords(http, { from: '2026-10-20', to: '2026-10-20', page: 1, requestId: 'different' })).rejects.toThrow('range');
  });
});
