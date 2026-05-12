/**
 * Google Gemini — native v1beta REST.
 *
 *   POST {base}/v1beta/models/{model}:generateContent?key={api_key}
 *   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}
 *
 * API key travels in the query string (not Header). Body shape:
 *
 *   {
 *     contents: [{ role: 'user' | 'model', parts: [{ text?, inline_data? }] }],
 *     systemInstruction: { parts: [{ text }] },
 *     generationConfig: { maxOutputTokens, temperature, topP, topK, stopSequences },
 *     tools: [{ functionDeclarations: [{ name, description, parameters }] }],
 *     toolConfig: { functionCallingConfig: { mode } },
 *     safetySettings: [...],
 *   }
 *
 * Response shape:
 *
 *   {
 *     candidates: [{
 *       content: { role: 'model', parts: [{ text?, functionCall? }] },
 *       finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER',
 *     }],
 *     usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount },
 *   }
 *
 * Streaming SSE: same JSON envelopes, line-delimited "data: {...}".
 *
 * We translate Anthropic Messages ↔ Gemini independently of the OpenAI
 * adapter — different protocol, different mapping.
 */
import { logger } from './logger';
import type {
  AnthropicMessageRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicEvent,
} from './openai-adapter';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

export function getDefaultBaseUrl(): string {
  return GEMINI_DEFAULT_BASE_URL;
}

/**
 * Gemini auth is via ?key=. We still allow a Header for clarity but it's
 * ignored upstream. Keep empty so we don't accidentally leak the key.
 */
export function getDefaultHeaders(_apiKey: string): Record<string, string> {
  return {};
}

export async function healthCheck(baseUrl: string, apiKey: string, timeoutMs = 5000): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, latency_ms: Date.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - t0, error: err?.message ?? String(err) };
  }
}

// =========================================================================
// Request: Anthropic → Gemini
// =========================================================================

function partsFromAnthropicContent(content: AnthropicMessage['content']): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch ((b as AnthropicContentBlock).type) {
      case 'text':
        parts.push({ text: (b as any).text ?? '' });
        break;
      case 'image': {
        const src = (b as any).source;
        if (src?.type === 'base64' && src.data) {
          parts.push({
            inline_data: {
              mime_type: src.media_type || 'image/png',
              data: src.data,
            },
          });
        }
        break;
      }
      case 'tool_use':
        parts.push({
          functionCall: {
            name: (b as any).name,
            args: (b as any).input ?? {},
          },
        });
        break;
      case 'tool_result':
        parts.push({
          functionResponse: {
            name: 'tool',
            response: { result: (b as any).content },
          },
        });
        break;
      default:
        // skip
    }
  }
  return parts;
}

function flattenSystem(system: AnthropicMessageRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b?.text ?? '')).filter(Boolean).join('\n');
  }
  return '';
}

export function anthropicReqToGemini(body: AnthropicMessageRequest): any {
  const contents: any[] = [];
  for (const m of body.messages ?? []) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: partsFromAnthropicContent(m.content),
    });
  }

  const out: any = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 1024,
    },
  };
  const sys = flattenSystem(body.system);
  if (sys) {
    out.systemInstruction = { parts: [{ text: sys }] };
  }
  if (body.temperature != null) out.generationConfig.temperature = body.temperature;
  if (body.top_p != null) out.generationConfig.topP = body.top_p;
  if (body.top_k != null) out.generationConfig.topK = body.top_k;
  if (body.stop_sequences && body.stop_sequences.length > 0) {
    out.generationConfig.stopSequences = body.stop_sequences;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = [{
      functionDeclarations: body.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      })),
    }];
    if (body.tool_choice) {
      const tc = body.tool_choice;
      const mode = tc?.type === 'auto' ? 'AUTO'
                 : tc?.type === 'any'  ? 'ANY'
                 : tc?.type === 'tool' ? 'ANY'
                 : tc?.type === 'none' ? 'NONE'
                 : 'AUTO';
      out.toolConfig = { functionCallingConfig: { mode } };
    }
  }

  return out;
}

function mapGeminiFinish(reason: string | null | undefined): string {
  switch (reason) {
    case 'MAX_TOKENS': return 'max_tokens';
    case 'STOP':       return 'end_turn';
    case 'SAFETY':
    case 'RECITATION': return 'end_turn';
    default:           return 'end_turn';
  }
}

// =========================================================================
// Response: Gemini → Anthropic (non-stream)
// =========================================================================

export function geminiToAnthropic(resp: any, fallbackModel: string): any {
  const cand = resp?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const content: any[] = [];
  let hasTool = false;
  for (const p of parts) {
    if (p?.text != null && p.text !== '') {
      content.push({ type: 'text', text: String(p.text) });
    } else if (p?.functionCall) {
      hasTool = true;
      content.push({
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: p.functionCall.name || 'unknown',
        input: p.functionCall.args ?? {},
      });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const um = resp?.usageMetadata ?? {};
  return {
    id: `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content,
    stop_reason: hasTool && cand?.finishReason !== 'MAX_TOKENS'
      ? 'tool_use'
      : mapGeminiFinish(cand?.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens:  Number(um.promptTokenCount ?? 0),
      output_tokens: Number(um.candidatesTokenCount ?? 0),
    },
  };
}

// =========================================================================
// SSE parsing — Gemini streamGenerateContent (alt=sse) emits "data: {...}"
// =========================================================================

export async function* parseGeminiSseLines(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<any> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!raw || !raw.startsWith('data:')) continue;
        const payload = raw.slice(5).trim();
        if (!payload) continue;
        try { yield JSON.parse(payload); }
        catch (e: any) { logger.debug({ raw: payload.slice(0, 80) }, 'gemini-sse:parse_skip'); }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

/**
 * Transcode Gemini SSE → Anthropic SSE events.
 *
 * Gemini emits the full candidates array each tick with the running parts;
 * we diff against what we've already emitted to avoid double-emitting text.
 */
export async function* transcodeGeminiStream(
  chunks: AsyncIterable<any>,
  fallbackModel: string,
): AsyncGenerator<AnthropicEvent> {
  const messageId = `msg_${Date.now().toString(36)}`;
  let messageStartSent = false;

  let textIdx = -1;
  let textOpen = false;
  let textEmitted = '';     // cumulative text we've already pushed
  let nextBlockIdx = 0;

  const toolStarted = new Map<number, { blockIdx: number; argsEmitted: string }>();

  let lastFinish: string | null = null;
  let usage = { promptTokenCount: 0, candidatesTokenCount: 0 };

  for await (const chunk of chunks) {
    if (!messageStartSent) {
      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: fallbackModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      messageStartSent = true;
    }

    if (chunk?.usageMetadata) {
      usage = {
        promptTokenCount: Number(chunk.usageMetadata.promptTokenCount ?? usage.promptTokenCount),
        candidatesTokenCount: Number(chunk.usageMetadata.candidatesTokenCount ?? usage.candidatesTokenCount),
      };
    }

    const cand = chunk?.candidates?.[0];
    if (!cand) continue;

    const parts: any[] = cand.content?.parts ?? [];
    let toolPartIdx = 0;
    for (const p of parts) {
      if (p?.text != null && p.text !== '') {
        // Gemini streams sometimes resend the full text; only emit the suffix.
        const full = String(p.text);
        let delta = full;
        if (full.startsWith(textEmitted)) {
          delta = full.slice(textEmitted.length);
        } else {
          // upstream reset its running buffer — accept as-is.
          delta = full;
          textEmitted = '';
        }
        if (delta.length > 0) {
          if (!textOpen) {
            textIdx = nextBlockIdx++;
            textOpen = true;
            yield {
              type: 'content_block_start',
              index: textIdx,
              content_block: { type: 'text', text: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index: textIdx,
            delta: { type: 'text_delta', text: delta },
          };
          textEmitted += delta;
        }
      } else if (p?.functionCall) {
        if (textOpen) {
          yield { type: 'content_block_stop', index: textIdx };
          textOpen = false;
        }
        if (!toolStarted.has(toolPartIdx)) {
          const blockIdx = nextBlockIdx++;
          toolStarted.set(toolPartIdx, { blockIdx, argsEmitted: '' });
          yield {
            type: 'content_block_start',
            index: blockIdx,
            content_block: {
              type: 'tool_use',
              id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
              name: p.functionCall.name || 'unknown',
              input: {},
            },
          };
        }
        const entry = toolStarted.get(toolPartIdx)!;
        const args = JSON.stringify(p.functionCall.args ?? {});
        if (args !== entry.argsEmitted) {
          // Emit full args as one input_json_delta (gemini gives complete obj).
          yield {
            type: 'content_block_delta',
            index: entry.blockIdx,
            delta: { type: 'input_json_delta', partial_json: args },
          };
          entry.argsEmitted = args;
        }
        toolPartIdx++;
      }
    }

    if (cand.finishReason) lastFinish = cand.finishReason;
  }

  if (textOpen) yield { type: 'content_block_stop', index: textIdx };
  for (const e of toolStarted.values()) {
    yield { type: 'content_block_stop', index: e.blockIdx };
  }

  const stopReason = toolStarted.size > 0 && lastFinish !== 'MAX_TOKENS'
    ? 'tool_use'
    : mapGeminiFinish(lastFinish);

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens:  Number(usage.promptTokenCount ?? 0),
      output_tokens: Number(usage.candidatesTokenCount ?? 0),
    },
  };
  yield { type: 'message_stop' };
}

/**
 * Pick the Gemini URL for a given mode.
 *   stream=false → /v1beta/models/{model}:generateContent?key=...
 *   stream=true  → /v1beta/models/{model}:streamGenerateContent?alt=sse&key=...
 */
export function buildGeminiUrl(baseUrl: string, model: string, apiKey: string, stream: boolean): string {
  const root = baseUrl.replace(/\/$/, '');
  const op = stream ? 'streamGenerateContent' : 'generateContent';
  const q = stream ? `?alt=sse&key=${encodeURIComponent(apiKey)}` : `?key=${encodeURIComponent(apiKey)}`;
  return `${root}/v1beta/models/${encodeURIComponent(model)}:${op}${q}`;
}
