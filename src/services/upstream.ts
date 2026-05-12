/**
 * Upstream HTTP client.
 *
 * Two transport modes:
 *  - JSON (non-streaming): callUpstream({ stream: false })
 *  - SSE (streaming):      callUpstreamStream(...) — yields chunks
 *
 * v0.3 — multi-protocol routing.
 *   Anthropic-shaped /v1/messages is our wire format. provider_type on the
 *   channel selects how we talk to the upstream:
 *     anthropic         → POST {base}/messages, body as-is (default).
 *     llmapi-wholesale  → same as anthropic; route through llmapi.pro.
 *     openai            → POST {base}/chat/completions, adapt body + response.
 *                         Non-stream only in v0.3; streaming returns 501.
 *     gemini / moonshot / deepseek / minimax / qwen
 *                       → not yet implemented (v0.4); responds with a
 *                         clean 501 so the panel doesn't crash and the
 *                         admin gets a useful error.
 *     custom            → passthrough — sends the body as-is to the
 *                         configured base_url + custom_headers. Caller is
 *                         responsible for picking a compatible shape.
 *
 *   model_mapping: { "claude-sonnet-4-7": "claude-3-5-sonnet-20241022" }
 *     applied to req.body.model before forwarding.
 *
 *   custom_headers: arbitrary header map merged after Authorization /
 *     Content-Type / User-Agent so the channel owner can override them
 *     (e.g. for x-api-key auth or anthropic-beta toggles).
 *
 * Multi-tenant note: pass `channel` to override the env-driven defaults
 * with a per-tenant upstream_channel row. Single-tenant deploys can
 * keep using config.upstreamBaseUrl + config.upstreamKey.
 */
import { config } from '../config';
import { logger } from './logger';

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

function resolveTarget(req: UpstreamRequest): ResolvedTarget {
  if (req.channel) {
    return {
      baseUrl: req.channel.base_url,
      apiKey: req.channel.api_key,
      providerType: normaliseProvider(req.channel.provider_type as string),
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
    'User-Agent': '3api-relay-panel/0.3.0',
    ...customHeaders,
  };
}

export interface UpstreamJsonResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

// =========================================================================
// Adapters — Anthropic ⇄ OpenAI
// =========================================================================

/**
 * Flatten Anthropic `content` (string or list of {type,text}) to a plain
 * OpenAI-style string. Tool / image blocks are dropped with a stub note
 * since the OpenAI chat-completions response shape can't carry them.
 */
function anthropicContentToOpenAi(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return String(b.text ?? '');
      if (b?.type === 'image') return '[image]';
      if (b?.type === 'tool_use') return `[tool_use:${b.name}]`;
      if (b?.type === 'tool_result') return `[tool_result]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function anthropicToOpenaiRequest(body: any): any {
  const messages: any[] = [];
  if (typeof body?.system === 'string' && body.system.length > 0) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body?.system)) {
    const sys = body.system.map((b: any) => (b?.text ?? '')).filter(Boolean).join('\n');
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of body?.messages ?? []) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: anthropicContentToOpenAi(m.content),
    });
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: false, // v0.3 — non-stream only for openai adapter
  };
}

function openaiToAnthropicResponse(oai: any): any {
  const choice = oai?.choices?.[0];
  const text = choice?.message?.content ?? '';
  return {
    id: oai?.id ?? `msg_oai_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: oai?.model ?? '',
    content: [{ type: 'text', text: String(text) }],
    stop_reason:
      choice?.finish_reason === 'length' ? 'max_tokens' :
      choice?.finish_reason === 'stop' ? 'end_turn' :
      'end_turn',
    usage: {
      input_tokens: Number(oai?.usage?.prompt_tokens ?? 0),
      output_tokens: Number(oai?.usage?.completion_tokens ?? 0),
    },
  };
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
      return callOpenAiJson(t, body);
    case 'custom':
      return callJsonRaw(t, req.path, body);
    case 'gemini':
    case 'moonshot':
    case 'deepseek':
    case 'minimax':
    case 'qwen':
      return {
        status: 501,
        headers: {},
        body: {
          error: {
            type: 'not_implemented',
            message: `provider_type '${t.providerType}' is configured on this channel but the protocol adapter ships in v0.4. Use 'anthropic' / 'llmapi-wholesale' / 'openai' for now.`,
          },
        },
      };
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
  const oaiBody = anthropicToOpenaiRequest(body);
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
    logger.error({ err: err.message, url, provider: 'openai' }, 'upstream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }

  const elapsed = Date.now() - start;
  const text = await res.text();
  let oai: any;
  try { oai = JSON.parse(text); } catch { oai = { raw: text }; }
  logger.info({ url, status: res.status, elapsed, mode: 'json', provider: 'openai' }, 'upstream:response');

  if (res.status >= 200 && res.status < 300 && oai?.choices) {
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: openaiToAnthropicResponse(oai),
    };
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: oai,
  };
}

// =========================================================================
// Transport — SSE
// =========================================================================

/**
 * SSE streaming proxy. Returns the upstream Response so caller can pipe
 * res.body to client. Caller is responsible for closing the connection.
 *
 * Streaming is only fully implemented for anthropic / llmapi-wholesale /
 * custom (which assumes wire-compatible). openai streaming would require
 * transcoding `delta.content` → `content_block_delta` on the fly; we
 * synthesise a fake SSE message_start/stop pair using the JSON adapter
 * so the storefront stays functional but degraded. Other providers
 * return a 501 SSE error event so the client gets a clean error.
 */
export async function callUpstreamStream(req: UpstreamRequest): Promise<Response> {
  const t = resolveTarget(req);
  if (!t.apiKey && t.providerType !== 'custom') {
    throw new Error('upstream not configured: no api_key on channel and no UPSTREAM_KEY env');
  }
  const body = applyModelMapping(req.body, t.modelMapping);

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

  if (t.providerType === 'openai') {
    // Degraded path: run non-stream OpenAI call, wrap response as Anthropic-SSE.
    const jsonRes = await callOpenAiJson(t, body);
    const headers = new Headers({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (jsonRes.status < 200 || jsonRes.status >= 300) {
      const errBody = JSON.stringify(jsonRes.body);
      return new Response(errBody, { status: jsonRes.status, headers });
    }
    const ant = jsonRes.body;
    const text = ant?.content?.[0]?.text ?? '';
    const sse =
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: ant })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: ant.stop_reason }, usage: ant.usage })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    return new Response(sse, { status: 200, headers });
  }

  // Stub providers — synthesise a 501 JSON error so caller propagates.
  const errPayload = JSON.stringify({
    error: {
      type: 'not_implemented',
      message: `provider_type '${t.providerType}' streaming ships in v0.4.`,
    },
  });
  return new Response(errPayload, {
    status: 501,
    headers: new Headers({ 'Content-Type': 'application/json' }),
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
