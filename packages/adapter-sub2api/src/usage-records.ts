import type { UsageRecord, UsageRecordQuery, UsageRecordPage } from '@relay-panel/adapter-core';
import type { Sub2apiHttp, PaginatedData } from './http.js';

const amount = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const id = (v: unknown): string | null => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : null;
const label = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;

/** Do not return raw DTOs: they contain nested users, API keys, IPs and user agents. */
export function normalizeUsageRecord(raw: Record<string, unknown>): UsageRecord {
  const sourceId = id(raw.id);
  if (!sourceId || typeof raw.created_at !== 'string' || !Number.isFinite(Date.parse(raw.created_at))) {
    throw new Error('Invalid usage record identity');
  }
  const totalCost = amount(raw.total_cost);
  const accountStatsCost = amount(raw.account_stats_cost);
  // Engine account dashboard formula: COALESCE(account_stats_cost,total_cost) * COALESCE(account_rate_multiplier,1).
  const accountRateMultiplier = raw.account_rate_multiplier == null ? 1 : amount(raw.account_rate_multiplier);
  const base = raw.account_stats_cost == null ? totalCost : accountStatsCost;
  const activityFields = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'image_count', 'video_count'];
  const values = activityFields.map(k => amount(raw[k]));
  const knownActivity = values.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return {
    id: sourceId, requestId: label(raw.request_id), createdAt: new Date(raw.created_at).toISOString(),
    model: label(raw.model), userId: id(raw.user_id), accountId: id(raw.account_id), subscriptionId: id(raw.subscription_id),
    billingType: raw.billing_type === 0 ? 'balance' : raw.billing_type === 1 ? 'subscription' : 'unknown',
    activity: knownActivity > 0 ? knownActivity : values.slice(0, 4).every(n => n !== null) ? 0 : null,
    actualCost: amount(raw.actual_cost), totalCost, rateMultiplier: amount(raw.rate_multiplier),
    accountStatsCost, accountRateMultiplier,
    accountCost: base !== null && accountRateMultiplier !== null ? amount(base * accountRateMultiplier) : null,
    costUnit: 'USD', settlementProof: 'unavailable',
  };
}

export async function usageRecords(http: Sub2apiHttp, query: UsageRecordQuery): Promise<UsageRecordPage> {
  const qs = new URLSearchParams({ start_date: query.from, end_date: query.to, timezone: 'Asia/Shanghai',
    page: String(query.page), page_size: '100', exact_total: 'true', sort_by: 'id', sort_order: 'asc' });
  if (query.requestId) qs.set('request_id', query.requestId);
  const data = await http.get<PaginatedData<Record<string, unknown>>>(`/api/v1/admin/usage?${qs}`);
  if (!data || !Array.isArray(data.items) || data.items.length > 100 || data.page !== query.page || data.page_size !== 100 ||
      !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pages) || data.pages < 0) {
    throw new Error('Invalid usage pagination');
  }
  const items = data.items.map(normalizeUsageRecord);
  if (new Set(items.map(r => r.id)).size !== items.length || items.some(r =>
    (query.requestId && r.requestId !== query.requestId) ||
    new Date(Date.parse(r.createdAt) + 8 * 3600_000).toISOString().slice(0, 10) < query.from ||
    new Date(Date.parse(r.createdAt) + 8 * 3600_000).toISOString().slice(0, 10) > query.to)) {
    throw new Error('Usage response does not match the requested range');
  }
  return { items, total: data.total, page: data.page, pageSize: 100, pages: data.pages };
}
