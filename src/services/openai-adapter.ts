/**
 * Anthropic ↔ OpenAI bidirectional protocol adapter.
 *
 * Wire format inside 3api is Anthropic Messages v1. When the upstream is an
 * OpenAI chat-completions endpoint (DeepSeek, Moonshot, Qwen DashScope,
 * MiniMax chatcompletion-v2 — all OpenAI-compatible) we:
 *
 *   1. Translate the inbound Anthropic request body → OpenAI chat-completions
 *      body (`anthropicReqToOpenAI`). Tools, system, content arrays, stop
 *      sequences, sampling params all map.
 *
 *   2. Stream-mode: pipe the upstream SSE through `transcodeOpenAIStream`
 *      which yields Anthropic-shaped SSE events (`message_start` →
 *      `content_block_*` → `message_delta` → `message_stop`). Tool calls are
 *      accumulated across deltas and emitted as `content_block` of
 *      type=`tool_use` once the index closes.
 *
 *   3. Non-stream-mode: shape the JSON response back with
 *      `openaiRespToAnthropic` (carries text + tool_use blocks + usage).
 *
 * Design notes:
 *
 *   * Anthropic `system` is a top-level field; OpenAI puts it as the first
 *     `messages[]` element with role=system. We collapse multi-block system
 *     arrays to a single string (text only).
 *
 *   * Anthropic `content` may be a string OR an array of blocks
 *     ({type:text}, {type:image}, {type:tool_use}, {type:tool_result}). We
 *     emit OpenAI multi-modal content arrays when there's an image block
 *     present (matches OpenAI Vision v1 schema); otherwise we flatten to a
 *     plain string for maximum compat with non-vision OpenAI clones.
 *
 *   * `tool_use` blocks (assistant said "call tool X") become OpenAI
 *     `assistant.tool_calls[]`. `tool_result` blocks (user fed tool output
 *     back) become OpenAI messages of role=tool with `tool_call_id`.
 *
 *   * Streaming finish_reason maps:
 *       stop / null     → end_turn
 *       length          → max_tokens
 *       tool_calls      → tool_use
 *       content_filter  → end_turn (anthropic has no direct equivalent)
 *
 *   * Usage:
 *       prompt_tokens     → input_tokens
 *       completion_tokens → output_tokens
 *
 * This module is provider-agnostic — it talks the OpenAI dialect, period.
 * Provider-specific quirks (base_url, auth header style, model defaults)
 * belong in `provider-*.ts`.
 */
import { logger } from './logger';

// =========================================================================
// Types
// =========================================================================

export interface AnthropicTextBlock { type: 'text'; text: string }
export interface AnthropicImageBlock { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }
export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: any }
export interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean }
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: any;
}

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: any;
  metadata?: any;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[] | null;
  name?: string;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
}

export interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OAIToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// Anthropic SSE event shapes (loose — JSON.stringified to wire).
export type AnthropicEvent =
  | { type: 'message_start'; message: any }
  | { type: 'content_block_start'; index: number; content_block: any }
  | { type: 'content_block_delta'; index: number; delta: any }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: any; usage?: any }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

// =========================================================================
// Request: Anthropic → OpenAI
// =========================================================================

function flattenSystem(system: AnthropicMessageRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b?.text ?? '')).filter(Boolean).join('\n');
  }
  return '';
}

function anthropicContentToOpenAIContent(content: AnthropicMessage['content']): {
  text: string;
  multipart: any[] | null;
  toolUses: AnthropicToolUseBlock[];
  toolResults: AnthropicToolResultBlock[];
} {
  if (typeof content === 'string') {
    return { text: content, multipart: null, toolUses: [], toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', multipart: null, toolUses: [], toolResults: [] };
  }
  const parts: any[] = [];
  const texts: string[] = [];
  const toolUses: AnthropicToolUseBlock[] = [];
  const toolResults: AnthropicToolResultBlock[] = [];
  let hasImage = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch ((b as any).type) {
      case 'text': {
        const t = String((b as AnthropicTextBlock).text ?? '');
        texts.push(t);
        parts.push({ type: 'text', text: t });
        break;
      }
      case 'image': {
        hasImage = true;
        const src = (b as AnthropicImageBlock).source;
        if (src?.type === 'base64' && src.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` },
          });
        } else if (src?.type === 'url' && src.url) {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
        break;
      }
      case 'tool_use':
        toolUses.push(b as AnthropicToolUseBlock);
        break;
      case 'tool_result':
        toolResults.push(b as AnthropicToolResultBlock);
        break;
      default:
        // Unknown block — best-effort stringify into the text bucket.
        try { texts.push(JSON.stringify(b)); } catch { /* skip */ }
    }
  }
  return {
    text: texts.join('\n'),
    multipart: hasImage ? parts : null,
    toolUses,
    toolResults,
  };
}

function toolResultContentToString(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c))))
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content ?? '');
}

export function anthropicReqToOpenAI(body: AnthropicMessageRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  const sys = flattenSystem(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const { text, multipart, toolUses, toolResults } = anthropicContentToOpenAIContent(m.content);

    if (role === 'user' && toolResults.length > 0) {
      // tool_result blocks become tool-role messages — emit one per result.
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: toolResultContentToString(tr.content),
        });
      }
      // Any leftover text on the same user turn rides along as a user msg.
      if (text || multipart) {
        messages.push({
          role: 'user',
          content: multipart ?? text,
        });
      }
      continue;
    }

    if (role === 'assistant' && toolUses.length > 0) {
      const tool_calls: OAIToolCall[] = toolUses.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
        },
      }));
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls,
      });
      continue;
    }

    messages.push({
      role,
      content: multipart ?? text,
    });
  }

  const out: OpenAIChatRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 1024,
    stream: body.stream === true,
  };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length > 0) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc?.type === 'auto') out.tool_choice = 'auto';
      else if (tc?.type === 'any') out.tool_choice = 'required';
      else if (tc?.type === 'tool' && tc.name) {
        out.tool_choice = { type: 'function', function: { name: tc.name } };
      } else if (tc?.type === 'none') out.tool_choice = 'none';
    }
  }

  return out;
}

// =========================================================================
// Response: OpenAI → Anthropic (non-stream)
// =========================================================================

function mapFinishReason(fr: string | null | undefined): string {
  switch (fr) {
    case 'length':       return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter': return 'end_turn';
    case 'stop':
    case null:
    case undefined:
    default:
      return 'end_turn';
  }
}

export function openaiRespToAnthropic(resp: OpenAIChatResponse, fallbackModel: string): any {
  const choice = resp?.choices?.[0];
  const msg = choice?.message ?? {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const content: any[] = [];
  if (text && text.length > 0) {
    content.push({ type: 'text', text });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input: any = {};
      try { input = JSON.parse(tc.function?.arguments ?? '{}'); }
      catch { input = { _raw: tc.function?.arguments ?? '' }; }
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: resp?.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: resp?.model || fallbackModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:  Number(resp?.usage?.prompt_tokens ?? 0),
      output_tokens: Number(resp?.usage?.completion_tokens ?? 0),
    },
  };
}

// =========================================================================
// SSE parsing — OpenAI line-delimited "data: {...}\n\n"
// =========================================================================

export async function* parseOpenAISseLines(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<any> {
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
        if (!raw) continue;
        if (!raw.startsWith('data:')) continue;
        const payload = raw.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          if (payload === '[DONE]') return;
          continue;
        }
        try { yield JSON.parse(payload); }
        catch (e: any) { logger.debug({ raw: payload.slice(0, 80) }, 'openai-sse:parse_skip'); }
      }
    }
    // Drain
    if (buf.trim().startsWith('data:')) {
      const payload = buf.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { yield JSON.parse(payload); } catch { /* skip */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

// =========================================================================
// Stream transcode: OpenAI chunks → Anthropic events
// =========================================================================

interface ToolCallAccumulator {
  index: number;            // anthropic content_block index
  id: string;
  name: string;
  argsBuf: string;
  started: boolean;
}

/**
 * Consume an OpenAI SSE chunk stream and yield Anthropic-shaped events.
 *
 * Emission order:
 *
 *   message_start                            (synthesised from first chunk)
 *   content_block_start  index=0 text        (lazy — only if any text delta)
 *     content_block_delta * N
 *   content_block_stop   index=0
 *   content_block_start  index=K tool_use    (one per tool_calls index)
 *     content_block_delta * M  (input_json_delta)
 *   content_block_stop   index=K
 *   message_delta  (stop_reason + usage)
 *   message_stop
 */
export async function* transcodeOpenAIStream(
  chunks: AsyncIterable<any>,
  fallbackModel: string,
): AsyncGenerator<AnthropicEvent> {
  let messageStartSent = false;
  let messageId = `msg_${Date.now().toString(36)}`;
  let model = fallbackModel;
  let role: 'assistant' = 'assistant';

  let textIdx = -1;          // 0 if/when we open the text block; -1 = not opened
  let textOpen = false;
  let nextBlockIdx = 0;

  const toolMap = new Map<number, ToolCallAccumulator>();
  let lastFinish: string | null | undefined = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};

  for await (const chunk of chunks) {
    if (!messageStartSent) {
      messageId = chunk?.id || messageId;
      model = chunk?.model || model;
      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role,
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      messageStartSent = true;
    }

    const choice = chunk?.choices?.[0];
    if (chunk?.usage) usage = chunk.usage;
    if (!choice) continue;

    const delta = choice.delta ?? {};

    // Text content
    if (typeof delta.content === 'string' && delta.content.length > 0) {
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
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    // Tool calls — streamed incrementally, one entry per index. The
    // `function.arguments` field arrives as JSON-string fragments.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc.index ?? 0);
        let acc = toolMap.get(idx);
        if (!acc) {
          // close the text block before opening tool blocks so indexes
          // stay monotonic & well-nested.
          if (textOpen) {
            yield { type: 'content_block_stop', index: textIdx };
            textOpen = false;
          }
          acc = {
            index: nextBlockIdx++,
            id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function?.name || '',
            argsBuf: '',
            started: false,
          };
          toolMap.set(idx, acc);
        }
        if (tc.id && !acc.id.startsWith('toolu_')) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (!acc.started && acc.name) {
          yield {
            type: 'content_block_start',
            index: acc.index,
            content_block: { type: 'tool_use', id: acc.id, name: acc.name, input: {} },
          };
          acc.started = true;
        }
        const argFrag = tc.function?.arguments ?? '';
        if (argFrag) {
          acc.argsBuf += argFrag;
          if (acc.started) {
            yield {
              type: 'content_block_delta',
              index: acc.index,
              delta: { type: 'input_json_delta', partial_json: argFrag },
            };
          }
        }
      }
    }

    if (choice.finish_reason) lastFinish = choice.finish_reason;
  }

  // Close any open blocks.
  if (textOpen) yield { type: 'content_block_stop', index: textIdx };
  for (const acc of toolMap.values()) {
    if (acc.started) yield { type: 'content_block_stop', index: acc.index };
  }

  // For tool_calls finish, some upstreams emit no final delta but
  // expect us to know via the accumulated map.
  if (!lastFinish && toolMap.size > 0) lastFinish = 'tool_calls';

  yield {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(lastFinish), stop_sequence: null },
    usage: {
      input_tokens:  Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
    },
  };
  yield { type: 'message_stop' };
}

/**
 * Encode an Anthropic SSE event to wire text.
 *
 *   event: <type>
 *   data: <json>
 *   <blank line>
 */
export function encodeAnthropicEvent(ev: AnthropicEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
