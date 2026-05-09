/**
 * Upstream HTTP client. Two modes:
 *  - JSON (non-streaming): callUpstream({ stream: false })
 *  - SSE (streaming):      callUpstreamStream(...) — yields chunks
 *
 * Multi-tenant note: pass `channel` to override the env-driven defaults
 * with a per-tenant upstream_channel row. Single-tenant deploys can
 * keep using config.upstreamBaseUrl + config.upstreamKey.
 */
import { config } from '../config';
import { logger } from './logger';

export interface UpstreamChannel {
  id?: number;
  base_url: string;
  api_key: string;
}

export interface UpstreamRequest {
  path: string;
  body: any;
  apiKey?: string;
  channel?: UpstreamChannel;
}

function resolveTarget(req: UpstreamRequest): { baseUrl: string; apiKey: string } {
  if (req.channel) {
    return { baseUrl: req.channel.base_url, apiKey: req.channel.api_key };
  }
  return {
    baseUrl: config.upstreamBaseUrl,
    apiKey: req.apiKey || config.upstreamKey,
  };
}

export interface UpstreamJsonResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export async function callUpstream(req: UpstreamRequest): Promise<UpstreamJsonResponse> {
  const { baseUrl, apiKey } = resolveTarget(req);
  const url = `${baseUrl.replace(/\/$/, '')}${req.path}`;
  if (!apiKey) throw new Error('upstream not configured: no api_key on channel and no UPSTREAM_KEY env');

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': '3api-relay-panel/0.1.0',
      },
      body: JSON.stringify(req.body),
    });
  } catch (err: any) {
    logger.error({ err: err.message, url }, 'upstream:network_error');
    throw new Error(`upstream network error: ${err.message}`);
  }

  const elapsed = Date.now() - start;
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  logger.info({ url, status: res.status, elapsed, mode: 'json' }, 'upstream:response');
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
  };
}

/**
 * SSE streaming proxy. Returns the upstream Response so caller can pipe
 * res.body to client. Caller is responsible for closing the connection.
 *
 * Returns: { upstreamRes, parseUsage(buffer): {input,output} }
 */
export async function callUpstreamStream(req: UpstreamRequest): Promise<Response> {
  const { baseUrl, apiKey } = resolveTarget(req);
  const url = `${baseUrl.replace(/\/$/, '')}${req.path}`;
  if (!apiKey) throw new Error('upstream not configured: no api_key on channel and no UPSTREAM_KEY env');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': '3api-relay-panel/0.1.0',
    },
    body: JSON.stringify({ ...req.body, stream: true }),
  });

  logger.info({ url, status: res.status, mode: 'stream' }, 'upstream:response');
  return res;
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
