/**
 * packages/ai/src/api/google-generative-ai.ts
 *
 * Plan 451 Phase 4: Google Gemini GenerativeLanguage API wire protocol.
 *
 * Implements Gemini's `streamGenerateContent?alt=sse` endpoint with direct
 * `fetch` (no Google SDK dependency). Maps Gemini content parts onto
 * duya's internal `AssistantMessageEvent` flow; downstream `emit-sse.ts`
 * lowers them to the public `SSEEvent` shape.
 *
 * Scope (Phase 4 MVP):
 *   - Text content parts (streamed; supports `thought` for thinking content)
 *   - Function-call parts (streamed via a single `functionCall` block)
 *   - thoughtSignature replay (any part type may carry a base64
 *     `thoughtSignature` for cross-turn reasoning continuity; preserved
 *     verbatim on the assistant message's text/thinking blocks)
 *   - usageMetadata (promptTokenCount / candidatesTokenCount /
 *     cachedContentTokenCount)
 *   - Stop reasons: STOP / MAX_TOKENS / SAFETY / RECITATION / OTHER
 *
 * Out of scope (future phases):
 *   - Image / video / audio input (multimodal function responses)
 *   - System instructions via `systemInstruction` (handled via
 *     `chatOptions.systemPrompt`)
 *   - Tool choice configuration (`ANY` / `NONE` / forced function)
 *   - Cached content reuse
 *   - Grounding (Google Search, code execution)
 *
 * Reference:
 *   https://ai.google.dev/api/generate-content#streamgeneratecontent
 */

import type {
  AIClient,
  AIClientOptions,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  MessageContent,
  SSEEvent,
  TextContent,
  ThinkingContent,
  TokenUsage,
  ToolUseContent,
} from '../types.js';
import { emitSSE } from './emit-sse.js';

// =============================================================================
// Wire types (Gemini GenerativeLanguage)
// =============================================================================

interface GeminiPart {
  text?: string;
  /** True when the part is a thought summary (Gemini 2.5+). */
  thought?: boolean;
  /** Opaque base64 signature for cross-turn reasoning continuity. */
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: 'system'; parts: GeminiPart[] };
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    /** Gemini 2.5+ thinking control. */
    thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
  };
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | string;
  index?: number;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  modelVersion?: string;
  usageMetadata?: GeminiUsageMetadata;
}

// =============================================================================
// Request conversion (duya Message[] → GeminiRequest)
// =============================================================================

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: stringContent(m.content) }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') {
            parts.push({ text: b.text });
          } else if (b.type === 'thinking') {
            // Replay: surface the prior turn's thinking + signature.
            const part: GeminiPart = { text: b.thinking, thought: true };
            if (b.thinkingSignature) part.thoughtSignature = b.thinkingSignature;
            parts.push(part);
          } else if (b.type === 'tool_use') {
            parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> } });
          }
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      const result = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
          : '';
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? '',
              response: { result },
            },
          },
        ],
      });
    }
  }
  return out;
}

function stringContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[image]';
      return '';
    })
    .join('');
}

// =============================================================================
// SSE parsing (reused pattern from bedrock-converse.ts)
// =============================================================================

async function* parseSSE(
  reader: ReadableStream<Uint8Array>,
): AsyncGenerator<{ data: string }, void, void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of reader) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = parseFrameData(frame);
      if (data) yield { data };
    }
  }
  if (buffer.trim().length > 0) {
    const data = parseFrameData(buffer);
    if (data) yield { data };
  }
}

function parseFrameData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return null;
  return data;
}

// =============================================================================
// Event mapping (Gemini → AssistantMessageEvent)
// =============================================================================

class GeminiStreamAccumulator {
  readonly partial: AssistantMessage;
  /** Track per-index content block being assembled (text vs tool). */
  private blocks: Array<TextContent | ThinkingContent | ToolUseContent> = [];

  constructor(modelId: string, providerId: string) {
    this.partial = {
      role: 'assistant',
      content: [],
      api: 'gemini',
      provider: providerId,
      model: modelId,
      usage: { input_tokens: 0, output_tokens: 0 },
      stopReason: 'completed',
      timestamp: Date.now(),
    } as AssistantMessage;
  }

  /** Apply a Gemini candidate to the accumulator; return internal events. */
  apply(candidate: GeminiCandidate): AssistantMessageEvent[] {
    const out: AssistantMessageEvent[] = [];
    const content = candidate.content;
    if (!content) {
      // Finish-only candidate.
      if (candidate.finishReason) {
        out.push(this.done(candidate.finishReason));
      }
      return out;
    }
    const idx = candidate.index ?? 0;
    // Ensure we have enough blocks.
    while (this.blocks.length <= idx) {
      this.blocks.push({ type: 'text', text: '' });
      this.partial.content[this.blocks.length - 1] = this.blocks[this.blocks.length - 1];
    }
    let block = this.blocks[idx];
    for (const part of content.parts) {
      if (part.functionCall) {
        const toolBlock: ToolUseContent = {
          type: 'tool_use',
          id: `gemini-call-${idx}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        };
        this.blocks[idx] = toolBlock;
        this.partial.content[idx] = toolBlock;
        out.push({
          type: 'toolcall_start',
          contentIndex: idx,
          partial: this.partial,
        });
        out.push({
          type: 'toolcall_end',
          contentIndex: idx,
          toolCall: toolBlock,
          partial: this.partial,
        });
        continue;
      }
      if (typeof part.text === 'string') {
        if (part.thought === true) {
          // Thinking block — create or append.
          if (block.type !== 'thinking') {
            block = { type: 'thinking', thinking: '' } as ThinkingContent;
            this.blocks[idx] = block;
            this.partial.content[idx] = block;
            out.push({ type: 'thinking_start', contentIndex: idx, partial: this.partial });
          }
          (block as ThinkingContent).thinking += part.text;
          if (typeof part.thoughtSignature === 'string') {
            (block as ThinkingContent).thinkingSignature = part.thoughtSignature;
          }
          out.push({
            type: 'thinking_delta',
            contentIndex: idx,
            delta: part.text,
            partial: this.partial,
          });
          out.push({
            type: 'thinking_end',
            contentIndex: idx,
            content: (block as ThinkingContent).thinking,
            partial: this.partial,
          });
        } else {
          // Plain text block.
          if (block.type !== 'text') {
            block = { type: 'text', text: '' } as TextContent;
            this.blocks[idx] = block;
            this.partial.content[idx] = block;
            out.push({ type: 'text_start', contentIndex: idx, partial: this.partial });
          }
          (block as TextContent).text += part.text;
          if (typeof part.thoughtSignature === 'string') {
            // Signature attached to text for replay continuity.
            (block as TextContent).textSignature = part.thoughtSignature;
          }
          out.push({
            type: 'text_delta',
            contentIndex: idx,
            delta: part.text,
            partial: this.partial,
          });
          out.push({
            type: 'text_end',
            contentIndex: idx,
            content: (block as TextContent).text,
            partial: this.partial,
          });
        }
      }
    }
    if (candidate.finishReason) {
      out.push(this.done(candidate.finishReason));
    }
    return out;
  }

  usage(u: GeminiUsageMetadata): void {
    this.partial.usage = {
      input_tokens: u.promptTokenCount ?? 0,
      output_tokens: u.candidatesTokenCount ?? 0,
      ...(u.cachedContentTokenCount !== undefined
        ? { cacheReadTokens: u.cachedContentTokenCount }
        : {}),
    };
  }

  done(reason: string): AssistantMessageEvent {
    const stopReason = mapGeminiStopReason(reason);
    this.partial.stopReason = stopReason;
    return { type: 'done', reason: stopReason ?? 'completed', message: this.partial };
  }
}

function mapGeminiStopReason(reason: string): AssistantMessage['stopReason'] {
  switch (reason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'OTHER':
      return 'error';
    default:
      return 'end_turn';
  }
}

// =============================================================================
// Factory
// =============================================================================

export interface GoogleGenerativeAiClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Override the default endpoint 'https://generativelanguage.googleapis.com/v1beta'. */
  readonly baseUrl?: string;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Optional abort signal. */
  readonly signal?: AbortSignal;
}

export function createGoogleGenerativeAiClient(
  opts: GoogleGenerativeAiClientOptions,
): AIClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('createGoogleGenerativeAiClient: global fetch is not available');
  }
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';

  return {
    async *streamChat(
      messages: Message[],
      chatOptions?: {
        systemPrompt?: string;
        maxTokens?: number;
        temperature?: number;
        maxOutputTokens?: number;
        signal?: AbortSignal;
      },
    ): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
      const requestBody: GeminiRequest = {
        contents: toGeminiContents(messages),
      };
      if (chatOptions?.systemPrompt) {
        requestBody.systemInstruction = {
          role: 'system',
          parts: [{ text: chatOptions.systemPrompt }],
        };
      }
      const cfg: NonNullable<GeminiRequest['generationConfig']> = {};
      const max = chatOptions?.maxOutputTokens ?? chatOptions?.maxTokens;
      if (max) cfg.maxOutputTokens = max;
      if (chatOptions?.temperature !== undefined) cfg.temperature = chatOptions.temperature;
      if (Object.keys(cfg).length > 0) requestBody.generationConfig = cfg;

      const body = JSON.stringify(requestBody);
      const endpoint = `${baseUrl}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': opts.apiKey,
          accept: 'text/event-stream',
        },
        body,
        signal: chatOptions?.signal ?? opts.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        yield {
          type: 'error',
          data: `Gemini HTTP ${response.status}: ${errText.slice(0, 200)}`,
          code: `gemini.http.${response.status}`,
        };
        return {
          ...new GeminiStreamAccumulator(opts.model, 'google').partial,
          stopReason: 'error',
        };
      }

      const acc = new GeminiStreamAccumulator(opts.model, 'google');
      for await (const ev of parseSSE(response.body)) {
        let parsed: GeminiResponse;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        for (const candidate of parsed.candidates ?? []) {
          const events = acc.apply(candidate);
          for (const e of events) {
            const sse = emitSSE(e);
            if (sse) yield sse;
          }
        }
        if (parsed.usageMetadata) {
          acc.usage(parsed.usageMetadata);
        }
      }
      if (acc.partial.stopReason === 'completed') {
        const doneEv = acc.done('STOP');
        const sse = emitSSE(doneEv);
        if (sse) yield sse;
      }
      return acc.partial;
    },
  };
}