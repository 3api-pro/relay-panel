import { describe, expect, it, vi } from 'vitest';
import { Sub2apiAdminClient } from '../src/adapter.js';
describe('usage accounting source', () => {
  it('preserves actual zero and flags list-price fallback', async () => {
    const get = vi.fn().mockResolvedValueOnce({ total_actual_cost: 0, total_cost: 9, total_account_cost: 2 }).mockResolvedValueOnce({ total_cost: 9 });
    const client = new Sub2apiAdminClient({} as never, { get } as never);
    const date = new Date('2026-10-22T12:00:00Z');
    await expect(client.stats.usage(date, date)).resolves.toMatchObject({ cost: 0, accountCost: 2, billingSource: 'billed' });
    await expect(client.stats.usage(date, date)).resolves.toMatchObject({ cost: 9, billingSource: 'list_price' });
    expect(get.mock.calls[0]?.[0]).toContain('start_date=2026-10-22&end_date=2026-10-22&timezone=Asia/Shanghai');
  });
});
