/**
 * DeepSeek — OpenAI-compatible chat-completions.
 *
 *   POST https://api.deepseek.com/v1/chat/completions
 *   Authorization: Bearer <api_key>
 *
 * Models: deepseek-chat (V3), deepseek-reasoner (R1).
 *
 * Quirks: none — drop-in OpenAI shape. Streaming SSE is identical.
 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export function getDefaultBaseUrl(): string {
  return DEEPSEEK_DEFAULT_BASE_URL;
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
