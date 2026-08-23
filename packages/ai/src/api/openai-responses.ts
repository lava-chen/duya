/**
 * packages/ai/src/api/openai-responses.ts
 *
 * OpenAI Responses API (/v1/responses) implementation.
 *
 * The Responses API is the newer OpenAI endpoint that supports:
 * - Server-side conversation continuation via previous_response_id
 * - Reasoning models (o1, o3, o4-mini, etc.) with native reasoning content
 * - Function calling
 *
 * Key differences from chat completions:
 * - Uses `input` (array of ResponseInputItem) instead of `messages`
 * - `reasoning: { effort }` instead of `reasoning_effort`
 * - `max_output_tokens` instead of `max_tokens`
 * - `instructions` field for system prompt
 * - Streaming events are `response.*` types (response.output_text.delta, etc.)
 * - Reasoning deltas arrive as `response.reasoning_text.delta` or
 *   `response.reasoning_summary_text.delta`
 */

import OpenAI from 'openai';
import type {
  AIClient, AIClientOptions, AssistantMessage, AssistantMessageEvent,
  Message, Model, ProviderBlockContent, SSEEvent,
  TextContent, ThinkingContent, ToolUseContent,
} from '../types.js';
import { transformMessages } from './transform-messages.js';
import { summarizeProviderBlock } from './degrade.js';
import { emitSSE } from './emit-sse.js';
import { ThinkTagParser } from '../utils/think-tag-parser.js';
import { getTemperature } from '../utils/simple-options.js';
import { sortToolsByName } from '../utils/tool-order.js';
import { localRuntimeApiKeyOrPlaceholder } from './local-runtime.js';

// =============================================================================
// Types
// =============================================================================

/** Internal accumulator type for streaming JSON arguments. */
type ToolUseWithRaw = ToolUseContent & { _rawInput?: string };

// =============================================================================
// Reasoning resolver
// =============================================================================

/**
 * Resolve the `reasoning` parameter for the Responses API.
 *
 * The Responses API uses `reasoning: { effort: ReasoningEffort }` where
 * ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'.
 *
 * - Non-reasoning models → undefined.
 * - effort 'off' / undefined → undefined (let model use its default).
 * - Otherwise → map duya effort to ReasoningEffort.
 */
function resolveResponsesReasoning(
  model: Model<'openai-responses'>,
  effort?: string,
): { effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } | undefined {
  if (!model.reasoning) return undefined;
  if (!effort || effort === 'off') return undefined;

  const EFFORT_MAP: Record<string, 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'> = {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
  };

  const mapped = EFFORT_MAP[effort];
  return mapped ? { effort: mapped } : undefined;
}

// =============================================================================
// Usage mapping
// =============================================================================

/**
 * The Responses API reports cache hits in `usage.input_tokens_details.cached_tokens`
 * (same convention as Chat Completions' `prompt_tokens_details.cached_tokens`).
 * The SDK's `ResponseUsage` type omits the field, so we narrow structurally.
 */
interface ResponseInputTokenDetails {
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * Map a Responses API usage block to duya's `TokenUsage` shape.
 *
 * `input_tokens` already includes the cached portion, so it maps 1:1 —
 * `cached_tokens` is only split out so the pipeline can report cache hit
 * rate and price cache reads at the discounted rate.
 */
export function mapResponsesUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  totalTokens: number | undefined,
  cachedTokens: number | undefined,
): {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_hit_tokens: number;
} {
  return {
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    total_tokens: totalTokens,
    cache_hit_tokens: cachedTokens || 0,
  };
}

/** Read `input_tokens_details.cached_tokens` off a raw Responses usage block. */
function cachedTokensFromResponse(usage: unknown): number | undefined {
  return (usage as ResponseInputTokenDetails | undefined)?.input_tokens_details?.cached_tokens;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * Convert duya Message[] to OpenAI Responses API input items.
 *
 * System messages are skipped (passed separately via `instructions`).
 * Tool results become `function_call_output` items.
 * Tool calls in assistant history become `function_call` items.
 * Thinking blocks are dropped — the Responses API manages reasoning
 * server-side via previous_response_id.
 */
// Exported for tests (same seam rationale as parseAnthropicEvent).
export function toResponsesInput(messages: Message[]): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      // OpenAI Responses function_call_output only accepts a string `output`.
      // When a tool returned inline images (MessageContent[] array, e.g.
      // ReadTool on a pure image file), extract text blocks and append a
      // fallback hint for image blocks. The Responses API has no image
      // carrier for tool outputs (only user-message input_image blocks).
      let output: string;
      if (typeof msg.content === 'string') {
        output = msg.content;
      } else if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        let hasImage = false;
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(block.text);
          } else if (block.type === 'image') {
            hasImage = true;
          }
        }
        if (hasImage) {
          parts.push('(image omitted: OpenAI tool outputs cannot carry images. Use the vision tool to analyze the image.)');
        }
        output = parts.join('\n').trim();
      } else {
        output = JSON.stringify(msg.content);
      }
      result.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output,
      } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
      continue;
    }

    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        type: 'message',
      } as OpenAI.Responses.EasyInputMessage);
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'user') {
      const parts: OpenAI.Responses.ResponseInputContent[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text });
        } else if (block.type === 'image') {
          const imageUrl = block.source.type === 'url'
            ? block.source.data
            : `data:${block.source.media_type};base64,${block.source.data}`;
          parts.push({
            type: 'input_image',
            image_url: imageUrl,
            detail: 'auto',
          });
        } else if (block.type === 'tool_result') {
          const output = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output,
          } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
        }
      }
      if (parts.length > 0) {
        result.push({
          role: 'user',
          content: parts,
          type: 'message',
        } as OpenAI.Responses.EasyInputMessage);
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        } else if (block.type === 'provider_block') {
          // Plan 440 phase 1: degrade to the bounded summary. Even
          // same-origin carriers are degraded here — the Responses API can
          // accept some item types in input, but re-emitting verbatim
          // payloads is deliberately deferred until verified live; a text
          // summary is always wire-valid.
          textParts.push(summarizeProviderBlock(block));
        }
        // Skip thinking blocks — Responses API handles reasoning server-side.
      }
      if (textParts.length > 0) {
        result.push({
          role: 'assistant',
          content: textParts.join(''),
          type: 'message',
        } as OpenAI.Responses.EasyInputMessage);
      }
      for (const tc of toolCalls) {
        result.push(tc as OpenAI.Responses.ResponseInputItem);
      }
    }
  }

  return result;
}

/**
 * When using previous_response_id, only the new messages (after the last
 * assistant message) should be sent — the server stores prior context.
 * If no previous response exists, return all messages.
 */
function extractNewMessages(messages: Message[], hasPreviousResponse: boolean): Message[] {
  if (!hasPreviousResponse) return messages;
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return messages;
  return messages.slice(lastAssistantIdx + 1);
}

// =============================================================================
// Event helpers
// =============================================================================

/**
 * Append a thinking delta to the assistant message. Consecutive thinking
 * deltas targeting the same content index are merged.
 */
function appendThinking(
  msg: AssistantMessage,
  text: string,
  contentIndex: number,
): AssistantMessageEvent {
  const block = msg.content[contentIndex];
  if (block && block.type === 'thinking') {
    block.thinking += text;
    return { type: 'thinking_delta', contentIndex, delta: text, partial: msg };
  }
  // Fallback: push a new thinking block
  msg.content.push({ type: 'thinking', thinking: text });
  const idx = msg.content.length - 1;
  return { type: 'thinking_delta', contentIndex: idx, delta: text, partial: msg };
}

/** Append a text delta to the assistant message at the given content index. */
function appendText(
  msg: AssistantMessage,
  text: string,
  contentIndex: number,
): AssistantMessageEvent {
  const block = msg.content[contentIndex];
  if (block && block.type === 'text') {
    block.text += text;
    return { type: 'text_delta', contentIndex, delta: text, partial: msg };
  }
  msg.content.push({ type: 'text', text });
  const idx = msg.content.length - 1;
  return { type: 'text_delta', contentIndex: idx, delta: text, partial: msg };
}

/** Parse accumulated JSON strings for all tool_use blocks and drop _rawInput. */
function finalizeToolCalls(msg: AssistantMessage): void {
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      const raw = (block as ToolUseWithRaw)._rawInput;
      if (raw !== undefined) {
        try {
          block.input = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          block.input = {};
        }
        delete (block as ToolUseWithRaw)._rawInput;
      }
    }
  }
}

// =============================================================================
// Status mapping
// =============================================================================

function mapStatus(
  status: string | undefined,
  hasToolCalls: boolean,
): AssistantMessage['stopReason'] {
  if (status === 'failed') return 'error';
  if (status === 'incomplete') return 'max_turns';
  if (status === 'cancelled') return 'aborted';
  if (hasToolCalls) return 'tool_use';
  return 'end_turn';
}

// =============================================================================
// Client factory
// =============================================================================

/**
 * Build an AIClient backed by the OpenAI Responses API.
 *
 * The returned client implements the AIClient interface from types.ts:
 * - streamChat yields SSEEvent and returns the final AssistantMessage.
 * - chat performs a non-streaming request and returns { content, usage }.
 *
 * Server-side continuation: the client tracks the last response ID and
 * includes it as `previous_response_id` in subsequent requests, so only
 * new messages need to be sent. This is a per-client-instance simplification
 * — in production, this would need to be per-conversation.
 */
// =============================================================================
// Event parser (plan 440 phase 2 extraction — mirrors parseAnthropicEvent)
// =============================================================================

/** Accumulated state shared by parseResponsesEvent across stream events. */
export interface ResponsesParseState {
  assistantMsg: AssistantMessage;
  itemToContentIdx: Map<string, number>;
  thinkParser?: ThinkTagParser | null;
  responseId?: string;
}

/**
 * Map a Responses API stream event onto the internal AssistantMessage,
 * mutating state in place. Returns the internal event(s) to surface as SSE
 * (empty/null → nothing to emit). Fatal lifecycle events (response.failed /
 * error) are handled by the caller.
 */
export function parseResponsesEvent(
  event: OpenAI.Responses.ResponseStreamEvent,
  state: ResponsesParseState,
): AssistantMessageEvent | AssistantMessageEvent[] | null {
  const { assistantMsg, itemToContentIdx } = state;

  switch (event.type) {
    // ── Response lifecycle ──────────────────────────────────────
    case 'response.created': {
      state.responseId = event.response.id;
      return null;
    }

    case 'response.completed': {
      const resp = event.response;
      state.responseId = resp.id;
      if (resp.usage) {
        assistantMsg.usage = {
          input_tokens: resp.usage.input_tokens || 0,
          output_tokens: resp.usage.output_tokens || 0,
          total_tokens: resp.usage.total_tokens,
        };
      }
      // Plan 440 phase 2: observability metadata, captured verbatim.
      const serviceTier = (resp as unknown as Record<string, unknown>).service_tier;
      if (typeof serviceTier === 'string' && serviceTier.length > 0) {
        assistantMsg.providerMeta = { ...assistantMsg.providerMeta, serviceTier };
      }
      assistantMsg.stopReason = mapStatus(
        resp.status,
        assistantMsg.content.some(b => b.type === 'tool_use'),
      );
      return null;
    }

    case 'response.incomplete': {
      const resp = event.response;
      state.responseId = resp.id;
      if (resp.usage) {
        assistantMsg.usage = {
          input_tokens: resp.usage.input_tokens || 0,
          output_tokens: resp.usage.output_tokens || 0,
          total_tokens: resp.usage.total_tokens,
        };
      }
      const serviceTier = (resp as unknown as Record<string, unknown>).service_tier;
      if (typeof serviceTier === 'string' && serviceTier.length > 0) {
        assistantMsg.providerMeta = { ...assistantMsg.providerMeta, serviceTier };
      }
      assistantMsg.stopReason = 'max_turns';
      return null;
    }

    // ── Output item lifecycle ───────────────────────────────────
    case 'response.output_item.added': {
      const item = event.item;
      if (item.type === 'reasoning') {
        const block: ThinkingContent = {
          type: 'thinking',
          thinking: '',
          thinkingSignature: 'reasoning-text',
        };
        // Plan 440 phase 2: keep encrypted reasoning so store:false
        // sessions can replay it (plaintext deltas are not always
        // re-derivable server-side).
        const encryptedContent = (item as unknown as Record<string, unknown>).encrypted_content;
        if (typeof encryptedContent === 'string' && encryptedContent.length > 0) {
          block.encrypted = encryptedContent;
        }
        assistantMsg.content.push(block);
        itemToContentIdx.set(item.id, assistantMsg.content.length - 1);
      } else if (item.type === 'message') {
        const block: TextContent = { type: 'text', text: '' };
        assistantMsg.content.push(block);
        itemToContentIdx.set(item.id, assistantMsg.content.length - 1);
      } else if (item.type === 'function_call') {
        const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
        const block: ToolUseContent = {
          type: 'tool_use',
          id: fc.call_id || fc.id || '',
          name: fc.name || '',
          input: {},
        };
        (block as ToolUseWithRaw)._rawInput = '';
        assistantMsg.content.push(block);
        const idx = assistantMsg.content.length - 1;
        itemToContentIdx.set(item.id || fc.call_id, idx);
        return { type: 'toolcall_start', contentIndex: idx, partial: assistantMsg };
      } else {
        // Plan 440 phase 1: server-side output items (web_search_call,
        // file_search_call, code_interpreter_call, image_generation_call,
        // mcp_call, ...) are carried verbatim instead of dropped — a
        // bounded one-line summary lands in the text stream when the
        // item completes.
        const carrier: ProviderBlockContent = {
          type: 'provider_block',
          origin: 'openai-responses',
          kind: String(item.type),
          payload: item,
        };
        assistantMsg.content.push(carrier);
        itemToContentIdx.set(item.id, assistantMsg.content.length - 1);
      }
      return null;
    }

    case 'response.output_item.done': {
      const item = event.item;
      const itemId = item.id;
      if (!itemId) return null;
      const idx = itemToContentIdx.get(itemId);
      if (idx === undefined) return null;
      const block = assistantMsg.content[idx];

      if (block && block.type === 'tool_use') {
        // Parse accumulated JSON arguments.
        const raw = (block as ToolUseWithRaw)._rawInput;
        if (raw !== undefined) {
          try {
            block.input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            block.input = {};
          }
          delete (block as ToolUseWithRaw)._rawInput;
        }
        return { type: 'toolcall_end', contentIndex: idx, toolCall: block, partial: assistantMsg };
      }
      if (block && block.type === 'text') {
        return { type: 'text_end', contentIndex: idx, content: block.text, partial: assistantMsg };
      }
      if (block && block.type === 'thinking') {
        return { type: 'thinking_end', contentIndex: idx, content: block.thinking, partial: assistantMsg };
      }
      if (block && block.type === 'provider_block') {
        // Plan 440 phase 1: degrade visibly — a bounded one-line
        // summary lands in the text stream when the item completes.
        return appendText(assistantMsg, summarizeProviderBlock(block));
      }
      return null;
    }

    // ── Reasoning deltas ────────────────────────────────────────
    case 'response.reasoning_text.delta': {
      const idx = itemToContentIdx.get(event.item_id);
      if (idx === undefined) return null;
      return appendThinking(assistantMsg, event.delta, idx);
    }

    case 'response.reasoning_summary_text.delta': {
      // Some models only produce summary text, not full reasoning text.
      // Treat it as thinking content.
      const idx = itemToContentIdx.get(event.item_id);
      if (idx === undefined) return null;
      return appendThinking(assistantMsg, event.delta, idx);
    }

    // ── Text deltas ─────────────────────────────────────────────
    case 'response.output_text.delta': {
      const idx = itemToContentIdx.get(event.item_id);
      if (idx === undefined) return null;
      if (state.thinkParser) {
        const { thinking, text } = state.thinkParser.feed(event.delta);
        const events: AssistantMessageEvent[] = [];
        if (thinking) {
          events.push(appendThinking(assistantMsg, thinking, idx));
        }
        if (text) {
          events.push(appendText(assistantMsg, text, idx));
        }
        return events;
      }
      return appendText(assistantMsg, event.delta, idx);
    }

    // Plan 440 phase 2: capture search/compute citations on the owning
    // text block; rendering is a frontend concern tracked separately.
    case 'response.output_text.annotation.added': {
      const ev = event as unknown as { item_id?: string; annotation?: unknown };
      if (!ev.item_id || ev.annotation === undefined) return null;
      const idx = itemToContentIdx.get(ev.item_id);
      if (idx === undefined) return null;
      const block = assistantMsg.content[idx];
      if (block && block.type === 'text') {
        block.annotations = [...(block.annotations ?? []), ev.annotation];
      }
      return null;
    }

    // ── Function call argument deltas ───────────────────────────
    case 'response.function_call_arguments.delta': {
      const idx = itemToContentIdx.get(event.item_id);
      if (idx === undefined) return null;
      const block = assistantMsg.content[idx];
      if (!block || block.type !== 'tool_use') return null;
      const raw = (block as ToolUseWithRaw)._rawInput || '';
      (block as ToolUseWithRaw)._rawInput = raw + event.delta;
      return { type: 'toolcall_delta', contentIndex: idx, delta: event.delta, partial: assistantMsg };
    }

    default:
      // Plan 440 phase 1: item-level unknowns are carried verbatim at
      // output_item.added. Remaining event types (in-progress deltas
      // of carried items, audio transcripts, ...) have no duya
      // surface and stay ignored by design.
      return null;
  }
}

export function createOpenAIResponsesClient(options: AIClientOptions): AIClient {
  // Local-runtime compatibility shim: same rationale as
  // `openai-completions.ts#createOpenAICompletionsClient`. LM Studio
  // and Ollama don't authenticate clients, but the OpenAI Node SDK
  // constructor refuses to instantiate without a key. Inject the
  // placeholder when the caller's `apiKey` is empty so the SDK doesn't
  // throw on first contact with a local install. The Bearer header is
  // ignored by LM Studio / Ollama so the placeholder is safe.
  const client = new OpenAI({
    apiKey: localRuntimeApiKeyOrPlaceholder(options.apiKey),
    baseURL: options.baseURL,
    defaultHeaders: options.headers,
  });

  // Track previous_response_id for server-side conversation continuation.
  let previousResponseId: string | undefined;

  return {
    async *streamChat(messages, chatOptions) {
      // 1. Build model from options + capabilities.
      const model: Model<'openai-responses'> = {
        id: options.model,
        name: options.model,
        api: 'openai-responses',
        providerId: options.providerId,
        baseUrl: options.baseURL,
        reasoning: !!options.modelCapabilities?.openAIThinkingFormat,
        thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
        compat: options.modelCapabilities,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 100000,
      };

      // 2. Transform messages (isSameModel guard — downgrades cross-model
      //    thinking to plain text and discards signatures).
      const transformed = transformMessages(messages, model);

      // 3. When continuing a previous response, only send new messages.
      const messagesToSend = extractNewMessages(transformed, !!previousResponseId);
      const input = toResponsesInput(messagesToSend);

      // 4. Resolve reasoning config from model + effort.
      const reasoning = resolveResponsesReasoning(model, chatOptions?.effort);

      // 5. Setup think-tag parser fallback (for providers that embed
      //    thinking in text rather than using native reasoning events).
      const useThinkTagParser = model.compat?.openAIThinkingFormat === 'think-tag-fallback';
      const thinkParser = useThinkTagParser ? new ThinkTagParser() : null;

      // 6. Build request params.
      const maxOutputTokens = chatOptions?.totalOutputBudget
        ?? chatOptions?.maxOutputTokens
        ?? chatOptions?.maxTokens
        ?? 16384;

      const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model: options.model,
        input,
        stream: true,
        max_output_tokens: maxOutputTokens,
        ...(chatOptions?.systemPrompt
          ? { instructions: chatOptions.systemPrompt }
          : {}),
        ...(getTemperature(model, chatOptions?.temperature) !== undefined
          ? { temperature: getTemperature(model, chatOptions?.temperature) }
          : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(chatOptions?.tools?.length
          ? {
              tools: sortToolsByName(chatOptions.tools).map(t => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
                strict: false,
              })),
            }
          : {}),
      };

      // 7. Initialize assistant message accumulator.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: 'openai-responses',
        providerId: options.providerId,
        model: options.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: 'completed',
        timestamp: Date.now(),
      };

      // Map output item ID → contentIndex in assistantMsg.content.
      const itemToContentIdx = new Map<string, number>();
      let responseId: string | undefined;

      // 8. Open the stream.
      const stream = await client.responses.create(
        params,
        chatOptions?.signal ? { signal: chatOptions.signal } : undefined,
      );

      // 9. Drain events. Fatal lifecycle errors stay inline — they surface
      //    as raw error SSE. Every other event maps through
      //    parseResponsesEvent (exported so tests can drive the protocol
      //    mapping directly, mirroring parseAnthropicEvent).
      const responsesState: ResponsesParseState = {
        assistantMsg,
        itemToContentIdx,
        thinkParser,
      };
      for await (const event of stream) {
        if (event.type === 'response.failed') {
          const errMsg = event.response.error?.message || 'Response failed';
          yield { type: 'error', data: errMsg, code: 'response_failed' };
          assistantMsg.stopReason = 'error';
          continue;
        }
        if (event.type === 'error') {
          yield {
            type: 'error',
            data: event.message || 'Unknown error',
            code: event.code || undefined,
          };
          continue;
        }
        const parsed = parseResponsesEvent(event, responsesState);
        if (!parsed) continue;
        const internalEvents = Array.isArray(parsed) ? parsed : [parsed];
        for (const internalEvent of internalEvents) {
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
      }
      responseId = responsesState.responseId;

      // 10. Finalize any tool calls that weren't finalized by output_item.done.
      finalizeToolCalls(assistantMsg);

      // 11. Flush think-tag parser if active.
      if (thinkParser) {
        const { thinking, text } = thinkParser.flush();
        // Find the last text block to flush into.
        let lastTextIdx = -1;
        for (let i = assistantMsg.content.length - 1; i >= 0; i--) {
          if (assistantMsg.content[i].type === 'text') {
            lastTextIdx = i;
            break;
          }
        }
        if (thinking && lastTextIdx >= 0) {
          const internalEvent = appendThinking(assistantMsg, thinking, lastTextIdx);
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
        if (text && lastTextIdx >= 0) {
          const internalEvent = appendText(assistantMsg, text, lastTextIdx);
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
      }

      // 12. Store responseId for server-side continuation.
      if (responseId) {
        previousResponseId = responseId;
        assistantMsg.responseId = responseId;
        // Attach responseId as signature on content blocks for replay.
        for (const block of assistantMsg.content) {
          if (block.type === 'thinking') {
            block.thinkingSignature = responseId;
          } else if (block.type === 'text') {
            block.textSignature = responseId;
          } else if (block.type === 'tool_use') {
            block.thoughtSignature = responseId;
          }
        }
      }

      // 13. Yield final result event with token usage.
      if (assistantMsg.usage) {
        yield { type: 'result', data: assistantMsg.usage };
      }

      // 14. Yield `done` event so DuyaAgent's turn-finalization logic
      // is triggered. See openai-completions.ts for full rationale.
      yield { type: 'done', reason: assistantMsg.stopReason || 'completed' };

      return assistantMsg;
    },

    async chat(messages, chatOptions) {
      // Build model for non-streaming request (no thinking).
      const model: Model<'openai-responses'> = {
        id: options.model,
        name: options.model,
        api: 'openai-responses',
        providerId: options.providerId,
        baseUrl: options.baseURL,
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 4096,
      };

      const transformed = transformMessages(messages, model);
      const input = toResponsesInput(transformed);

      const response = await client.responses.create({
        model: options.model,
        input,
        max_output_tokens: chatOptions?.maxTokens ?? 1024,
        ...(chatOptions?.systemPrompt
          ? { instructions: chatOptions.systemPrompt }
          : {}),
        ...(chatOptions?.temperature !== undefined
          ? { temperature: chatOptions.temperature }
          : {}),
      });

      return {
        content: response.output_text || '',
        usage: response.usage
          ? mapResponsesUsage(
              response.usage.input_tokens,
              response.usage.output_tokens,
              response.usage.total_tokens,
              cachedTokensFromResponse(response.usage),
            )
          : undefined,
      };
    },
  };
}
