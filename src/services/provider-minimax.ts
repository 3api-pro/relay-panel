/**
 * MiniMax — OpenAI-compatible chatcompletion-v2 mode.
 *
 *   POST https://api.minimax.chat/v1/chat/completions  (chatcompletion-v2)
 *   Authorization: Bearer <api_key>
 *
 * Models: MiniMax-M2 (codename: minimax-m2), abab6.5s-chat, etc.
 *
 * Quirks: MiniMax also exposes a proprietary `/v1/text/chatcompletion_v2`
 * with a different schema (sender_type / messages / bot_setting). We use the
 * OpenAI-compat /v1/chat/completions because it works with our adapter
 * unchanged. SSE deltas are line-delimited "data: {...}" identical to OAI.
 */
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.chat/v1';

export function getDefaultBaseUrl(): string {
  return MINIMAX_DEFAULT_BASE_URL;
}

export function getDefaultHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function healthCheck(baseUrl: string, apiKey: string, timeoutMs = 5000): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  // MiniMax doesn't always expose /models — use a 1-token chat probe instead.
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'minimax-m2',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, latency_ms: Date.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - t0, error: err?.message ?? String(err) };
  }
}
