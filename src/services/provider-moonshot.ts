/**
 * Moonshot / Kimi — OpenAI-compatible chat-completions.
 *
 *   POST https://api.moonshot.cn/v1/chat/completions  (CN)
 *   POST https://api.moonshot.ai/v1/chat/completions  (international)
 *   Authorization: Bearer <api_key>
 *
 * Models: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, kimi-k2-*.
 *
 * Quirks: tool calls follow OpenAI spec. Default to .cn — international
 * deployments override via channel.base_url.
 */
export const MOONSHOT_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';

export function getDefaultBaseUrl(): string {
  return MOONSHOT_DEFAULT_BASE_URL;
}

export function getDefaultHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function healthCheck(baseUrl: string, apiKey: string, timeoutMs = 5000): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, latency_ms: Date.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - t0, error: err?.message ?? String(err) };
  }
}
