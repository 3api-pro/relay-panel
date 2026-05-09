/**
 * Upstream HTTP client. Calls the configured wholesale upstream
 * (default api.llmapi.pro/wholesale/v1) with the panel's UPSTREAM_KEY
 * (a wsk-* token). End-customer's sk-* key is NEVER forwarded — only
 * the panel-level wholesale key is used at the upstream boundary.
 */
import { config } from '../config';
import { logger } from './logger';

export interface UpstreamRequest {
  path: string;
  body: any;
  // We may inject a specific upstream API key from a channel later;
  // for now use the global UPSTREAM_KEY from .env.
  apiKey?: string;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export async function callUpstream(req: UpstreamRequest): Promise<UpstreamResponse> {
  const url = `${config.upstreamBaseUrl.replace(/\/$/, '')}${req.path}`;
  const apiKey = req.apiKey || config.upstreamKey;
  if (!apiKey) {
    throw new Error('UPSTREAM_KEY not configured');
  }

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
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  logger.info({ url, status: res.status, elapsed }, 'upstream:response');

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
  };
}
