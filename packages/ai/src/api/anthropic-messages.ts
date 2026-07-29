/**
 * packages/ai/src/api/anthropic-messages.ts
 *
 * Anthropic Messages API implementation.
 * Migrated from packages/agent/src/llm/anthropic-client.ts.
 *
 * Key changes (spec §8.1):
 * - isMiniMax → model.compat?.forceAdaptiveThinking
 * - BUDGET_BY_EFFORT → resolveAnthropicThinking(model, effort)
 * - thinking signature → ThinkingContent.thinkingSignature
 * - yield SSEEvent, return AssistantMessage
 *
 * Utility functions (mergeConsecutiveRoles, stripOrphanToolUses,
 * stripOrphanToolResults) are COPIED from anthropic-client.ts to avoid
 * a circular dependency on @duya/agent.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type {
  AIClient, AIClientOptions, AssistantMessage, AssistantMessageEvent,
  Message, MessageContent, Model, SSEEvent,
  TextContent, ThinkingContent, ToolUseContent, TokenUsage,
} from '../types.js';
import { transformMessages } from './transform-messages.js';
import { emitSSE } from './emit-sse.js';

// =============================================================================
// Constants
// =============================================================================

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

// =============================================================================
// Utility functions (copied from anthropic-client.ts)
// =============================================================================

/**
 * Enforce strict role alternation by merging consecutive same-role messages.
 * Anthropic API rejects consecutive messages with the same role.
 * - Consecutive user messages: merge content
 * - Consecutive assistant messages: drop thinking blocks from the second
 *   (signatures become invalid when merged), then merge remaining content
 *
 * Copied verbatim from packages/agent/src/llm/anthropic-client.ts.
 */
function mergeConsecutiveRoles(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const m of messages) {
    if (result.length > 0 && result[result.length - 1].role === m.role) {
      const prev = result[result.length - 1];
      const prevContent = prev.content;
      const currContent = m.content;

      if (m.role === 'user') {
        // Merge consecutive user messages
        if (typeof prevContent === 'string' && typeof currContent === 'string') {
          prev.content = prevContent + '\n' + currContent;
        } else if (Array.isArray(prevContent) && Array.isArray(currContent)) {
          prev.content = [...prevContent, ...currContent];
        } else {
          // Mixed types — normalize strings to text blocks
          const normalizedPrev = typeof prevContent === 'string'
            ? [{ type: 'text' as const, text: prevContent }]
            : prevContent;
          const normalizedCurr = typeof currContent === 'string'
            ? [{ type: 'text' as const, text: currContent }]
            : currContent;
          prev.content = [...normalizedPrev, ...normalizedCurr];
        }
      } else {
        // m.role === 'assistant' — merge, dropping thinking blocks from second message
        if (Array.isArray(currContent)) {
          // Strip thinking/redacted_thinking from the second assistant message
          const filteredCurr = currContent.filter(b => {
            if (typeof b !== 'object' || b === null) return true;
            return !THINKING_TYPES.has((b as { type?: string }).type || '');
          });
          m.content = filteredCurr.length > 0 ? filteredCurr : [{ type: 'text', text: '(empty)' }];
        }

        if (typeof prevContent === 'string' && typeof currContent === 'string') {
          prev.content = prevContent + '\n' + currContent;
        } else if (Array.isArray(prevContent) && Array.isArray(currContent)) {
          prev.content = [...prevContent, ...currContent];
        } else {
          // Mixed types
          const normalizedPrev = typeof prevContent === 'string'
            ? [{ type: 'text' as const, text: prevContent }]
            : prevContent;
          const normalizedCurr = typeof currContent === 'string'
            ? [{ type: 'text' as const, text: currContent }]
            : currContent;
          prev.content = [...normalizedPrev, ...normalizedCurr];
        }
      }
    } else {
      result.push(m);
    }
  }

  return result;
}

/**
 * Remove orphaned tool_use blocks (no matching tool_result follows).
 * Context compression or session truncation can remove tool_result messages
 * while leaving their corresponding tool_use. Anthropic rejects these with 400.
 *
 * Copied verbatim from packages/agent/src/llm/anthropic-client.ts.
 */
function stripOrphanToolUses(messages: MessageParam[]): MessageParam[] {
  // Collect all tool_use IDs that have matching tool_results
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result') {
          toolResultIds.add((block as { tool_use_id?: string }).tool_use_id || '');
        }
      }
    }
  }

  // Remove tool_use blocks without matching tool_results
  return messages.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const filtered = m.content.filter(b => {
        if (typeof b !== 'object' || b === null) return true;
        if ((b as { type?: string }).type !== 'tool_use') return true;
        const id = (b as { id?: string }).id || '';
        return toolResultIds.has(id);
      });
      if (filtered.length === 0) {
        return { ...m, content: [{ type: 'text', text: '(tool call removed)' }] };
      }
      return { ...m, content: filtered };
    }
    return m;
  });
}

/**
 * Remove orphaned tool_result blocks (no matching tool_use precedes them).
 * This is the mirror of stripOrphanToolUses.
 *
 * Copied verbatim from packages/agent/src/llm/anthropic-client.ts.
 */
function stripOrphanToolResults(messages: MessageParam[]): MessageParam[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
          toolUseIds.add((block as { id?: string }).id || '');
        }
      }
    }
  }

  // Remove tool_result blocks without matching tool_uses
  return messages.map(m => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const filtered = m.content.filter(b => {
        if (typeof b !== 'object' || b === null) return true;
        if ((b as { type?: string }).type !== 'tool_result') return true;
        const toolUseId = (b as { tool_use_id?: string }).tool_use_id || '';
        return toolUseIds.has(toolUseId);
      });
      if (filtered.length === 0) {
        return { ...m, content: [{ type: 'text', text: '(tool result removed)' }] };
      }
      return { ...m, content: filtered };
    }
    return m;
  });
}

// =============================================================================
// Thinking resolver
// =============================================================================

/**
 * Resolve the Anthropic `thinking` parameter from model capabilities and
 * user-requested effort level.
 *
 * - Non-reasoning models → undefined (thinking disabled).
 * - effort 'off' / undefined → undefined (provider default).
 * - model.compat?.forceAdaptiveThinking → { type: 'adaptive' } (MiniMax shape).
 * - Otherwise → { type: 'enabled', budget_tokens } capped at 80% of maxTokens.
 */
export function resolveAnthropicThinking(
  model: Model<'anthropic'>,
  effort?: string,
): { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' } | undefined {
  if (!model.reasoning) return undefined;
  if (effort === undefined || effort === 'off') return undefined;

  // MiniMax M3 and similar third-party endpoints accept only the adaptive shape.
  if (model.compat?.forceAdaptiveThinking) {
    return { type: 'adaptive' };
  }

  // Budget mapping (from existing BUDGET_BY_EFFORT in anthropic-client.ts).
  // Extended with 'minimal' and 'xhigh' to match the ThinkingLevel union.
  const BUDGET: Record<string, number> = {
    minimal: 1024,
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 24576,
    max: 32000,
  };

  const budget = BUDGET[effort];
  if (!budget) return undefined;

  // Clamp budget to maxTokens - 1 to satisfy API constraint
  // `max_tokens > budget_tokens`.
  const maxBudget = model.maxTokens - 1;
  return { type: 'enabled', budget_tokens: Math.min(budget, maxBudget) };
}

// =============================================================================
// Event parser
// =============================================================================

/**
 * Parse an Anthropic MessageStreamEvent into an internal AssistantMessageEvent,
 * mutating the given assistantMsg in place to accumulate content blocks and
 * usage.
 *
 * Migrated from the streamChat event loop in anthropic-client.ts (lines
 * ~1473-1699). The original loop tracked several agent-specific concerns
 * (tool preview signatures, pre-tool thinking extraction, MiniMax <think>
 * tag parsing, idle timeout) that belong in the agent layer, not here.
 * This implementation performs the pure protocol→AssistantMessage mapping.
 */
function parseAnthropicEvent(
  event: Anthropic.MessageStreamEvent,
  assistantMsg: AssistantMessage,
  state: { currentBlockIdx: number },
): AssistantMessageEvent {
  switch (event.type) {
    case 'message_start': {
      const msg = event.message;
      assistantMsg.responseId = msg.id;
      if (msg.usage) {
        const u = msg.usage as unknown as Record<string, number | undefined>;
        assistantMsg.usage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_hit_tokens: u.cache_read_input_tokens,
          cache_creation_tokens: u.cache_creation_input_tokens,
        };
      }
      return { type: 'start', partial: assistantMsg };
    }

    case 'content_block_start': {
      const block = event.content_block;
      state.currentBlockIdx = assistantMsg.content.length;

      if (block.type === 'thinking') {
        const thinkingBlock: ThinkingContent = {
          type: 'thinking',
          thinking: '',
          thinkingSignature: '',
        };
        assistantMsg.content.push(thinkingBlock);
        return { type: 'thinking_start', contentIndex: state.currentBlockIdx, partial: assistantMsg };
      }
      if (block.type === 'redacted_thinking') {
        const thinkingBlock: ThinkingContent = {
          type: 'thinking',
          thinking: '',
          thinkingSignature: '',
          redacted: true,
        };
        assistantMsg.content.push(thinkingBlock);
        return { type: 'thinking_start', contentIndex: state.currentBlockIdx, partial: assistantMsg };
      }
      if (block.type === 'text') {
        const textBlock: TextContent = { type: 'text', text: '' };
        assistantMsg.content.push(textBlock);
        return { type: 'text_start', contentIndex: state.currentBlockIdx, partial: assistantMsg };
      }
      if (block.type === 'tool_use') {
        const toolBlock: ToolUseContent = {
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: {},
        };
        assistantMsg.content.push(toolBlock);
        return { type: 'toolcall_start', contentIndex: state.currentBlockIdx, partial: assistantMsg };
      }
      return { type: 'start', partial: assistantMsg };
    }

    case 'content_block_delta': {
      const delta = event.delta;
      const block = assistantMsg.content[state.currentBlockIdx];

      if (delta.type === 'thinking_delta') {
        if (block && block.type === 'thinking') {
          block.thinking += delta.thinking;
          return { type: 'thinking_delta', contentIndex: state.currentBlockIdx, delta: delta.thinking, partial: assistantMsg };
        }
      } else if (delta.type === 'signature_delta') {
        if (block && block.type === 'thinking') {
          block.thinkingSignature = (block.thinkingSignature || '') + delta.signature;
          return { type: 'thinking_delta', contentIndex: state.currentBlockIdx, delta: '', partial: assistantMsg };
        }
      } else if (delta.type === 'text_delta') {
        if (block && block.type === 'text') {
          const textDelta = typeof delta.text === 'string' ? delta.text : String(delta.text);
          block.text += textDelta;
          return { type: 'text_delta', contentIndex: state.currentBlockIdx, delta: textDelta, partial: assistantMsg };
        }
      } else if (delta.type === 'input_json_delta') {
        if (block && block.type === 'tool_use') {
          // Accumulate JSON string; parse at content_block_stop.
          const partial = typeof delta.partial_json === 'string'
            ? delta.partial_json
            : String(delta.partial_json);
          (block as ToolUseContent & { _rawInput?: string })._rawInput =
            ((block as ToolUseContent & { _rawInput?: string })._rawInput || '') + partial;
          return { type: 'toolcall_delta', contentIndex: state.currentBlockIdx, delta: partial, partial: assistantMsg };
        }
      }
      return { type: 'start', partial: assistantMsg };
    }

    case 'content_block_stop': {
      const block = assistantMsg.content[state.currentBlockIdx];
      // Parse accumulated JSON for tool_use blocks.
      if (block && block.type === 'tool_use') {
        const raw = (block as ToolUseContent & { _rawInput?: string })._rawInput;
        if (raw) {
          try {
            block.input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            block.input = {};
          }
          delete (block as ToolUseContent & { _rawInput?: string })._rawInput;
        }
        return { type: 'toolcall_end', contentIndex: state.currentBlockIdx, toolCall: block, partial: assistantMsg };
      }
      if (block && block.type === 'text') {
        return { type: 'text_end', contentIndex: state.currentBlockIdx, content: block.text, partial: assistantMsg };
      }
      if (block && block.type === 'thinking') {
        return { type: 'thinking_end', contentIndex: state.currentBlockIdx, content: block.thinking, partial: assistantMsg };
      }
      return { type: 'start', partial: assistantMsg };
    }

    case 'message_delta': {
      const delta = event.delta as { stop_reason?: string };
      if (delta.stop_reason) {
        assistantMsg.stopReason = delta.stop_reason as AssistantMessage['stopReason'];
      }
      if (event.usage) {
        const u = event.usage as unknown as Record<string, number | undefined>;
        const prev = assistantMsg.usage;
        assistantMsg.usage = {
          input_tokens: prev?.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? prev?.output_tokens ?? 0,
          cache_hit_tokens: u.cache_read_input_tokens ?? prev?.cache_hit_tokens,
          cache_creation_tokens: u.cache_creation_input_tokens ?? prev?.cache_creation_tokens,
        };
      }
      return { type: 'done', reason: (delta.stop_reason as AssistantMessage['stopReason']) || 'completed', message: assistantMsg };
    }

    case 'message_stop':
      return { type: 'done', reason: assistantMsg.stopReason || 'completed', message: assistantMsg };

    default:
      return { type: 'start', partial: assistantMsg };
  }
}

// =============================================================================
// Message conversion (simplified from toAnthropicMessages)
// =============================================================================

/**
 * Convert duya Message[] to Anthropic MessageParam[].
 *
 * This is a SIMPLIFIED version of toAnthropicMessages from
 * anthropic-client.ts. It skips the complex recovery logic (duplicate ID
 * renaming, tool reordering, synthesizeMissingToolResults) and the
 * handleThinkingBlocks pass (cross-model thinking downgrade is already
 * handled by transformMessages before this function runs).
 *
 * Pipeline:
 * 1. Convert each Message to MessageParam (string content → string, array
 *    content → ContentBlockParam[]).
 * 2. stripOrphanToolUses — drop tool_use with no matching tool_result.
 * 3. stripOrphanToolResults — drop tool_result with no matching tool_use.
 * 4. mergeConsecutiveRoles — enforce strict role alternation.
 */
function toAnthropicMessages(
  messages: Message[],
  _model: Model<'anthropic'>,
): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // System goes in the `system` param.

    if (msg.role === 'tool') {
      // Standalone tool message → wrap as user/tool_result.
      const toolContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: toolContent,
        } as ContentBlockParam],
      });
      continue;
    }

    const content: ContentBlockParam[] = [];

    if (typeof msg.content === 'string') {
      // Plain string content — preserve as a single text block. Empty strings
      // are dropped at the merge step if adjacent to another message.
      content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const converted = convertContentBlock(block);
        if (converted) content.push(converted);
      }
    }

    if (content.length > 0) {
      result.push({ role: msg.role as 'user' | 'assistant', content });
    } else if (msg.role === 'user') {
      // Preserve empty user turns so the request never has zero messages.
      result.push({ role: 'user', content: '' });
    }
  }

  // Apply utility functions (copied from anthropic-client.ts). Order matters:
  // orphan cleanup must run before role merging so the merged content is
  // consistent.
  return mergeConsecutiveRoles(
    stripOrphanToolResults(stripOrphanToolUses(result)),
  );
}

/**
 * Convert a single duya MessageContent block to an Anthropic ContentBlockParam.
 * Returns null for blocks that should be filtered out (e.g. tool_result in
 * an assistant message — only valid inside user messages).
 */
function convertContentBlock(block: MessageContent): ContentBlockParam | null {
  if (block.type === 'text') {
    return { type: 'text', text: block.text } as ContentBlockParam;
  }
  if (block.type === 'image') {
    if (block.source.type === 'base64') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: block.source.data,
        },
      } as ContentBlockParam;
    }
    // url source
    return {
      type: 'image',
      source: {
        type: 'url',
        url: block.source.data,
      },
    } as ContentBlockParam;
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    } as ContentBlockParam;
  }
  if (block.type === 'tool_result') {
    // tool_result is only valid inside user messages. When the duya Message
    // stores it directly (rather than as a standalone tool-role message),
    // emit the Anthropic tool_result block.
    const resultContent: string | ContentBlockParam[] = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map(c => {
            if (c.type === 'text') return { type: 'text', text: c.text } as ContentBlockParam;
            return { type: 'text', text: JSON.stringify(c) } as ContentBlockParam;
          })
        : '';
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: resultContent,
      is_error: block.is_error,
    } as unknown as ContentBlockParam;
  }
  if (block.type === 'thinking') {
    // Include signed thinking blocks for same-model replay. Unsigned thinking
    // is already downgraded to text by transformMessages, so we only keep
    // blocks that carry a signature here.
    if (block.thinkingSignature) {
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.thinkingSignature,
      } as ContentBlockParam;
    }
    // Redacted thinking is represented by a redacted_thinking block; if it
    // has no signature it cannot be validated, so drop it.
    return null;
  }
  return null;
}

// =============================================================================
// Client factory
// =============================================================================

/**
 * Build an AIClient backed by the Anthropic Messages API.
 *
 * The returned client implements the AIClient interface from types.ts:
 * - streamChat yields SSEEvent and returns the final AssistantMessage.
 * - chat performs a non-streaming request and returns { content, usage }.
 */
export function createAnthropicClient(options: AIClientOptions): AIClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    authToken: options.authStyle === 'auth_token' ? options.apiKey : undefined,
    defaultHeaders: options.headers,
  });

  return {
    async *streamChat(messages, chatOptions) {
      // 1. Build model from options + capabilities.
      const model: Model<'anthropic'> = {
        id: options.model,
        name: options.model,
        api: 'anthropic',
        providerId: options.providerId,
        baseUrl: options.baseURL,
        reasoning: true,
        thinkingLevelMap: options.modelCapabilities?.forceAdaptiveThinking
          ? { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }
          : undefined,
        compat: options.modelCapabilities,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 8192,
      };

      // 2. Transform messages (isSameModel guard — downgrades cross-model
      // thinking to plain text and discards signatures).
      const transformed = transformMessages(messages, model);

      // 3. Convert to Anthropic MessageParam[] format.
      const anthropicMessages = toAnthropicMessages(transformed, model);

      // 4. Resolve thinking config from model + effort.
      // totalOutputBudget takes precedence over maxOutputTokens/maxTokens.
      // For Anthropic, max_tokens is the TOTAL output (thinking + text).
      const maxTokens = chatOptions?.totalOutputBudget
        ?? chatOptions?.maxOutputTokens
        ?? chatOptions?.maxTokens
        ?? 4096;

      let thinking = resolveAnthropicThinking(model, chatOptions?.effort);

      // Override budget_tokens if reasoningBudget is explicitly set.
      // For Anthropic, thinking.budget_tokens must be < max_tokens.
      if (thinking && chatOptions?.reasoningBudget && thinking.type === 'enabled') {
        const clampedBudget = Math.min(chatOptions.reasoningBudget, maxTokens - 1);
        thinking = { ...thinking, budget_tokens: clampedBudget };
      }

      // 5. Build request params.
      const params: Anthropic.MessageCreateParams = {
        model: options.model,
        max_tokens: maxTokens,
        temperature: chatOptions?.temperature ?? 1,
        system: chatOptions?.systemPrompt || '',
        messages: anthropicMessages,
        tools: chatOptions?.tools?.length
          ? chatOptions.tools.map(t => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            }))
          : undefined,
        ...(thinking ? { thinking } : {}),
        stream: true,
      };

      // 6. Initialize assistant message accumulator.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: 'anthropic',
        providerId: options.providerId,
        model: options.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: 'completed',
        timestamp: Date.now(),
      };
      const state = { currentBlockIdx: -1 };

      // 7. Open the stream.
      const stream = await client.messages.stream(
        params,
        chatOptions?.signal ? { signal: chatOptions.signal } : undefined,
      );

      // 8. Drain events, parse, and yield SSE.
      let finalUsage: TokenUsage | undefined;
      for await (const event of stream) {
        const internalEvent = parseAnthropicEvent(event, assistantMsg, state);
        if (internalEvent.type === 'done' && internalEvent.message.usage) {
          finalUsage = internalEvent.message.usage;
        }
        const sse = emitSSE(internalEvent);
        if (sse) yield sse;
      }

      // 9. Yield the final result event (token usage) if we captured one.
      if (finalUsage) {
        yield { type: 'result', data: finalUsage };
      }

      return assistantMsg;
    },

    async chat(messages, chatOptions) {
      // Build a non-reasoning model for the conversion path (chat() does not
      // pass effort, so thinking is never enabled here).
      const model: Model<'anthropic'> = {
        id: options.model,
        name: options.model,
        api: 'anthropic',
        providerId: options.providerId,
        baseUrl: options.baseURL,
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 8192,
      };

      const response = await client.messages.create({
        model: options.model,
        max_tokens: chatOptions?.maxTokens ?? 1024,
        temperature: chatOptions?.temperature ?? 1,
        system: chatOptions?.systemPrompt || '',
        messages: toAnthropicMessages(messages, model),
      });

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      const usage = response.usage as unknown as Record<string, number | undefined> | undefined;
      return {
        content,
        usage: usage
          ? {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
              cache_hit_tokens: usage.cache_read_input_tokens,
              cache_creation_tokens: usage.cache_creation_input_tokens,
            }
          : undefined,
      };
    },
  };
}
