/**
 * Channel connectivity tester (v0.3).
 *
 * Hits the channel's base_url with a provider-specific probe and persists
 * the result. Per provider:
 *
 *   anthropic / llmapi-wholesale
 *     POST {base}/messages with a 1-token canary. 200/4xx-with-anthropic-shape
 *     counts as reachable. 401/403 → key is bad. Network/5xx → unreachable.
 *
 *   openai
 *     GET {base}/models. Auth via Bearer. Cheap and standardised across
 *     OpenAI-compatible servers (Together, Anyscale, Groq, LM Studio, etc.).
 *
 *   custom
 *     GET {base} root. Any 2xx-4xx response = "reachable". 5xx / network
 *     fail. We don't try to interpret a body the operator picked.
 *
 *   gemini / moonshot / deepseek / minimax / qwen
 *     Stub — reports ok=false with "test ships in v0.4".
 *
 * Updates upstream_channel.last_tested_at + last_test_result so the UI
 * can render the result without re-hitting the upstream.
 */
import { query } from './database';
import { logger } from './logger';

export interface TestResult {
  ok: boolean;
  latency_ms?: number;
  status?: number;
  error?: string;
  models?: string[];
  /** Convenience flag the UI can colour-code on. */
  category?: 'ok' | 'auth' | 'rate_limit' | 'unreachable' | 'protocol' | 'not_implemented';
}

const TEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ChannelRow {
  id: number;
  tenant_id: number;
  base_url: string;
  api_key: string;
  provider_type: string;
  custom_headers: Record<string, string> | null;
  keys: Array<{ key: string; status: string }> | null;
}

function pickAnyKey(row: ChannelRow): string | null {
  if (Array.isArray(row.keys)) {
    for (const k of row.keys) {
      if (k.status === 'active' && k.key) return k.key;
    }
    if (row.keys.length > 0 && row.keys[0].key) return row.keys[0].key;
  }
  return row.api_key || null;
}

function headerMap(row: ChannelRow, accept: string): Record<string, string> {
  const apiKey = pickAnyKey(row);
  const headers: Record<string, string> = {
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': '3api-relay-panel-tester/0.3.0',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (row.custom_headers && typeof row.custom_headers === 'object') {
    Object.assign(headers, row.custom_headers);
  }
  return headers;
}

async function testAnthropic(row: ChannelRow): Promise<TestResult> {
  const url = `${row.base_url.replace(/\/$/, '')}/messages`;
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: headerMap(row, 'application/json'),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
      TEST_TIMEOUT_MS,
    );
    const latency = Date.now() - start;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latency_ms: latency, error: 'auth_failed', category: 'auth' };
    }
    if (res.status === 429) {
      // 429 still proves reachability.
      return { ok: true, status: res.status, latency_ms: latency, error: 'rate_limited', category: 'rate_limit' };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    return { ok: res.status < 500, status: res.status, latency_ms: latency, category: 'ok' };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

async function testOpenAi(row: ChannelRow): Promise<TestResult> {
  const url = `${row.base_url.replace(/\/$/, '')}/models`;
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: headerMap(row, 'application/json') },
      TEST_TIMEOUT_MS,
    );
    const latency = Date.now() - start;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latency_ms: latency, error: 'auth_failed', category: 'auth' };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    let models: string[] = [];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.data)) models = j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean).slice(0, 20);
    } catch { /* tolerate non-JSON */ }
    return { ok: res.status < 400, status: res.status, latency_ms: latency, models, category: 'ok' };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

async function testCustom(row: ChannelRow): Promise<TestResult> {
  const url = row.base_url.replace(/\/$/, '');
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: headerMap(row, '*/*') },
      TEST_TIMEOUT_MS,
    );
    const latency = Date.now() - start;
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    return { ok: true, status: res.status, latency_ms: latency, category: 'ok' };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

async function testStub(provider: string): Promise<TestResult> {
  return {
    ok: false,
    error: `provider_type '${provider}' test ships in v0.4`,
    category: 'not_implemented',
  };
}

/**
 * Run a connectivity probe and persist the result. Returns the result.
 * If the channel doesn't exist or doesn't belong to the caller's tenant,
 * returns null.
 */
export async function testChannel(channelId: number, tenantId: number): Promise<TestResult | null> {
  const rows = await query<ChannelRow>(
    `SELECT id, tenant_id, base_url, COALESCE(api_key, '') AS api_key,
            provider_type, custom_headers, keys
       FROM upstream_channel
      WHERE id = $1 AND tenant_id = $2`,
    [channelId, tenantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  let result: TestResult;
  try {
    switch (row.provider_type) {
      case 'anthropic':
      case 'llmapi-wholesale':
        result = await testAnthropic(row);
        break;
      case 'openai':
        result = await testOpenAi(row);
        break;
      case 'custom':
        result = await testCustom(row);
        break;
      case 'gemini':
      case 'moonshot':
      case 'deepseek':
      case 'minimax':
      case 'qwen':
        result = await testStub(row.provider_type);
        break;
      default:
        result = await testStub(row.provider_type || 'unknown');
    }
  } catch (err: any) {
    result = { ok: false, error: err.message || String(err), category: 'unreachable' };
  }

  // Persist — never throw back from the probe even if the write fails.
  try {
    await query(
      `UPDATE upstream_channel
          SET last_tested_at = NOW(),
              last_test_result = $1::jsonb
        WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(result), channelId, tenantId],
    );
  } catch (err: any) {
    logger.warn({ err: err.message, channelId }, 'channel-test:persist:failed');
  }

  logger.info(
    { channelId, provider: row.provider_type, ok: result.ok, latency: result.latency_ms, status: result.status },
    'channel-test:done',
  );
  return result;
}
