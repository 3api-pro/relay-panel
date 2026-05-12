/**
 * Qwen (Aliyun DashScope) — OpenAI-compatible mode.
 *
 *   POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *   Authorization: Bearer <api_key>
 *
 * Models: qwen-plus, qwen-max, qwen-turbo, qwen-long, qwen2.5-*, qwen3-*.
 *
 * Quirks: DashScope also exposes a native generation API at /v1/services/...,
 * but the compatible-mode endpoint accepts the OpenAI shape verbatim. We
 * stick to compatible-mode for parity with the openai-adapter.
 */
export const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export function getDefaultBaseUrl(): string {
  return QWEN_DEFAULT_BASE_URL;
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
