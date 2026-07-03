/**
 * Anthropic protocol LLM client
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../types.js';
import type { SSEEvent, Tool, Message, MessageContent, TextContent, ImageContent, ToolUseContent, ToolResultContent, TokenUsage } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { logger } from '../utils/logger.js';
import { checkCacheEligibility, applyCacheControl, type CacheRetention } from './prompt-caching.js';
import { normalizeUsage, type NormalizedUsage } from './usage.js';
import { CacheMonitor } from '../observability/cache-monitor.js';
import { isCDNImageUrl } from '../utils/urlSafety.js';


// =============================================================================
// Message Conversion Utilities
// =============================================================================

/** Valid ID characters for Anthropic API: alphanumeric, underscore, hyphen */
const VALID_ID_REGEX = /[^a-zA-Z0-9_-]/g;
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 204_800;
const MINIMAX_M3_CONTEXT_WINDOW = 1_000_000;

/**
 * Sanitize a tool call ID for the Anthropic API.
 * Anthropic requires IDs matching [a-zA-Z0-9_-]. Replace invalid
 * characters with underscores. If the result is empty (which happens
 * when the source ID is missing, empty, or contains only invalid
 * characters), synthesize a deterministic unique ID so that two
 * different empty IDs never collapse to the same string.
 *
 * The `synthCounter` is an in-process counter that disambiguates
 * synthetic IDs across the same conversion pass. Callers should
 * monotonically increase it (e.g. ++counter) for each empty-ID block
 * they encounter — the resulting `tool_synth_<n>` value is unique
 * per call and stable across re-runs on the same input.
 */
function sanitizeToolId(toolId: string, synthCounter: number): string {
  const cleaned = (toolId || '').replace(VALID_ID_REGEX, '_');
  if (cleaned) {
    return cleaned;
  }
  // Empty / missing / entirely-invalid ID. Synthesize a unique one so
  // that two parallel tool calls with empty IDs don't collide on the
  // same string (which would trigger Anthropic 2013 "tool call result
  // does not follow tool call" because two tool_use_id values would
  // point at the same logical call).
  return `tool_synth_${synthCounter.toString(36)}`;
}

/**
 * Check if a base URL represents a third-party Anthropic-compatible endpoint.
 * Third-party proxies (MiniMax, Azure, etc.) cannot validate Anthropic
 * thinking signatures and require special handling.
 */
function isThirdPartyEndpoint(baseURL?: string): boolean {
  if (!baseURL) {
    return false; // Direct Anthropic API
  }
  const normalized = baseURL.replace(/\/$/, '').toLowerCase();
  if (normalized.includes('anthropic.com')) {
    return false; // Direct Anthropic API
  }
  return true; // Any other endpoint is third-party
}

/**
 * Check if a base URL is a MiniMax Anthropic-compatible endpoint.
 * MiniMax requires Bearer auth and specific handling.
 */
function isMiniMaxEndpoint(baseURL?: string): boolean {
  if (!baseURL) {
    return false;
  }
  const normalized = baseURL.replace(/\/$/, '').toLowerCase();
  return (
    normalized.startsWith('https://api.minimax.io/anthropic') ||
    normalized.startsWith('https://api.minimaxi.com/anthropic')
  );
}

export function getMiniMaxAnthropicMaxTokens(model: string, configuredContextWindow?: number): number {
  if (typeof configuredContextWindow === 'number' && configuredContextWindow > 0) {
    return configuredContextWindow;
  }

  const normalizedModel = model.trim().toLowerCase();
  if (normalizedModel === 'minimax-m3') {
    return MINIMAX_M3_CONTEXT_WINDOW;
  }
  if (normalizedModel.startsWith('minimax-m')) {
    return MINIMAX_DEFAULT_CONTEXT_WINDOW;
  }

  return MINIMAX_DEFAULT_CONTEXT_WINDOW;
}

export function extractAnthropicThinkingDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') {
    return '';
  }

  const record = delta as Record<string, unknown>;
  const value =
    record.thinking ??
    record.reasoning_content ??
    record.reasoning ??
    record.text ??
    record.content;

  return typeof value === 'string' ? value : '';
}

/**
 * Enforce strict role alternation by merging consecutive same-role messages.
 * Anthropic API rejects consecutive messages with the same role.
 * - Consecutive user messages: merge content
 * - Consecutive assistant messages: drop thinking blocks from the second
 *   (signatures become invalid when merged), then merge remaining content
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

/**
 * Handle thinking blocks according to endpoint type:
 * - Third-party (MiniMax, etc.): strip ALL thinking blocks (can't validate signatures)
 * - Direct Anthropic, non-last assistant: strip ALL thinking blocks
 * - Direct Anthropic, last assistant: keep signed thinking, downgrade unsigned to text
 * - Strip cache_control from remaining thinking blocks
 */
function handleThinkingBlocks(
  messages: MessageParam[],
  baseURL?: string
): MessageParam[] {
  const isThirdParty = isThirdPartyEndpoint(baseURL);

  // Find the index of the last assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((m, idx) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) {
      return m;
    }

    let newContent: ContentBlockParam[];

    if (isThirdParty) {
      // Third-party: strip ALL thinking blocks
      newContent = m.content.filter(b => {
        if (typeof b !== 'object' || b === null) return true;
        return !THINKING_TYPES.has((b as { type?: string }).type || '');
      });
    } else if (idx !== lastAssistantIdx) {
      // Direct Anthropic, non-last assistant: strip ALL thinking blocks
      newContent = m.content.filter(b => {
        if (typeof b !== 'object' || b === null) return true;
        return !THINKING_TYPES.has((b as { type?: string }).type || '');
      });
    } else {
      // Direct Anthropic, last assistant: selective handling
      newContent = [];
      for (const b of m.content) {
        if (typeof b !== 'object' || b === null) {
          newContent.push(b as ContentBlockParam);
          continue;
        }
        const blockType = (b as { type?: string }).type || '';
        if (!THINKING_TYPES.has(blockType)) {
          newContent.push(b as ContentBlockParam);
          continue;
        }
        // Handle thinking/redacted_thinking blocks
        if (blockType === 'redacted_thinking') {
          // Keep redacted_thinking only if it has a signature (data field)
          if ((b as { data?: unknown }).data) {
            newContent.push(b as ContentBlockParam);
          }
          // else: drop — no data means it can't be validated
        } else if ((b as { signature?: unknown }).signature) {
          // Signed thinking block — keep it
          newContent.push(b as ContentBlockParam);
        } else {
          // Unsigned thinking — downgrade to text so it's not lost
          const thinkingText = (b as { thinking?: string }).thinking || '';
          if (thinkingText) {
            newContent.push({ type: 'text', text: thinkingText } as ContentBlockParam);
          }
        }
      }
    }

    if (newContent.length === 0) {
      newContent = [{ type: 'text', text: '(empty)' } as ContentBlockParam];
    }

    // Strip cache_control from any remaining thinking/redacted_thinking blocks
    for (const b of newContent) {
      if (typeof b === 'object' && b !== null && THINKING_TYPES.has((b as { type?: string }).type || '')) {
        delete (b as { cache_control?: unknown }).cache_control;
      }
    }

    return { ...m, content: newContent };
  });
}

/**
 * Convert duya Message[] to Anthropic MessageParam[]
 *
 * Implements hermes-agent equivalent logic with the following pipeline:
 * 1. Convert all messages to Anthropic format, sanitizing tool IDs
 * 2. Strip orphaned tool_use blocks (no matching tool_result)
 * 3. Strip orphaned tool_result blocks (no matching tool_use)
 * 4. Merge consecutive same-role messages
 * 5. Handle thinking blocks according to endpoint type
 *
 * @param messages - The messages to convert
 * @param baseURL - The API base URL (used to detect third-party endpoints)
 */
function toAnthropicMessages(messages: Message[], baseURL?: string): MessageParam[] {
  // Step 1: Convert all messages to Anthropic format, sanitizing tool IDs.
  //
  // We thread a per-conversion-pass counter so that any empty/invalid
  // tool_use or tool_result ID resolves to a unique synthetic string
  // (e.g. `tool_synth_1`, `tool_synth_2`, ...) rather than collapsing
  // to a fixed placeholder. See sanitizeToolId() for details.
  const converted: Array<{
    originalRole: string;
    toolCallIds: string[];
    toolResultIds: string[];
    param: MessageParam;
  }> = [];
  let synthCounter = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    if (msg.role === 'user') {
      let userContent = convertContentToAnthropic(msg.content) as MessageParam['content'];

      converted.push({
        originalRole: 'user',
        toolCallIds: [],
        toolResultIds: [],
        param: {
          role: 'user',
          content: userContent,
        },
      });
    } else if (msg.role === 'assistant') {
      const convertedContent = convertContentToAnthropic(msg.content) as MessageParam['content'];
      const toolCallIds: string[] = [];
      // Per-message counter so two empty IDs in the SAME assistant
      // message still get unique synth IDs.
      let assistantSynthCounter = 0;
      if (Array.isArray(convertedContent)) {
        for (const block of convertedContent) {
          if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
            const id = (block as { id?: string }).id;
            // Always push a sanitized ID, even for empty strings, so
            // toolCallIds.length matches the actual number of tool_use
            // blocks in the assistant message.
            toolCallIds.push(sanitizeToolId(typeof id === 'string' ? id : '', assistantSynthCounter++));
          }
        }
      }
      // Sanitize tool_use IDs within the content blocks. We re-derive
      // the counter from the same source so the IDs emitted here line
      // up with the IDs collected above.
      let contentSynthCounter = 0;
      const sanitizedContent = Array.isArray(convertedContent)
        ? convertedContent.map(block => {
            if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
              return {
                ...block,
                id: sanitizeToolId(((block as { id?: string }).id) || '', contentSynthCounter++),
              } as ContentBlockParam;
            }
            return block;
          })
        : convertedContent;
      converted.push({
        originalRole: 'assistant',
        toolCallIds,
        toolResultIds: [],
        param: {
          role: 'assistant',
          content: sanitizedContent,
        },
      });
    } else if (msg.role === 'tool') {
      const toolContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      const toolUseId = sanitizeToolId(msg.tool_call_id || '', synthCounter++);
      converted.push({
        originalRole: 'tool',
        toolCallIds: [],
        toolResultIds: toolUseId ? [toolUseId] : [],
        param: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: toolContent,
          }] as ContentBlockParam[],
        },
      });
    }
  }

  // Step 2: Bidirectional orphan cleanup using GLOBAL id matching.
  //
  // Previous version required `tool_use` to be IMMEDIATELY followed by
  // a `tool` message — but Anthropic's actual rule is that each
  // tool_result.tool_use_id just needs to match SOME tool_use.id
  // somewhere in the prior history. The strict-adjacency check
  // wrongly stripped perfectly valid tool_use blocks whenever an
  // intervening user message (e.g. a <task-notification> from a
  // background sub-agent) was inserted between them, and it also
  // discarded the message body even when text content survived.
  //
  // The new approach: collect every tool_use.id and every
  // tool_result.tool_use_id across the whole converted[] array, then
  // drop only the truly-orphan blocks (those whose id has no match on
  // the other side). When a message becomes empty because ALL of its
  // tool blocks were orphans, we replace the empty content with a
  // single text placeholder so adjacent text on either side survives.
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();
  for (const entry of converted) {
    for (const id of entry.toolCallIds) seenToolUseIds.add(id);
    for (const id of entry.toolResultIds) seenToolResultIds.add(id);
  }

  const result: MessageParam[] = [];
  let orphanToolUseRemoved = 0;
  let orphanToolResultRemoved = 0;
  let orphanAssistantMessageReplaced = 0;
  let orphanToolResultMessageReplaced = 0;

  for (let i = 0; i < converted.length; i++) {
    const entry = converted[i];

    if (entry.originalRole === 'tool') {
      // Drop only the tool_result blocks whose tool_use_id is a true
      // orphan (no matching tool_use exists anywhere in the history).
      if (Array.isArray(entry.param.content)) {
        const filteredContent = (entry.param.content as ContentBlockParam[]).filter((block) => {
          if (typeof block !== 'object' || block === null) return true;
          if ((block as { type?: string }).type !== 'tool_result') return true;
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id || '';
          // Keep the block if there is at least one matching tool_use
          // somewhere in the prior history.
          if (seenToolUseIds.has(toolUseId)) return true;
          orphanToolResultRemoved++;
          return false;
        });
        if (filteredContent.length === 0) {
          // No tool_results survived. Replace the message body with a
          // single text placeholder so the message itself isn't lost
          // (and so any text we had to attach to it doesn't disappear
          // with it). Mirrors stripOrphanToolResults' convention.
          orphanToolResultMessageReplaced++;
          logger.warn(`[toAnthropicMessages] Replacing tool message at index ${i} — all tool_result blocks were orphans`);
          result.push({
            role: 'user',
            content: [{ type: 'text', text: '(orphaned tool result removed)' } as ContentBlockParam],
          });
          continue;
        }
        result.push({ role: 'user', content: filteredContent });
      } else {
        result.push(entry.param);
      }
      continue;
    }

    if (entry.originalRole === 'assistant') {
      // Drop only the tool_use blocks whose id is a true orphan (no
      // matching tool_result exists anywhere in the history).
      if (entry.toolCallIds.length > 0 && Array.isArray(entry.param.content)) {
        const filteredContent = (entry.param.content as ContentBlockParam[]).filter((block) => {
          if (typeof block !== 'object' || block === null) return true;
          if ((block as { type?: string }).type !== 'tool_use') return true;
          const id = (block as { id?: string }).id || '';
          if (seenToolResultIds.has(id)) return true;
          orphanToolUseRemoved++;
          return false;
        });
        if (filteredContent.length === 0) {
          // All blocks were orphan tool_use. Replace with a text
          // placeholder so the message itself is preserved.
          orphanAssistantMessageReplaced++;
          logger.warn(`[toAnthropicMessages] Replacing assistant message at index ${i} — all tool_use blocks were orphans`);
          result.push({
            role: 'assistant',
            content: [{ type: 'text', text: '(tool call removed)' } as ContentBlockParam],
          });
          continue;
        }
        result.push({ role: 'assistant', content: filteredContent });
      } else {
        result.push(entry.param);
      }
      continue;
    }

    result.push(entry.param);
  }

  if (orphanToolUseRemoved > 0 || orphanToolResultRemoved > 0) {
    logger.warn(
      `[toAnthropicMessages] Dropped ${orphanToolUseRemoved} orphan tool_use block(s) and ` +
        `${orphanToolResultRemoved} orphan tool_result block(s) ` +
        `(replaced ${orphanAssistantMessageReplaced} assistant / ${orphanToolResultMessageReplaced} tool messages with text placeholders)`
    );
  }

  // Step 3: Strip orphaned tool_results (no matching tool_use). This is
  // now mostly redundant with the bidirectional cleanup above, but
  // stripOrphanToolResults still runs as a final safety net — it
  // operates on the post-cleanup result and guards against any edge
  // case the per-entry pass missed.
  const strippedResults = stripOrphanToolResults(result);

  // Step 4: Merge consecutive same-role messages
  const merged = mergeConsecutiveRoles(strippedResults);

  // Step 5: Handle thinking blocks according to endpoint type
  const withThinkingHandled = handleThinkingBlocks(merged, baseURL);

  return withThinkingHandled;
}

/**
 * Convert duya MessageContent to Anthropic content block format
 */
function convertContentToAnthropic(content: string | MessageContent[]): string | ContentBlockParam[] {
  try {
    if (typeof content === 'string') {
      // Try to parse JSON string - messages loaded from DB are stored as JSON strings
      if (content.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            logger.debug('Parsed JSON array', { blockCount: parsed.length }, 'convertContentToAnthropic');
            return parsed.map(block => convertContentBlock(block)).filter((b): b is ContentBlockParam => b !== null);
          }
        } catch (e) {
          logger.debug('JSON parse failed, using as plain text', undefined, 'convertContentToAnthropic');
        }
      }
      // Plain string content
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(block => convertContentBlock(block)).filter((b): b is ContentBlockParam => b !== null);
    }

    // Fallback for unexpected content type
    logger.debug('Unexpected content type', { contentType: typeof content }, 'convertContentToAnthropic');
    return String(content);
  } catch (error) {
    console.error('[convertContentToAnthropic] Error converting content:', error);
    // Return as plain text on error
    return typeof content === 'string' ? content : String(content);
  }
}

/**
 * Convert a single content block to Anthropic format
 */
function convertContentBlock(block: MessageContent): ContentBlockParam | null {
  if (block.type === 'text') {
    return { type: 'text', text: (block as TextContent).text } as ContentBlockParam;
  }
  if (block.type === 'tool_use') {
    const toolBlock = block as ToolUseContent;
    return {
      type: 'tool_use',
      id: toolBlock.id,
      name: toolBlock.name,
      input: toolBlock.input,
    } as ContentBlockParam;
  }
  if (block.type === 'tool_result') {
    // tool_result blocks should only appear in user messages, not assistant messages
    // If we encounter one here, it's an artifact and should be filtered out
    // The actual tool_result is sent as a user message with role: 'tool'
    return null;
  }
  if (block.type === 'image') {
    const imgBlock = block as ImageContent;
    if (imgBlock.source.type === 'base64') {
      return {
        type: 'image',
        source: {
          type: 'base64' as const,
          media_type: imgBlock.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: imgBlock.source.data,
        },
      } as ContentBlockParam;
    }
    // Filter MiniMax CDN URLs — they are artifacts of MiniMax's internal image hosting,
    // not user-intended web resources. Passing them to the model would cause it to
    // attempt to fetch them via browser tool, which is incorrect.
    if (isCDNImageUrl(imgBlock.source.data)) {
      logger.warn('[AnthropicClient] Dropped MiniMax CDN image URL in content block');
      return null;
    }
    return {
      type: 'image',
      source: {
        type: 'url' as const,
        url: imgBlock.source.data,
      },
    } as ContentBlockParam;
  }
  // Filter out thinking blocks - they should not be sent to the LLM
  if (block.type === 'thinking') {
    return null;
  }
  return { type: 'text', text: String(block) } as ContentBlockParam;
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;
  private isMiniMax: boolean;
  private baseURL?: string;
  private provider: string;
  private cacheEligibility: ReturnType<typeof checkCacheEligibility>;
  private cacheMonitor?: CacheMonitor;
  private sessionId?: string;

  constructor(options: LLMClientOptions & {
    provider?: string;
    sessionId?: string;
    cacheMonitor?: CacheMonitor;
  }) {
    this.baseURL = options.baseURL;
    this.provider = options.provider || 'anthropic';
    this.sessionId = options.sessionId;
    this.cacheMonitor = options.cacheMonitor;

    // Check cache eligibility for this provider/model
    this.cacheEligibility = checkCacheEligibility(
      this.provider,
      options.model,
      options.baseURL
    );

    logger.debug(
      `[AnthropicClient] Cache eligibility: ${this.cacheEligibility.eligible ? 'yes' : 'no'} ` +
      `(provider=${this.provider}, model=${options.model})`
    );

    // When authStyle is 'auth_token', use authToken for Bearer token auth
    if (options.authStyle === 'auth_token') {
      this.client = new Anthropic({
        authToken: options.apiKey,
        baseURL: options.baseURL,
      });
    } else {
      this.client = new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
    }
    this.model = options.model;
    // Detect MiniMax API - requires different tool_result format
    this.isMiniMax = isMiniMaxEndpoint(options.baseURL);
  }

  async *streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Tool[];
      maxTokens?: number;
      contextWindow?: number;
      temperature?: number;
      cacheRetention?: CacheRetention;
      signal?: AbortSignal;
      effort?: string;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    logger.debug(`[AnthropicClient] streamChat started, model=${this.model}, isMiniMax=${this.isMiniMax}`);

    const tools = options?.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    }));

    let anthropicMessages = toAnthropicMessages(messages, this.baseURL);

    // Apply prompt caching if eligible
    if (this.cacheEligibility.eligible && options?.cacheRetention !== 'none') {
      anthropicMessages = applyCacheControl(
        anthropicMessages,
        this.cacheEligibility,
        options?.cacheRetention || 'short',
        this.baseURL
      ) as MessageParam[];
      logger.debug(`[AnthropicClient] Applied prompt caching (${options?.cacheRetention || 'short'})`);
    }

    logger.debug(`[AnthropicClient] Converted ${messages.length} messages to ${anthropicMessages.length} anthropic messages`);

    // Log first few messages for debugging
    if (messages.length > 0) {
      logger.debug(`[AnthropicClient] First message role=${messages[0].role}, content type=${typeof messages[0].content}`);
      if (messages.length > 1) {
        logger.debug(`[AnthropicClient] Last message role=${messages[messages.length - 1].role}, content type=${typeof messages[messages.length - 1].content}`);
      }
    }

    // If no messages after filtering system messages, add an empty user message
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: '' });
    }

    logger.debug(`[AnthropicClient] Creating stream with model=${this.model}`);
    let stream;
    try {
      // Map UI effort level to Anthropic `thinking` field. Auto
      // (undefined/empty) omits the field entirely so behavior matches
      // pre-effort wiring. Clamp `budget_tokens` to `max_tokens - 1` to
      // satisfy the API constraint `max_tokens > budget_tokens`.
      const BUDGET_BY_EFFORT: Record<string, number> = {
        low: 1024,
        medium: 4096,
        high: 16384,
        max: 32000,
      };
      const maxTokens = this.isMiniMax
        ? getMiniMaxAnthropicMaxTokens(this.model, options?.contextWindow)
        : options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const requestedBudget = options?.effort
        ? BUDGET_BY_EFFORT[options.effort]
        : undefined;
      const budget = requestedBudget !== undefined
        ? Math.min(requestedBudget, maxTokens - 1)
        : undefined;
      const thinking = budget !== undefined
        ? { type: 'enabled' as const, budget_tokens: budget }
        : undefined;
      stream = await this.client.messages.stream(
        {
          model: this.model,
          max_tokens: maxTokens,
          temperature: options?.temperature ?? 1,
          system: options?.systemPrompt || '',
          messages: anthropicMessages as MessageParam[],
          tools: tools?.length ? tools : undefined,
          ...(thinking ? { thinking } : {}),
        }
      );
      logger.debug('Stream created successfully', undefined, 'AnthropicClient');
    } catch (streamError) {
      logger.error('Failed to create stream', streamError instanceof Error ? streamError : new Error(String(streamError)), undefined, 'AnthropicClient');
      yield { type: 'error', data: streamError instanceof Error ? streamError.message : 'Failed to create stream' };
      yield { type: 'done' };
      return;
    }
    logger.debug('Starting to read events', undefined, 'AnthropicClient');

    let currentToolUse: { id: string; name: string; input: Record<string, unknown> } | null = null;
    let toolResultContent = '';
    let textContentSinceLastTool = '';
    let thinkingContent = '';  // Accumulates thinking content from MiniMax blocks
    let toolStartTimes = new Map<string, number>();
    let accumulatedUsage: TokenUsage | null = null;
    // For parsing MiniMax <think/> tags embedded in text
    let thinkBuffer = '';
    let isInThinkTag = false;
    let hasExtractedThinkContent = false;
    let hasYieldedPreToolThinking = false;
    let hasReceivedExtendedThinking = false;

    let eventCount = 0;
    try {
      for await (const event of stream) {
        eventCount++;
        if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop' || event.type === 'message_delta') {
          logger.debug(`[AnthropicClient] Event ${eventCount}: type=${event.type}`);
        }
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
          toolStartTimes.set(event.content_block.id, Date.now());
          yield {
            type: 'tool_use_started',
            data: currentToolUse,
          };
        } else if (event.content_block.type === 'text') {
          textContentSinceLastTool = '';
          thinkBuffer = '';
          isInThinkTag = false;
          hasExtractedThinkContent = false;
        } else if (event.content_block.type === 'thinking') {
          hasReceivedExtendedThinking = true;
          // MiniMax thinking block - accumulate thinking content
          thinkingContent = '';
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          // Ensure text is a string to avoid [object Object] concatenation
          const textDelta = typeof event.delta.text === 'string'
            ? event.delta.text
            : JSON.stringify(event.delta.text);

          // Handle MiniMax <think> tags embedded in text content
          if (this.isMiniMax) {
            thinkBuffer += textDelta;

            // Check if we're entering a think tag
            if (!isInThinkTag && thinkBuffer.includes('<think>')) {
              isInThinkTag = true;
            }

            // Check if think tag is complete
            if (isInThinkTag && thinkBuffer.includes('</think>')) {
              // Extract think content
              const thinkMatch = thinkBuffer.match(/<think>([\s\S]*?)<\/think>/);
              if (thinkMatch && !hasExtractedThinkContent) {
                hasExtractedThinkContent = true;
                const extractedThinking = thinkMatch[1].trim();
                if (extractedThinking) {
                  yield {
                    type: 'thinking',
                    data: extractedThinking,
                  };
                }
              }

              // Yield only the content after </think> as normal text
              const afterThink = thinkBuffer.split('</think>')[1] || '';
              if (afterThink) {
                textContentSinceLastTool += afterThink;
                yield {
                  type: 'text',
                  data: afterThink,
                };
              }
              isInThinkTag = false;
            } else if (!isInThinkTag) {
              // No think tag, yield as normal text
              textContentSinceLastTool += textDelta;
              yield {
                type: 'text',
                data: textDelta,
              };
            }
            // If in think tag but not complete yet, don't yield anything
          } else {
            // Non-MiniMax: normal text handling
            textContentSinceLastTool += textDelta;
            // Only yield pre-tool thinking once, when text first exceeds threshold
            // and no tool calls have started yet
            if (toolStartTimes.size === 0 && !hasYieldedPreToolThinking && !hasReceivedExtendedThinking && textContentSinceLastTool.length > 10) {
              hasYieldedPreToolThinking = true;
              yield {
                type: 'thinking',
                data: textContentSinceLastTool,
              };
            }
            yield {
              type: 'text',
              data: textDelta,
            };
          }
        } else if (event.delta.type === 'thinking_delta') {
          // MiniMax thinking delta - accumulate and yield incremental content
          const thinkingDelta = extractAnthropicThinkingDelta(event.delta);
          thinkingContent += thinkingDelta;
          yield {
            type: 'thinking',
            data: thinkingDelta,
          };
        } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
          // Ensure partial_json is a string to avoid concatenation issues
          const partialJson = typeof event.delta.partial_json === 'string'
            ? event.delta.partial_json
            : JSON.stringify(event.delta.partial_json);
          toolResultContent += partialJson;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolUse) {
          try {
            currentToolUse.input = JSON.parse(toolResultContent || '{}');
          } catch (parseError) {
            logger.warn('[AnthropicClient] Failed to parse tool input JSON', {
              toolId: currentToolUse.id,
              toolName: currentToolUse.name,
              error: parseError instanceof Error ? parseError.message : String(parseError),
              partialJsonPreview: toolResultContent.length > 300
                ? `${toolResultContent.slice(0, 300)}...`
                : toolResultContent,
            });
            // Keep partial input on parse error
          }
          if (['bash', 'powershell'].includes(currentToolUse.name.toLowerCase())) {
            const command = (currentToolUse.input as Record<string, unknown>)?.command;
            if (typeof command !== 'string' || command.trim().length === 0) {
              logger.warn('[AnthropicClient] Shell tool_use emitted without command', {
                toolId: currentToolUse.id,
                toolName: currentToolUse.name,
                inputKeys: Object.keys(currentToolUse.input ?? {}),
                rawJsonPreview: toolResultContent.length > 300
                  ? `${toolResultContent.slice(0, 300)}...`
                  : toolResultContent,
              });
            }
          }
          // Yield tool_use event AFTER input is fully parsed
          yield {
            type: 'tool_use',
            data: currentToolUse,
          };
          toolStartTimes.delete(currentToolUse.id);
          currentToolUse = null;
          toolResultContent = '';
        }
      } else if (event.type === 'message_delta') {
        // Extract usage information from message_delta event
        // Anthropic API includes cache_read_input_tokens and cache_creation_input_tokens in usage
        const usage = event.usage as unknown as Record<string, number> | undefined;
        if (usage && usage.input_tokens !== null && usage.output_tokens !== null) {
          accumulatedUsage = {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            // Include cache tokens if present (map Anthropic field names to our field names)
            cache_hit_tokens: usage.cache_read_input_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
          };
        }
      }
    }
    } catch (streamReadError) {
      logger.error('Error reading stream events', streamReadError instanceof Error ? streamReadError : new Error(String(streamReadError)), undefined, 'AnthropicClient');
      yield { type: 'error', data: streamReadError instanceof Error ? streamReadError.message : 'Error reading stream' };
      yield { type: 'done' };
      return;
    }

    logger.debug(`Stream ended, total events=${eventCount}`, undefined, 'AnthropicClient');

    // Yield result event with token usage before done
    if (accumulatedUsage) {
      // Normalize usage and report to cache monitor
      const normalizedUsage = normalizeUsage({
        input_tokens: accumulatedUsage.input_tokens,
        output_tokens: accumulatedUsage.output_tokens,
      });

      this.reportCacheObservation(normalizedUsage, options);

      yield {
        type: 'result',
        data: accumulatedUsage,
      };
    }

    logger.debug('Yielding done event', undefined, 'AnthropicClient');
    yield { type: 'done' };
  }

  async chat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ content: string; usage?: TokenUsage }> {
    let anthropicMessages = toAnthropicMessages(messages, this.baseURL);

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: '' });
    }

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.isMiniMax
          ? getMiniMaxAnthropicMaxTokens(this.model)
          : options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options?.temperature ?? 0,
        system: options?.systemPrompt || '',
        messages: anthropicMessages as MessageParam[],
      },
      {
        signal: options?.signal,
      }
    );

    const textBlocks = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(b => b.text);

    const usageRecord = response.usage as unknown as Record<string, number>;

    return {
      content: textBlocks.join('\n'),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_hit_tokens: usageRecord.cache_read_input_tokens,
        cache_creation_tokens: usageRecord.cache_creation_input_tokens,
      },
    };
  }

  /**
   * Report cache observation to monitor if available.
   */
  private reportCacheObservation(
    usage: NormalizedUsage,
    options?: {
      systemPrompt?: string;
      tools?: Tool[];
      cacheRetention?: CacheRetention;
    }
  ): void {
    if (!this.cacheMonitor || !this.sessionId) {
      return;
    }

    try {
      const systemPromptDigest = this.hashString(options?.systemPrompt || '');
      const toolNames = options?.tools?.map((t) => t.name) || [];

      this.cacheMonitor.observe(this.sessionId, usage, {
        model: this.model,
        provider: this.provider,
        systemPromptDigest,
        toolNames,
        cacheRetention: options?.cacheRetention || 'short',
      });
    } catch (err) {
      logger.debug(`[AnthropicClient] Failed to report cache observation: ${err}`);
    }
  }

  /**
   * Simple string hash for digest.
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }
}
