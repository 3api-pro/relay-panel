import { describe, expect, it, vi } from 'vitest';
import { Sub2apiAdminClient } from '../src/adapter.js';

function clientFor(data: unknown): Sub2apiAdminClient {
  const http = { get: vi.fn().mockResolvedValue(data) };
  return new Sub2apiAdminClient({} as never, http as never);
}

describe('sub2api rechargeSummary', () => {
  it('保留新版接口按支付币种拆分的金额，不把对象强转为字符串', async () => {
    const client = clientFor({
      today_amount: { CNY: 100, USD: 12.5 },
      today_count: 2,
      daily_series: [
        { date: '2026-08-07', amount: { CNY: 80 }, count: 1 },
        { date: '2026-08-08', amount: { CNY: 20, USD: 12.5 }, count: 1 },
      ],
    });

    await expect(client.stats.rechargeSummary?.(7)).resolves.toEqual({
      todayAmount: { CNY: 100, USD: 12.5 },
      todayCount: 2,
      daily: [
        { date: '2026-08-07', amount: { CNY: 80 }, count: 1 },
        { date: '2026-08-08', amount: { CNY: 20, USD: 12.5 }, count: 1 },
      ],
    });
  });

  it('兼容旧版接口的数字金额并按 CNY 归一化', async () => {
    const client = clientFor({
      today_amount: 10,
      today_count: 1,
      daily_series: [{ date: '2026-08-08', amount: 10, count: 1 }],
    });

    await expect(client.stats.rechargeSummary?.(7)).resolves.toEqual({
      todayAmount: { CNY: 10 },
      todayCount: 1,
      daily: [{ date: '2026-08-08', amount: { CNY: 10 }, count: 1 }],
    });
  });
});
