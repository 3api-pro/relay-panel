/**
 * Channel connectivity tester.
 *
 * Hits the channel's base_url with a provider-specific probe and persists
 * the result. Per provider:
 *
 *   anthropic / llmapi-wholesale
 *     POST {base}/messages with a 1-token canary. 200/4xx-with-anthropic-shape
 *     counts as reachable. 401/403 → key is bad. Network/5xx → unreachable.
 *
 *   openai / deepseek / moonshot / qwen / minimax    [v0.5]
 *     GET {base}/models. Bearer auth. OpenAI-compatible servers all
 *     expose this; we record models_count + the first 5 ids so the UI
 *     can show "10 models, claude-3-5-sonnet, gpt-4o, ..." inline.
 *
 *   gemini    [v0.5]
 *     GET {base}/models?key={api_key}. Google v1beta REST is query-string
 *     auth, not Bearer. models[].name carries the canonical model id.
 *
 *   custom
 *     GET {base} root. Any 2xx-4xx response = "reachable". 5xx / network
 *     fail. We don't try to interpret a body the operator picked.
 *
 * Updates upstream_channel.last_tested_at + last_test_result so the UI
 * can render the result without re-hitting the upstream.
 */
import { query } from './database';
import { ProxyAgent } from 'undici';
import { getConfig } from './app-config';

let _disp: ProxyAgent | undefined;
let _dispUrl: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispUrl) { _disp = new ProxyAgent(proxy); _dispUrl = proxy; }
  else if (!proxy) { _disp = undefined; _dispUrl = undefined; }
  return _disp;
}

import { logger } from './logger';
import { DEEPSEEK_DEFAULT_BASE_URL } from './provider-deepseek';
import { MOONSHOT_DEFAULT_BASE_URL } from './provider-moonshot';
import { QWEN_DEFAULT_BASE_URL } from './provider-qwen';
import { MINIMAX_DEFAULT_BASE_URL } from './provider-minimax';
import { GEMINI_DEFAULT_BASE_URL } from './provider-gemini';

export interface TestResult {
  ok: boolean;
  latency_ms?: number;
  status?: number;
  error?: string;
  /** OpenAI-compat /models result count. */
  models_count?: number | null;
  /** First N model ids (capped at 5). */
  sample_models?: string[];
  /** legacy alias — kept for backward-compat with UI / smoke. */
  models?: string[];
  /** Convenience flag the UI can colour-code on. */
  category?: 'ok' | 'auth' | 'rate_limit' | 'unreachable' | 'protocol' | 'not_implemented';
}

const TEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const d = dispatcher();
    // Route public-internet probes through the outbound proxy when set, so a
    // container without direct internet (e.g. CN host) can still reach
    // api.llmapi.pro / api.anthropic.com / Stripe / etc.
    return await fetch(url, { ...init, signal: ctrl.signal, ...(d ? { dispatcher: d } : {}) } as any);
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
    'User-Agent': '3api-relay-panel-tester/0.5.0',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (row.custom_headers && typeof row.custom_headers === 'object') {
    Object.assign(headers, row.custom_headers);
  }
  return headers;
}

/**
 * Per-provider default base_url (mirrors upstream.ts/providerDefaultBase).
 * When the channel was created without an explicit base_url we still
 * test against the canonical endpoint instead of the empty string.
 */
function effectiveBaseUrl(row: ChannelRow): string {
  if (row.base_url && row.base_url.length > 0) return row.base_url.replace(/\/$/, '');
  switch (row.provider_type) {
    case 'deepseek': return DEEPSEEK_DEFAULT_BASE_URL;
    case 'moonshot': return MOONSHOT_DEFAULT_BASE_URL;
    case 'qwen':     return QWEN_DEFAULT_BASE_URL;
    case 'minimax':  return MINIMAX_DEFAULT_BASE_URL;
    case 'gemini':   return GEMINI_DEFAULT_BASE_URL;
    default:         return row.base_url || '';
  }
}

async function testAnthropic(row: ChannelRow): Promise<TestResult> {
  const url = `${effectiveBaseUrl(row)}/messages`;
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

/**
 * v0.5 — real healthCheck for the OpenAI-compatible quintet:
 * openai / deepseek / moonshot / qwen / minimax.
 *
 * Uses GET /models with Bearer auth. 401/403 = auth fail. 5xx = unreachable.
 * On success parses `data[].id` so the UI can preview which models the
 * channel actually exposes (Anthropic, OpenAI and the four mainland
 * providers all surface model lists in the same JSON shape).
 */
async function testOpenAiCompat(row: ChannelRow): Promise<TestResult> {
  const url = `${effectiveBaseUrl(row)}/models`;
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
    if (res.status === 429) {
      return { ok: true, status: res.status, latency_ms: latency, error: 'rate_limited', category: 'rate_limit' };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    let allIds: string[] = [];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.data)) allIds = j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean);
    } catch { /* tolerate non-JSON */ }
    const sample = allIds.slice(0, 5);
    return {
      ok: res.status < 400,
      status: res.status,
      latency_ms: latency,
      models_count: allIds.length || null,
      sample_models: sample,
      models: sample, // legacy alias
      category: res.status < 400 ? 'ok' : 'protocol',
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

/**
 * v0.5 — Gemini v1beta. Key is a query-string param (?key=…), NOT Bearer.
 * models[].name is the canonical id (e.g. "models/gemini-2.5-pro").
 */
async function testGemini(row: ChannelRow): Promise<TestResult> {
  const apiKey = pickAnyKey(row);
  if (!apiKey) {
    return { ok: false, error: 'no_api_key', category: 'auth' };
  }
  const base = effectiveBaseUrl(row);
  // base for gemini is typically /v1beta — append /models?key=…
  // tolerate user passing in a trailing /v1beta or root URL.
  const sep = base.endsWith('/v1beta') ? '' : '/v1beta';
  const url = `${base}${sep}/models?key=${encodeURIComponent(apiKey)}`;
  const start = Date.now();
  try {
    const customHeaders: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': '3api-relay-panel-tester/0.5.0',
    };
    if (row.custom_headers && typeof row.custom_headers === 'object') {
      Object.assign(customHeaders, row.custom_headers);
    }
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: customHeaders },
      TEST_TIMEOUT_MS,
    );
    const latency = Date.now() - start;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latency_ms: latency, error: `auth_failed: ${text.slice(0, 200)}`, category: 'auth' };
    }
    if (res.status === 429) {
      return { ok: true, status: res.status, latency_ms: latency, error: 'rate_limited', category: 'rate_limit' };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    let allNames: string[] = [];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.models)) allNames = j.models.map((m: any) => String(m?.name ?? '')).filter(Boolean);
    } catch { /* tolerate non-JSON */ }
    const sample = allNames.slice(0, 5);
    return {
      ok: res.status < 400,
      status: res.status,
      latency_ms: latency,
      models_count: allNames.length || null,
      sample_models: sample,
      models: sample,
      category: res.status < 400 ? 'ok' : 'protocol',
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

async function testCustom(row: ChannelRow): Promise<TestResult> {
  const url = effectiveBaseUrl(row);
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
    error: `provider_type '${provider}' real test not implemented`,
    category: 'not_implemented',
  };
}

/**
 * Lightweight healthCheck helper — given a channel-like object, run the
 * appropriate probe and return TestResult. Does NOT persist. Exported for
 * upstream.ts callers / smoke scripts that want to test without a row.
 */
export async function healthCheckChannel(channel: {
  base_url: string;
  api_key?: string | null;
  provider_type: string;
  custom_headers?: Record<string, string> | null;
  keys?: Array<{ key: string; status: string }> | null;
}): Promise<TestResult> {
  const row: ChannelRow = {
    id: 0,
    tenant_id: 0,
    base_url: channel.base_url,
    api_key: channel.api_key || '',
    provider_type: channel.provider_type,
    custom_headers: channel.custom_headers || null,
    keys: channel.keys || null,
  };
  return runProbe(row);
}

async function runProbe(row: ChannelRow): Promise<TestResult> {
  try {
    switch (row.provider_type) {
      case 'anthropic':
      case 'llmapi-wholesale':
        return await testAnthropic(row);
      case 'openai':
      case 'deepseek':
      case 'moonshot':
      case 'qwen':
      case 'minimax':
        return await testOpenAiCompat(row);
      case 'gemini':
        return await testGemini(row);
      case 'custom':
        return await testCustom(row);
      default:
        return await testStub(row.provider_type || 'unknown');
    }
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
}

/**
 * Fetch the upstream's model list (full set, not just a 5-id sample) so
 * the UI can offer "Fill from upstream" on the models-allowlist field.
 *
 * Strategy:
 *   - gemini   → GET {base}/models?key={apikey}, parse models[].name (strip "models/")
 *   - custom   → unsupported (no known schema) → 501
 *   - everyone else → GET {base}/models, parse data[].id (OpenAI / Anthropic shape)
 *
 * Returns the same TestResult-ish shape so the UI can reuse formatTestError.
 * Never throws — wraps fetch failures as { ok:false, category:'unreachable' }.
 */
export async function fetchUpstreamModels(
  channelId: number,
  tenantId: number,
): Promise<TestResult | null> {
  const rows = await query<ChannelRow>(
    `SELECT id, tenant_id, base_url, COALESCE(api_key, '') AS api_key,
            provider_type, custom_headers, keys
       FROM upstream_channel
      WHERE id = $1 AND tenant_id = $2`,
    [channelId, tenantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  if (row.provider_type === 'custom') {
    return {
      ok: false,
      error: 'custom_provider_no_schema',
      category: 'not_implemented',
    };
  }

  const isGemini = row.provider_type === 'gemini';
  const apiKey = pickAnyKey(row);
  const base = effectiveBaseUrl(row);
  if (!base) {
    return { ok: false, error: 'no_base_url', category: 'unreachable' };
  }
  const url = isGemini
    ? `${base}/models?key=${encodeURIComponent(apiKey || '')}`
    : `${base}/models`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': '3api-relay-panel-tester/0.5.0',
  };
  if (apiKey && !isGemini) headers.Authorization = `Bearer ${apiKey}`;
  // Anthropic public API additionally accepts x-api-key. Send both — the
  // upstream picks whichever it likes.
  if (apiKey && row.provider_type === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  if (row.custom_headers && typeof row.custom_headers === 'object') {
    Object.assign(headers, row.custom_headers);
  }

  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, TEST_TIMEOUT_MS);
    const latency = Date.now() - start;
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latency_ms: latency, error: 'auth_failed', category: 'auth' };
    }
    if (res.status === 429) {
      return { ok: false, status: res.status, latency_ms: latency, error: 'rate_limited', category: 'rate_limit' };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, latency_ms: latency, error: `upstream_5xx_${res.status}`, category: 'unreachable' };
    }
    if (res.status >= 400) {
      return { ok: false, status: res.status, latency_ms: latency, error: text.slice(0, 200), category: 'protocol' };
    }

    let models: string[] = [];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.data)) {
        // OpenAI / Anthropic shape
        models = j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean);
      } else if (Array.isArray(j?.models)) {
        // Gemini shape: { models: [{ name: 'models/gemini-2.5-pro' }] }
        models = j.models
          .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
          .filter(Boolean);
      }
    } catch { /* tolerate non-JSON */ }

    // Dedupe + stable sort so UI gets a predictable list.
    models = Array.from(new Set(models)).sort();

    if (models.length === 0) {
      return {
        ok: false,
        status: res.status,
        latency_ms: latency,
        error: 'no_models_in_response',
        category: 'protocol',
      };
    }
    return {
      ok: true,
      status: res.status,
      latency_ms: latency,
      models_count: models.length,
      sample_models: models.slice(0, 5),
      models,
      category: 'ok',
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err), category: 'unreachable' };
  }
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

  const result = await runProbe(row);

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
    {
      channelId, provider: row.provider_type, ok: result.ok,
      latency: result.latency_ms, status: result.status,
      models_count: result.models_count,
    },
    'channel-test:done',
  );
  return result;
}
