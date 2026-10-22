import { createHash } from 'node:crypto';
import type { PassivePage, PassiveRecord } from '@relay-panel/adapter-core';
import type { NewapiHttp, PageInfo } from './http.js';
const amount = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const label = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
function identityOf(raw:Record<string,unknown>):string {
  const seconds = amount(raw.created_at), requestId = label(raw.request_id);
  if (seconds === null || seconds > 8640000000000 || !Number.isSafeInteger(raw.id) || Number(raw.id) < 1) throw new Error('Invalid passive log identity');
  // Modern ClickHouse sources may synthesize numeric display IDs; prefer the engine request identity.
  const identity = requestId ? `${requestId}:${raw.type}:${raw.channel}:${seconds}` : `row:${raw.id}:${seconds}:${raw.type}`;
  return createHash('sha256').update(identity).digest('hex');
}
export function normalizeObservation(raw: Record<string, unknown>): PassiveRecord | null {
  if (raw.type !== 2 && raw.type !== 5) return null; // exclude topups, refunds, administrative and login logs
  const id=identityOf(raw),requestId=label(raw.request_id),seconds=Number(raw.created_at);
  return { id, requestId, createdAt: new Date(seconds * 1000).toISOString(),
    model: label(raw.model_name), channelId: Number.isSafeInteger(raw.channel) && Number(raw.channel) > 0 ? String(raw.channel) : null,
    outcome: raw.type === 5 ? 'error' : 'consumption', durationMs: amount(raw.use_time) === null ? null : amount(Number(raw.use_time) * 1000),
    firstTokenMs: null, inputTokens: amount(raw.prompt_tokens), outputTokens: amount(raw.completion_tokens),
    charge: raw.type === 2 && amount(raw.quota) !== null ? Number(raw.quota) / 500000 : null,
    supplierCost: null, expectedCharge: null, currency: 'USD', billingType: 'unknown' };
}
export async function observations(http: NewapiHttp, query: { day: string; page: number }): Promise<PassivePage> {
  const start = Date.parse(query.day + 'T00:00:00+08:00') / 1000;
  const qs = new URLSearchParams({ p: String(query.page), page_size: '100', start_timestamp: String(start), end_timestamp: String(start + 86399), type: '0' });
  const data = await http.get<PageInfo<Record<string, unknown>>>(`/api/log/?${qs}`);
  if (!data || !Array.isArray(data.items) || data.items.length > 100 || data.page !== query.page || data.page_size !== 100 || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Unsupported passive log pagination');
  const sourceIds=data.items.map(identityOf),items = data.items.map(normalizeObservation).filter((r): r is PassiveRecord => r !== null);
  if (new Set(sourceIds).size !== sourceIds.length || data.items.some(r=>Number(r.created_at)<start||Number(r.created_at)>start+86399)) throw new Error('Passive log range mismatch');
  return { items, sourceIds, page: query.page, pages: Math.ceil(data.total / 100), total: data.total, sourceScope: 'consume-and-error-logs' };
}
