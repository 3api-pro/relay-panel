import type { PassivePage, PassiveRecord } from '@relay-panel/adapter-core';
import type { Sub2apiHttp, PaginatedData } from './http.js';
import { normalizeUsageRecord } from './usage-records.js';
const amount = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeObservation(raw: Record<string, unknown>): PassiveRecord {
  const r = normalizeUsageRecord(raw);
  return { id: r.id, requestId: r.requestId, createdAt: r.createdAt, model: r.model, channelId: r.accountId,
    outcome: 'consumption', durationMs: amount(raw.duration_ms), firstTokenMs: amount(raw.first_token_ms),
    inputTokens: amount(raw.input_tokens), outputTokens: amount(raw.output_tokens), charge: r.actualCost,
    supplierCost: r.accountCost, currency: 'USD', billingType: r.billingType,
    expectedCharge: r.billingType === 'balance' && r.totalCost !== null && r.rateMultiplier !== null ? amount(r.totalCost * r.rateMultiplier) : null };
}
export async function observations(http: Sub2apiHttp, query: { day: string; page: number }): Promise<PassivePage> {
  const qs = new URLSearchParams({ start_date: query.day, end_date: query.day, timezone: 'Asia/Shanghai',
    page: String(query.page), page_size: '100', exact_total: 'true', sort_by: 'id', sort_order: 'desc' });
  const data = await http.get<PaginatedData<Record<string, unknown>>>(`/api/v1/admin/usage?${qs}`);
  if (!data || !Array.isArray(data.items) || data.items.length > 100 || data.page !== query.page || data.page_size !== 100 ||
      !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pages) || (data.total > 0 ? data.pages !== Math.ceil(data.total / 100) : data.pages > 1)) {
    throw new Error('Unsupported passive log pagination');
  }
  const items = data.items.map(normalizeObservation);
  if (new Set(items.map(r => r.id)).size !== items.length || items.some(r => new Date(Date.parse(r.createdAt) + 8 * 3600000).toISOString().slice(0, 10) !== query.day)) throw new Error('Passive log range mismatch');
  return { items, sourceIds:items.map(r=>r.id), page: data.page, pages: data.pages, total: data.total, sourceScope: 'consumption-only' };
}
