/**
 * packages/ai/src/api/openai-completions.ts
 *
 * OpenAI Chat Completions API implementation.
 * Migrated from packages/agent/src/llm/openai-client.ts.
 *
 * Key changes (spec §8.2):
 * - thinkingFormat switch (5 branches) replaces hardcoded reasoning_content handling
 * - <think> tag state machine for think-tag-fallback format
 * - reasoning_content field name stored as ThinkingContent.thinkingSignature
 *
 * Utility functions (toOpenAIMessages, appendThinking/Text/ToolCall) are
 * re-implemented here to avoid a circular dependency on @duya/agent.
 */

import OpenAI from 'openai';
import type {
  AIClient, AIClientOptions, AssistantMessage, AssistantMessageEvent,
  Message, Model, SSEEvent,
  TextContent, ThinkingContent, ToolUseContent,
} from '../types.js';
import { transformMessages } from './transform-messages.js';
import { emitSSE } from './emit-sse.js';
import { ThinkTagParser } from '../utils/think-tag-parser.js';
import { collectDiagnostics } from '../utils/simple-options.js';

// =============================================================================
// Types
// =============================================================================

/** Structural type for OpenAI streaming tool call delta (SDK-version-safe). */
interface OpenAIToolCallDelta {
  index?: number | null;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Internal accumulator type for streaming JSON arguments. */
type ToolUseWithRaw = ToolUseContent & { _rawInput?: string };

// =============================================================================
// Thinking resolver
// =============================================================================

/**
 * Resolve OpenAI-style thinking parameters from model capabilities and
 * user-requested effort level.
 *
 * - Non-reasoning models → undefined.
 * - effort 'off' / undefined → undefined.
 * - model.compat?.openAIThinkingFormat selects the wire shape:
 *   - openai-standard:   reasoning_effort parameter (OpenAI o1/o3).
 *   - reasoning-content: no param; reasoning arrives in reasoning_content.
 *   - qwen-style:        enable_thinking + thinking_budget.
 *   - glm-style:         thinking { type, budget_tokens }.
 *   - think-tag-fallback: no param; reasoning arrives in <think> tags.
 */
export function resolveOpenAIThinking(
  model: Model<'openai-chat'>,
  effort?: string,
): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  if (!effort || effort === 'off') return undefined;

  const format = model.compat?.openAIThinkingFormat;
  if (!format) return undefined;

  // Map effort to intensity strings understood by different providers.
  const EFFORT_MAP: Record<string, string> = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };

  const mappedEffort = EFFORT_MAP[effort];
  if (!mappedEffort) return undefined;

  switch (format) {
    case 'openai-standard':
      // OpenAI o1/o3: reasoning_effort parameter
      return { reasoning_effort: mappedEffort };
    case 'reasoning-content':
      // DeepSeek, Qwen: no special parameter, reasoning comes in reasoning_content field
      return undefined;
    case 'qwen-style':
      // Qwen: enable_thinking parameter
      return { enable_thinking: true, thinking_budget: getBudgetForEffort(effort) };
    case 'glm-style':
      // GLM: thinking parameter
      return { thinking: { type: 'enabled', budget_tokens: getBudgetForEffort(effort) } };
    case 'think-tag-fallback':
      // No special parameter, thinking comes in <think> tags in content
      return undefined;
    default:
      return undefined;
  }
}

function getBudgetForEffort(effort: string): number {
  const BUDGET: Record<string, number> = {
    minimal: 1024,
    low: 4096,
    medium: 8192,
    high: 16384,
    xhigh: 24576,
    max: 32000,
  };
  return BUDGET[effort] || 8192;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * Convert duya Message[] to OpenAI ChatCompletionMessageParam[].
 *
 * System messages are skipped (they are passed separately via the systemPrompt
 * option). Tool results inside user messages become 'tool' role messages.
 * Thinking blocks in assistant history are dropped — OpenAI has no wire format
 * for them, and transformMessages has already downgraded cross-model thinking
 * to plain text.
 */
function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages are passed separately via the systemPrompt option.
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: {
                url: block.source.type === 'url'
                  ? block.source.data
                  : `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          } else if (block.type === 'tool_result') {
            // Tool results go as 'tool' role messages in OpenAI format.
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content,
            });
          }
        }
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'thinking') {
            // OpenAI doesn't support thinking blocks in history — skip.
            // (transformMessages already downgraded cross-model thinking to text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.join('') || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      }
    } else if (msg.role === 'tool') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      result.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id || '',
        content,
      });
    }
  }

  return result;
}

// =============================================================================
// Event helpers
// =============================================================================

/**
 * Append a thinking delta to the assistant message. Consecutive thinking
 * deltas are merged into the same block. The signature records which wire
 * field produced the thinking (e.g. 'reasoning_content', 'reasoning',
 * 'think-tag') so consumers can distinguish sources.
 */
function appendThinking(
  msg: AssistantMessage,
  text: string,
  signature: string,
): AssistantMessageEvent {
  const last = msg.content[msg.content.length - 1];
  let contentIndex = msg.content.length - 1;
  if (!last || last.type !== 'thinking') {
    msg.content.push({ type: 'thinking', thinking: '', thinkingSignature: signature });
    contentIndex = msg.content.length - 1;
  }
  const block = msg.content[contentIndex];
  if (block.type === 'thinking') {
    block.thinking += text;
    block.thinkingSignature = signature;
  }
  return { type: 'thinking_delta', contentIndex, delta: text, partial: msg };
}

/** Append a text delta to the assistant message, merging into the last text block. */
function appendText(msg: AssistantMessage, text: string): AssistantMessageEvent {
  const last = msg.content[msg.content.length - 1];
  let contentIndex = msg.content.length - 1;
  if (!last || last.type !== 'text') {
    msg.content.push({ type: 'text', text: '' });
    contentIndex = msg.content.length - 1;
  }
  const block = msg.content[contentIndex];
  if (block.type === 'text') {
    block.text += text;
  }
  return { type: 'text_delta', contentIndex, delta: text, partial: msg };
}

/**
 * Append a tool call delta to the assistant message. OpenAI streams
 * tool_calls with an `index` field that identifies which tool call the
 * delta belongs to (not the content index). We maintain a Map from
 * OpenAI index → content index in assistantMsg.content.
 *
 * Returns null if the delta carries no useful information (shouldn't happen
 * in practice, but keeps the call site clean).
 */
function appendToolCall(
  msg: AssistantMessage,
  delta: OpenAIToolCallDelta,
  indexMap: Map<number, number>,
): AssistantMessageEvent | null {
  const toolCallIdx = delta.index ?? 0;
  const existingContentIdx = indexMap.get(toolCallIdx);

  if (existingContentIdx === undefined) {
    // New tool call — push a new tool_use block.
    const newBlock: ToolUseContent = {
      type: 'tool_use',
      id: delta.id ?? '',
      name: delta.function?.name ?? '',
      input: {},
    };
    msg.content.push(newBlock);
    const contentIndex = msg.content.length - 1;
    indexMap.set(toolCallIdx, contentIndex);
    // Initialize raw input accumulator (parsed at finalizeToolCalls).
    (newBlock as ToolUseWithRaw)._rawInput = '';
    return { type: 'toolcall_start', contentIndex, partial: msg };
  }

  // Accumulate JSON arguments on the existing block.
  const block = msg.content[existingContentIdx];
  if (block.type === 'tool_use') {
    const raw = (block as ToolUseWithRaw)._rawInput || '';
    const newArgs = delta.function?.arguments ?? '';
    (block as ToolUseWithRaw)._rawInput = raw + newArgs;
    return {
      type: 'toolcall_delta',
      contentIndex: existingContentIdx,
      delta: newArgs,
      partial: msg,
    };
  }
  return null;
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
// Finish reason mapping
// =============================================================================

function mapFinishReason(reason: string): AssistantMessage['stopReason'] {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_turns';
    case 'content_filter': return 'error';
    default: return 'completed';
  }
}

// =============================================================================
// Client factory
// =============================================================================

/**
 * Build an AIClient backed by the OpenAI Chat Completions API.
 *
 * The returned client implements the AIClient interface from types.ts:
 * - streamChat yields SSEEvent and returns the final AssistantMessage.
 * - chat performs a non-streaming request and returns { content, usage }.
 */
export function createOpenAICompletionsClient(options: AIClientOptions): AIClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.headers,
  });

  return {
    async *streamChat(messages, chatOptions) {
      // 1. Build model from options + capabilities.
      const model: Model<'openai-chat'> = {
        id: options.model,
        name: options.model,
        api: 'openai-chat',
        providerId: options.providerId,
        baseUrl: options.baseURL,
        reasoning: !!options.modelCapabilities?.openAIThinkingFormat,
        compat: options.modelCapabilities,
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 4096,
      };

      // 2. Transform messages (isSameModel guard — downgrades cross-model
      //    thinking to plain text and discards signatures).
      const transformed = transformMessages(messages, model);

      // 3. Convert to OpenAI format.
      const openaiMessages = toOpenAIMessages(transformed);

      // Add system message if provided.
      if (chatOptions?.systemPrompt) {
        openaiMessages.unshift({ role: 'system', content: chatOptions.systemPrompt });
      }

      // 4. Resolve thinking params from model + effort.
      const thinkingParams = resolveOpenAIThinking(model, chatOptions?.effort);

      // 5. Setup think-tag parser if format requires it.
      const useThinkTagParser = model.compat?.openAIThinkingFormat === 'think-tag-fallback';
      const thinkParser = useThinkTagParser ? new ThinkTagParser() : null;

      // 6. Build request params.
      // totalOutputBudget takes precedence. For OpenAI, max_tokens (or
      // max_completion_tokens for reasoning models) is the total output budget.
      // reasoningBudget is intentionally not used here: OpenAI's reasoning_effort
      // controls the reasoning budget implicitly.
      const maxTokens = chatOptions?.totalOutputBudget
        ?? chatOptions?.maxOutputTokens
        ?? chatOptions?.maxTokens
        ?? 4096;
      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: options.model,
        messages: openaiMessages,
        max_tokens: maxTokens,
        temperature: chatOptions?.temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(chatOptions?.tools?.length
          ? {
              tools: chatOptions.tools.map(t => ({
                type: 'function' as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.input_schema,
                },
              })),
            }
          : {}),
        ...thinkingParams,
      };

      // 7. Initialize assistant message accumulator.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: 'openai-chat',
        providerId: options.providerId,
        model: options.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: 'completed',
        timestamp: Date.now(),
      };

      // Map OpenAI tool_call index → contentIndex in assistantMsg.content.
      const toolCallIndexMap = new Map<number, number>();

      // 7.5. Emit parameter diagnostics before the stream starts.
      const diagnostics = collectDiagnostics(model, {
        effort: chatOptions?.effort,
        temperature: chatOptions?.temperature,
        maxOutputTokens: chatOptions?.maxOutputTokens,
        reasoningBudget: chatOptions?.reasoningBudget,
        totalOutputBudget: chatOptions?.totalOutputBudget,
      });
      for (const diag of diagnostics) {
        yield {
          type: 'system',
          data: diag.message,
          metadata: { diagnostic: diag },
        };
      }

      // 8. Open the stream. Cast to AsyncIterable to satisfy TS — the SDK
      //    return type depends on the `stream` literal, which we set above.
      const stream = await client.chat.completions.create(
        params,
        chatOptions?.signal ? { signal: chatOptions.signal } : undefined,
      ) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      // 9. Drain chunks.
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        // Some chunks only carry usage (no choices) — capture and continue.
        if (!choice) {
          if (chunk.usage) {
            assistantMsg.usage = {
              input_tokens: chunk.usage.prompt_tokens || 0,
              output_tokens: chunk.usage.completion_tokens || 0,
            };
          }
          continue;
        }

        const delta = choice.delta;
        if (delta) {
          // 9a. reasoning_content / reasoning / reasoning_text → thinking_delta.
          //     Use string type guard to avoid SDK type errors on providers
          //     that send non-string reasoning fields.
          const reasoningFields = ['reasoning_content', 'reasoning', 'reasoning_text'];
          for (const field of reasoningFields) {
            const reasoningText = (delta as unknown as Record<string, unknown>)[field];
            if (typeof reasoningText === 'string' && reasoningText.length > 0) {
              const internalEvent = appendThinking(assistantMsg, reasoningText, field);
              const sse = emitSSE(internalEvent);
              if (sse) yield sse;
            }
          }

          // 9b. content field → text_delta (or think-tag parsing).
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (thinkParser) {
              const { thinking, text } = thinkParser.feed(delta.content);
              if (thinking) {
                const internalEvent = appendThinking(assistantMsg, thinking, 'think-tag');
                const sse = emitSSE(internalEvent);
                if (sse) yield sse;
              }
              if (text) {
                const internalEvent = appendText(assistantMsg, text);
                const sse = emitSSE(internalEvent);
                if (sse) yield sse;
              }
            } else {
              const internalEvent = appendText(assistantMsg, delta.content);
              const sse = emitSSE(internalEvent);
              if (sse) yield sse;
            }
          }

          // 9c. tool_calls → toolcall_start/delta.
          if (delta.tool_calls) {
            for (const toolCallDelta of delta.tool_calls) {
              const internalEvent = appendToolCall(
                assistantMsg,
                toolCallDelta as OpenAIToolCallDelta,
                toolCallIndexMap,
              );
              if (internalEvent) {
                const sse = emitSSE(internalEvent);
                if (sse) yield sse;
              }
            }
          }
        }

        // 9d. Track usage if present (final chunk carries it).
        if (chunk.usage) {
          assistantMsg.usage = {
            input_tokens: chunk.usage.prompt_tokens || 0,
            output_tokens: chunk.usage.completion_tokens || 0,
          };
        }

        // 9e. Map finish reason.
        if (choice.finish_reason) {
          assistantMsg.stopReason = mapFinishReason(choice.finish_reason);
        }
      }

      // 10. Finalize tool calls — parse accumulated JSON strings.
      finalizeToolCalls(assistantMsg);

      // 11. Flush think-tag parser if active (emit any remaining buffer).
      if (thinkParser) {
        const { thinking, text } = thinkParser.flush();
        if (thinking) {
          const internalEvent = appendThinking(assistantMsg, thinking, 'think-tag');
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
        if (text) {
          const internalEvent = appendText(assistantMsg, text);
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
      }

      // 12. Yield final result event with token usage (if captured).
      if (assistantMsg.usage) {
        yield { type: 'result', data: assistantMsg.usage };
      }

      return assistantMsg;
    },

    async chat(messages, chatOptions) {
      const openaiMessages = toOpenAIMessages(messages);
      if (chatOptions?.systemPrompt) {
        openaiMessages.unshift({ role: 'system', content: chatOptions.systemPrompt });
      }
      const response = await client.chat.completions.create({
        model: options.model,
        messages: openaiMessages,
        max_tokens: chatOptions?.maxTokens ?? 1024,
        temperature: chatOptions?.temperature ?? 1,
      });
      return {
        content: response.choices[0]?.message?.content ?? '',
        usage: response.usage ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
        } : undefined,
      };
    },
  };
}
