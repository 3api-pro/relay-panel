import { describe, expect, it, vi } from 'vitest';
import { NewapiAdminClient } from '../src/adapter.js';
describe('finance calendar day', () => {
  it('covers the entire Beijing day including leap day, without changing instant-range queries', async () => {
    const get = vi.fn().mockResolvedValue([{ count: 2, token_used: 10, quota: 500000, model_name: 'fixture' }]);
    const client = new NewapiAdminClient({} as never, { get } as never);
    const result = await client.stats.usageCalendarDays('2028-02-29', '2028-02-29');
    const url = new URL(get.mock.calls[0]?.[0], 'http://fixture.local');
    const start = Number(url.searchParams.get('start_timestamp'));
    const end = Number(url.searchParams.get('end_timestamp'));
    expect(new Date(start * 1000).toISOString()).toBe('2028-02-28T16:00:00.000Z');
    expect(new Date(end * 1000).toISOString()).toBe('2028-02-29T15:59:59.000Z');
    expect(end - start).toBe(86399);
    expect(result).toMatchObject({ requests: 2, cost: 1, billingSource: 'quota' });
    await client.stats.usage(new Date(1000), new Date(5000));
    expect(get.mock.calls[1]?.[0]).toBe('/api/data/?start_timestamp=1&end_timestamp=5');
  });
});
