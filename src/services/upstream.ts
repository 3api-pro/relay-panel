/**
 * Upstream HTTP client.
 *
 * Two transport modes:
 *  - JSON (non-streaming): callUpstream({ stream: false })
 *  - SSE (streaming):      callUpstreamStream(...) — returns a Response
 *                          whose body is Anthropic-shaped SSE the relay can
 *                          pipe directly to the client.
 *
 * v0.4 — full multi-protocol routing.
 *   Anthropic-shaped /v1/messages is our wire format. provider_type on the
 *   channel selects how we talk to the upstream:
 *
 *     anthropic         → POST {base}/messages, body as-is (default).
 *     llmapi-wholesale  → same as anthropic; route through llmapi.pro.
 *     openai            → POST {base}/chat/completions with anthropic↔openai
 *                         transcode (both JSON and SSE). Tools, vision,
 *                         system prompts all map.
 *     deepseek          → same as openai with a DeepSeek default base_url
 *                         (api.deepseek.com/v1). Channel can override.
 *     moonshot          → openai-compat; default api.moonshot.cn/v1.
 *     qwen              → openai-compat;
 *                         default dashscope.aliyuncs.com/compatible-mode/v1.
 *     minimax           → openai-compat (chatcompletion-v2 endpoint);
 *                         default api.minimax.chat/v1.
 *     gemini            → google v1beta REST with its own adapter
 *                         (contents/parts schema, ?key=…, streamGenerateContent).
 *     custom            → passthrough — sends the body as-is to the
 *                         configured base_url + custom_headers. Caller is
 *                         responsible for picking a compatible shape.
 *
 *   model_mapping: { "claude-sonnet-4-7": "claude-3-5-sonnet-20241022" }
 *     applied to req.body.model before forwarding.
 *
 *   custom_headers: arbitrary header map merged after Authorization /
 *     Content-Type / User-Agent so the channel owner can override them.
 *
 * Multi-tenant note: pass `channel` to override the env-driven defaults
 * with a per-tenant upstream_channel row. Single-tenant deploys can
 * keep using config.upstreamBaseUrl + config.upstreamKey.
 */
import { config } from '../config';
import { logger } from './logger';
import {
  anthropicReqToOpenAI,
  openaiRespToAnthropic,
  transcodeOpenAIStream,
  parseOpenAISseLines,
  encodeAnthropicEvent,
  type AnthropicMessageRequest,
} from './openai-adapter';
import {
  anthropicReqToGemini,
  geminiToAnthropic,
  transcodeGeminiStream,
  parseGeminiSseLines,
  buildGeminiUrl,
  GEMINI_DEFAULT_BASE_URL,
} from './provider-gemini';
import { DEEPSEEK_DEFAULT_BASE_URL } from './provider-deepseek';
import { MOONSHOT_DEFAULT_BASE_URL } from './provider-moonshot';
import { QWEN_DEFAULT_BASE_URL } from './provider-qwen';
import { MINIMAX_DEFAULT_BASE_URL } from './provider-minimax';

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'moonshot'
  | 'deepseek'
  | 'minimax'
  | 'qwen'
  | 'llmapi-wholesale'
  | 'custom';

export interface UpstreamChannel {
  id?: number;
  base_url: string;
  api_key: string;
  /** v0.3 — protocol selector. Defaults to 'anthropic' if absent. */
  provider_type?: ProviderType | string;
  /** v0.3 — { from: to } applied to req.body.model. */
  model_mapping?: Record<string, string> | null;
  /** v0.3 — extra request headers merged after our defaults. */
  custom_headers?: Record<string, string> | null;
}

export interface UpstreamRequest {
  path: string;
  body: any;
  apiKey?: string;
  channel?: UpstreamChannel;
}

interface ResolvedTarget {
  baseUrl: string;
  apiKey: string;
  providerType: ProviderType;
  modelMapping: Record<string, string>;
  customHeaders: Record<string, string>;
}

function normaliseProvider(p: string | undefined | null): ProviderType {
  switch ((p || 'anthropic').toLowerCase()) {
    case 'anthropic':
    case 'openai':
    case 'gemini':
    case 'moonshot':
    case 'deepseek':
    case 'minimax':
    case 'qwen':
    case 'llmapi-wholesale':
    case 'custom':
      return (p as ProviderType);
    default:
      return 'anthropic';
  }
}

function asStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * Per-provider default base_url. When the channel has an explicit
 * base_url we keep it; otherwise we fall back to the provider's public
 * endpoint so a newly-created channel doesn't 404 against the empty default.
 */
function providerDefaultBase(p: ProviderType): string | null {
  switch (p) {
    case 'deepseek': return DEEPSEEK_DEFAULT_BASE_URL;
    case 'moonshot': return MOONSHOT_DEFAULT_BASE_URL;
    case 'qwen':     return QWEN_DEFAULT_BASE_URL;
    case 'minimax':  return MINIMAX_DEFAULT_BASE_URL;
    case 'gemini':   return GEMINI_DEFAULT_BASE_URL;
    default:         return null;
  }
}

function resolveTarget(req: UpstreamRequest): ResolvedTarget {
  if (req.channel) {
    const pt = normaliseProvider(req.channel.provider_type as string);
    const baseUrl = req.channel.base_url && req.channel.base_url.length > 0
      ? req.channel.base_url
      : (providerDefaultBase(pt) ?? '');
    return {
      baseUrl,
      apiKey: req.channel.api_key,
      providerType: pt,
      modelMapping: asStringMap(req.channel.model_mapping),
      customHeaders: asStringMap(req.channel.custom_headers),
    };
  }
  return {
    baseUrl: config.upstreamBaseUrl,
    apiKey: req.apiKey || config.upstreamKey,
    providerType: 'anthropic',
    modelMapping: {},
    customHeaders: {},
  };
}

function applyModelMapping(body: any, map: Record<string, string>): any {
  if (!body || typeof body !== 'object' || !body.model) return body;
  const mapped = map[body.model];
  if (mapped && mapped !== body.model) return { ...body, model: mapped };
  return body;
}

/**
 * Header merge: our defaults first, then channel.custom_headers override.
 * Custom_headers can clobber Authorization on purpose (e.g. OpenAI behind
 * a corporate gateway that wants `api-key` instead of Bearer).
 */
function buildHeaders(
  apiKey: string,
  customHeaders: Record<string, string>,
  accept: 'application/json' | 'text/event-stream',
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': '3api-relay-panel/0.4.0',
    ...customHeaders,
  };
}

export interface UpstreamJsonResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

// =========================================================================
// Transport — JSON
// =========================================================================

export async function callUpstream(req: UpstreamRequest): Promise<UpstreamJsonResponse> {
  const t = resolveTarget(req);
  if (!t.apiKey && t.providerType !== 'custom') {
    throw new Error('upstream not configured: no api_key on channel and no UPSTREAM_KEY env');
  }
  const body = applyModelMapping(req.body, t.modelMapping);

  switch (t.providerType) {
    case 'anthropic':
    case 'llmapi-wholesale':
      return callJsonRaw(t, req.path, body);
    case 'openai':
    case 'deepseek':
    case 'moonshot':
    case 'qwen':
    case 'minimax':
      return callOpenAiJson(t, body);
    case 'gemini':
      return callGeminiJson(t, body);
    case 'custom':
      return callJsonRaw(t, req.path, body);
    default:
      return callJsonRaw(t, req.path, body);
  }
}

async function callJsonRaw(t: ResolvedTarget, path: string, body: any): Promise<UpstreamJsonResponse> {
  const url = `${t.baseUrl.replace(/\/$/, '')}${path}`;
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(t.apiKey, t.customHeaders, 'application/json'),
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url, provider: t.providerType }, 'upstream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }

  const elapsed = Date.now() - start;
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  logger.info({ url, status: res.status, elapsed, mode: 'json', provider: t.providerType }, 'upstream:response');
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: parsed,
  };
}

async function callOpenAiJson(t: ResolvedTarget, body: any): Promise<UpstreamJsonResponse> {
  const oaiBody = anthropicReqToOpenAI(body as AnthropicMessageRequest);
  oaiBody.stream = false;
  const url = `${t.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(t.apiKey, t.customHeaders, 'application/json'),
      body: JSON.stringify(oaiBody),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url, provider: t.providerType }, 'upstream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }

  const elapsed = Date.now() - start;
  const text = await res.text();
  let oai: any;
  try { oai = JSON.parse(text); } catch { oai = { raw: text }; }
  logger.info({ url, status: res.status, elapsed, mode: 'json', provider: t.providerType }, 'upstream:response');

  if (res.status >= 200 && res.status < 300 && oai?.choices) {
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: openaiRespToAnthropic(oai, body?.model ?? ''),
    };
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: oai,
  };
}

async function callGeminiJson(t: ResolvedTarget, body: any): Promise<UpstreamJsonResponse> {
  const model = body?.model || 'gemini-2.5-pro';
  const url = buildGeminiUrl(t.baseUrl, model, t.apiKey, false);
  const gemBody = anthropicReqToGemini(body as AnthropicMessageRequest);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': '3api-relay-panel/0.4.0',
        ...t.customHeaders,
      },
      body: JSON.stringify(gemBody),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url, provider: 'gemini' }, 'upstream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }
  const elapsed = Date.now() - start;
  const text = await res.text();
  let gem: any;
  try { gem = JSON.parse(text); } catch { gem = { raw: text }; }
  logger.info({ url, status: res.status, elapsed, mode: 'json', provider: 'gemini' }, 'upstream:response');

  if (res.status >= 200 && res.status < 300 && gem?.candidates) {
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: geminiToAnthropic(gem, model),
    };
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: gem,
  };
}

// =========================================================================
// Transport — SSE
// =========================================================================

/**
 * SSE streaming proxy. Returns a Response whose body is Anthropic-shaped
 * SSE; the relay pipes the body straight to the client. For non-anthropic
 * upstreams we synthesise the SSE locally by streaming through the
 * appropriate provider adapter.
 */
export async function callUpstreamStream(req: UpstreamRequest): Promise<Response> {
  const t = resolveTarget(req);
  if (!t.apiKey && t.providerType !== 'custom') {
    throw new Error('upstream not configured: no api_key on channel and no UPSTREAM_KEY env');
  }
  const body = applyModelMapping(req.body, t.modelMapping);

  // Native Anthropic-shaped passthrough.
  if (t.providerType === 'anthropic' || t.providerType === 'llmapi-wholesale' || t.providerType === 'custom') {
    const url = `${t.baseUrl.replace(/\/$/, '')}${req.path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(t.apiKey, t.customHeaders, 'text/event-stream'),
      body: JSON.stringify({ ...body, stream: true }),
    });
    logger.info({ url, status: res.status, mode: 'stream', provider: t.providerType }, 'upstream:response');
    return res;
  }

  // OpenAI-compatible — DeepSeek / Moonshot / Qwen / MiniMax / openai.
  if (t.providerType === 'openai' || t.providerType === 'deepseek' ||
      t.providerType === 'moonshot' || t.providerType === 'qwen' ||
      t.providerType === 'minimax') {
    return callOpenAiStream(t, body);
  }

  if (t.providerType === 'gemini') {
    return callGeminiStream(t, body);
  }

  // Fallback — should not hit.
  return new Response(JSON.stringify({
    error: { type: 'not_implemented', message: `provider_type '${t.providerType}' streaming not supported` },
  }), { status: 501, headers: new Headers({ 'Content-Type': 'application/json' }) });
}

async function callOpenAiStream(t: ResolvedTarget, body: any): Promise<Response> {
  const oaiBody = anthropicReqToOpenAI(body as AnthropicMessageRequest);
  oaiBody.stream = true;
  const url = `${t.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(t.apiKey, t.customHeaders, 'text/event-stream'),
      body: JSON.stringify(oaiBody),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url, provider: t.providerType }, 'upstream:stream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }
  logger.info({ url, status: upstream.status, mode: 'stream', provider: t.providerType }, 'upstream:response');

  if (upstream.status < 200 || upstream.status >= 300) {
    // Pass the error JSON through unchanged so the relay records it.
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
  }

  const fallbackModel = body?.model ?? '';
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const ev of transcodeOpenAIStream(parseOpenAISseLines(upstream.body), fallbackModel)) {
          controller.enqueue(enc.encode(encodeAnthropicEvent(ev)));
        }
        controller.close();
      } catch (err: any) {
        logger.error({ err: err?.message ?? String(err), provider: t.providerType }, 'openai-sse:transcode_error');
        try {
          controller.enqueue(enc.encode(encodeAnthropicEvent({
            type: 'error',
            error: { type: 'overloaded_error', message: 'upstream stream transcode error' },
          })));
        } catch { /* noop */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }),
  });
}

async function callGeminiStream(t: ResolvedTarget, body: any): Promise<Response> {
  const model = body?.model || 'gemini-2.5-pro';
  const url = buildGeminiUrl(t.baseUrl, model, t.apiKey, true);
  const gemBody = anthropicReqToGemini(body as AnthropicMessageRequest);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': '3api-relay-panel/0.4.0',
        ...t.customHeaders,
      },
      body: JSON.stringify(gemBody),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url, provider: 'gemini' }, 'upstream:stream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }
  logger.info({ url, status: upstream.status, mode: 'stream', provider: 'gemini' }, 'upstream:response');

  if (upstream.status < 200 || upstream.status >= 300) {
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const ev of transcodeGeminiStream(parseGeminiSseLines(upstream.body), model)) {
          controller.enqueue(enc.encode(encodeAnthropicEvent(ev)));
        }
        controller.close();
      } catch (err: any) {
        logger.error({ err: err?.message ?? String(err), provider: 'gemini' }, 'gemini-sse:transcode_error');
        try {
          controller.enqueue(enc.encode(encodeAnthropicEvent({
            type: 'error',
            error: { type: 'overloaded_error', message: 'upstream gemini stream transcode error' },
          })));
        } catch { /* noop */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }),
  });
}

/**
 * Parse usage from a complete SSE buffer. Looks for:
 *   - event: message_start  → data.message.usage.input_tokens
 *   - event: message_delta  → data.usage.output_tokens (final count)
 */
export function extractUsageFromSse(buffer: string): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (!json || json === '[DONE]') continue;
    try {
      const obj = JSON.parse(json);
      if (obj?.message?.usage?.input_tokens != null) {
        input = Number(obj.message.usage.input_tokens) || input;
      }
      if (obj?.usage?.input_tokens != null) {
        input = Number(obj.usage.input_tokens) || input;
      }
      if (obj?.usage?.output_tokens != null) {
        output = Number(obj.usage.output_tokens) || output;
      }
    } catch {
      // Skip non-JSON / partial frames
    }
  }
  return { input, output };
}
