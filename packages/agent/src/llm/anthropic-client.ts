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
import { isCDNImageUrl, isSafeUrlSync } from '../utils/urlSafety.js';
import { extractToolInputPreview, hasToolInputPreview } from './tool-input-preview.js';


// =============================================================================
// Message Conversion Utilities
// =============================================================================

/** Valid ID characters for Anthropic API: alphanumeric, underscore, hyphen */
const VALID_ID_REGEX = /[^a-zA-Z0-9_-]/g;
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);
// MiniMax Anthropic-compatible endpoint: `max_tokens` is the OUTPUT token
// ceiling, NOT the total context window. Docs list MiniMax-M3 total
// (input+output) context = 1,000,000, but the API rejects
// `max_tokens > 524288` with:
//   `invalid params, model[MiniMax-M3] does not support max tokens > 524288`
// So the output ceiling is 524288. Other M-series models advertise 204800
// total context, which is also their max_tokens ceiling.
const MINIMAX_DEFAULT_MAX_TOKENS = 204_800;
const MINIMAX_M3_MAX_TOKENS = 524_288;
// Highspeed variants (e.g. MiniMax-M2.7-highspeed) advertise a 200K total
// context but the API rejects max_tokens > 196608 (192K) with error 2013:
//   `invalid params, model[MiniMax-M2.7-highspeed] does not support max tokens > 196608`
const MINIMAX_HIGHSPEED_MAX_TOKENS = 196_608;
// Used only for a single recovery request after MiniMax returns its generic
// 2013 invalid-parameters error. It avoids retrying an already-invalid payload
// with the largest possible output reservation.
const MINIMAX_RECOVERY_MAX_TOKENS = 8_192;

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
 * Runtime tool_use ID synthesizer for empty/invalid IDs returned by LLM
 * providers (notably MiniMax-M3 in multi-turn conversations).
 *
 * Unlike {@link sanitizeToolId} (which is used during message-history
 * conversion and uses a positional counter), this produces a globally
 * unique, stable ID from `crypto.randomUUID()`. The synthesized ID is
 * written into the live `currentToolUse` object the moment a tool_use
 * block arrives from the LLM stream, so:
 *
 *   - The in-memory assistant message stores the synth ID (not empty).
 *   - The StreamingToolExecutor tracks the tool by the synth ID.
 *   - The tool_result message carries the synth ID as `tool_call_id`.
 *   - appendMessages writes the synth ID to DB (both the assistant
 *     content JSON and the tool_result.tool_call_id column).
 *   - On hot-restart, messageRowToMessage reads the synth ID back
 *     unchanged — no UUID-substitution / NULL mismatch can occur.
 *
 * This breaks the "empty-ID → DB corruption → 2013 on reload" loop
 * at its source instead of relying on the message-history repair
 * passes to clean up afterward.
 */
function synthesizeRuntimeToolId(rawId: string | undefined | null): string {
  const cleaned = (rawId || '').replace(VALID_ID_REGEX, '_');
  if (cleaned) {
    return cleaned;
  }
  // crypto.randomUUID() is available on Node 16+ as a global. Replace
  // hyphens with underscores to stay within Anthropic's [a-zA-Z0-9_-]
  // charset (hyphens ARE allowed, but keeping the canonical `toolu_`
  // prefix shape avoids any provider that special-cases the prefix).
  const rand = globalThis.crypto.randomUUID().replace(/-/g, '_');
  return `toolu_synth_${rand}`;
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

export function getMiniMaxAnthropicMaxTokens(model: string, configuredMaxTokens?: number): number {
  if (typeof configuredMaxTokens === 'number' && configuredMaxTokens > 0) {
    return configuredMaxTokens;
  }

  const normalizedModel = model.trim().toLowerCase();
  if (normalizedModel === 'minimax-m3') {
    return MINIMAX_M3_MAX_TOKENS;
  }
  // Highspeed variants have a lower max_tokens ceiling than their base
  // models. Check before the generic minimax-m prefix branch so the
  // more specific case wins.
  if (normalizedModel.includes('highspeed')) {
    return MINIMAX_HIGHSPEED_MAX_TOKENS;
  }
  if (normalizedModel.startsWith('minimax-m')) {
    return MINIMAX_DEFAULT_MAX_TOKENS;
  }

  return MINIMAX_DEFAULT_MAX_TOKENS;
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
 * Idle timeout for streaming LLM responses. If no data is received for
 * `timeoutMs` milliseconds, the source iterator is cleaned up and a
 * TimeoutError is thrown. The timer resets after each successfully
 * received event.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `Stream idle timeout: no data received for ${timeoutMs}ms`,
        );
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([iterator.next(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (result.done) {
        return;
      }
      yield result.value;
    } catch (err) {
      if (timer) clearTimeout(timer);
      // Ensure the source iterator is cleaned up on timeout/error
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return(undefined as never);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw err;
    }
  }
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
 * Final safety net: ensure every tool_result has a matching tool_use and
 * every tool_use has a matching tool_result. Logs the exact mismatches
 * (with message index and id) at ERROR level so we can diagnose the root
 * cause if a provider/proxy still produces unpairable blocks.
 *
 * This runs after all other transformations (merge, thinking handling,
 * etc.) so it operates on the exact payload that would be sent to the API.
 */
function repairToolPairing(messages: MessageParam[]): MessageParam[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // First pass: collect ids
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (typeof b !== 'object' || b === null) continue;
        if ((b as { type?: string }).type === 'tool_use') {
          toolUseIds.add((b as { id?: string }).id || '');
        }
      }
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (typeof b !== 'object' || b === null) continue;
        if ((b as { type?: string }).type === 'tool_result') {
          toolResultIds.add((b as { tool_use_id?: string }).tool_use_id || '');
        }
      }
    }
  }

  // Identify mismatches
  const unmatchedResults = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      unmatchedResults.add(id);
    }
  }
  const unmatchedUses = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      unmatchedUses.add(id);
    }
  }

  if (unmatchedResults.size === 0 && unmatchedUses.size === 0) {
    return messages;
  }

  // Log every mismatch with position for diagnosis
  logger.error(
    `[toAnthropicMessages] Tool pairing mismatch detected: ` +
      `${unmatchedUses.size} tool_use(s) without result, ${unmatchedResults.size} tool_result(s) without use`,
    undefined,
    { unmatchedUseIds: Array.from(unmatchedUses), unmatchedResultIds: Array.from(unmatchedResults) },
    'AnthropicClient'
  );

  // Second pass: log positions and repair
  const repaired: MessageParam[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const filtered = (m.content as ContentBlockParam[]).filter((b) => {
        if (typeof b !== 'object' || b === null) return true;
        if ((b as { type?: string }).type !== 'tool_use') return true;
        const id = (b as { id?: string }).id || '';
        if (unmatchedUses.has(id)) {
          logger.error(
            `[toAnthropicMessages] Removing unmatched tool_use at message[${mi}]: id=${id}`,
            undefined,
            undefined,
            'AnthropicClient'
          );
          return false;
        }
        return true;
      });
      if (filtered.length === 0 && m.content.length > 0) {
        repaired.push({ ...m, content: [{ type: 'text', text: '(tool call removed)' } as ContentBlockParam] });
      } else {
        repaired.push({ ...m, content: filtered });
      }
      continue;
    }

    if (m.role === 'user' && Array.isArray(m.content)) {
      const filtered = (m.content as ContentBlockParam[]).filter((b) => {
        if (typeof b !== 'object' || b === null) return true;
        if ((b as { type?: string }).type !== 'tool_result') return true;
        const id = (b as { tool_use_id?: string }).tool_use_id || '';
        if (unmatchedResults.has(id)) {
          logger.error(
            `[toAnthropicMessages] Removing unmatched tool_result at message[${mi}]: tool_use_id=${id}`,
            undefined,
            undefined,
            'AnthropicClient'
          );
          return false;
        }
        return true;
      });
      if (filtered.length === 0 && m.content.length > 0) {
        repaired.push({ ...m, content: [{ type: 'text', text: '(orphaned tool result removed)' } as ContentBlockParam] });
      } else {
        repaired.push({ ...m, content: filtered });
      }
      continue;
    }

    repaired.push(m);
  }

  return repaired;
}

/**
 * Move deferred user messages out of an in-flight tool round.
 *
 * Anthropic-compatible providers require the tool_result blocks for an
 * assistant tool_use message to be the next user turn. A background task
 * notification can otherwise land between the call and its result. Merely
 * checking that both IDs exist somewhere in history is insufficient: MiniMax
 * rejects that sequence with error 2013.
 */
function normalizeToolResultOrdering(messages: MessageParam[]): MessageParam[] {
  const normalized: MessageParam[] = [];
  let reorderedRounds = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const pendingIds = new Set<string>();
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
          const id = (block as { id?: string }).id;
          if (id) pendingIds.add(id);
        }
      }
    }

    if (pendingIds.size === 0) {
      normalized.push(message);
      continue;
    }

    const unresolvedIds = new Set(pendingIds);
    const resultBlocks: ContentBlockParam[] = [];
    const deferred: MessageParam[] = [];
    let resultEndIndex = -1;

    for (let cursor = index + 1; cursor < messages.length && unresolvedIds.size > 0; cursor++) {
      const candidate = messages[cursor];
      if (candidate.role === 'assistant') {
        break;
      }

      if (candidate.role === 'user' && Array.isArray(candidate.content)) {
        const matchingResults = candidate.content.filter((block) => {
          if (typeof block !== 'object' || block === null || (block as { type?: string }).type !== 'tool_result') {
            return false;
          }
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          return toolUseId !== undefined && unresolvedIds.has(toolUseId);
        }) as ContentBlockParam[];

        if (matchingResults.length > 0) {
          for (const block of matchingResults) {
            const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
            if (toolUseId) unresolvedIds.delete(toolUseId);
          }
          resultBlocks.push(...matchingResults);
          resultEndIndex = cursor;

          const remainingContent = candidate.content.filter((block) => !matchingResults.includes(block));
          if (remainingContent.length > 0) {
            deferred.push({ ...candidate, content: remainingContent });
          }
          continue;
        }
      }

      deferred.push(candidate);
    }

    // Leave incomplete rounds to repairToolPairing, which safely drops the
    // unpaired blocks. Reordering only complete rounds avoids fabricating a
    // tool result or moving unrelated later conversation into the round.
    if (unresolvedIds.size > 0 || resultEndIndex === -1) {
      normalized.push(message);
      continue;
    }

    const alreadyAdjacent = resultEndIndex === index + 1 && deferred.length === 0;
    normalized.push(message);
    if (alreadyAdjacent) {
      normalized.push(messages[resultEndIndex]);
    } else {
      normalized.push({ role: 'user', content: resultBlocks });
      normalized.push(...deferred);
      reorderedRounds++;
    }
    index = resultEndIndex;
  }

  if (reorderedRounds > 0) {
    logger.warn(
      `[toAnthropicMessages] Reordered ${reorderedRounds} tool round(s) so tool_result blocks immediately follow tool_use`,
    );
  }

  return normalized;
}

/**
 * Convert duya Message[] to Anthropic MessageParam[]
 *
 * Implements hermes-agent equivalent logic with the following pipeline:
 * 1. Convert all messages to Anthropic format, sanitizing tool IDs
 * 2. Strip orphaned tool_use blocks (no matching tool_result)
 * 3. Strip orphaned tool_result blocks (no matching tool_use)
 * 4. Restore strict tool_use -> tool_result ordering
 * 5. Merge consecutive same-role messages
 * 6. Handle thinking blocks according to endpoint type
 * 7. Final tool pairing repair (safety net)
 *
 * @param messages - The messages to convert
 * @param baseURL - The API base URL (used to detect third-party endpoints)
 */
function toAnthropicMessages(
  messages: Message[],
  baseURL?: string,
  synthesizeMissingToolResults = false,
): MessageParam[] {
  // Step 1: Convert all messages to Anthropic format, sanitizing tool IDs.
  //
  // We thread TWO independent global counters through the whole pass:
  //   - emptyToolUseCounter    — bumped for each empty tool_use.id
  //                               encountered in assistant messages
  //   - emptyToolResultCounter — bumped for each empty tool_result.tool_use_id
  //                               encountered in tool messages
  //
  // Both resolve to `tool_synth_<n>`. Because both counters are GLOBAL
  // (not per-message), the Nth empty tool_use.id and the Nth empty
  // tool_result.tool_use_id both resolve to `tool_synth_<N>` — which
  // is exactly the positional matching Anthropic requires. A previous
  // version used a per-message-local counter for the assistant branch,
  // which caused every assistant message's first empty tool_use to
  // collapse to `tool_synth_0`, producing ID collisions across turns
  // and triggering Anthropic 2013 "tool call result does not follow
  // tool call".
  const converted: Array<{
    originalRole: string;
    toolCallIds: string[];
    toolResultIds: string[];
    param: MessageParam;
  }> = [];
  let emptyToolUseCounter = 0;
  let emptyToolResultCounter = 0;

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

      // Single pass: build toolCallIds AND sanitize content together
      // so both use the same counter value for the same tool_use block.
      // The counter is global (not per-message) so two assistant
      // messages with empty tool_use IDs get distinct synth IDs.
      let sanitizedContent: MessageParam['content'];
      if (Array.isArray(convertedContent)) {
        sanitizedContent = convertedContent.map(block => {
          if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
            const rawId = ((block as { id?: string }).id) || '';
            const sanitizedId = sanitizeToolId(rawId, emptyToolUseCounter++);
            // Collect the sanitized ID so toolCallIds.length matches
            // the actual number of tool_use blocks.
            toolCallIds.push(sanitizedId);
            return { ...block, id: sanitizedId } as ContentBlockParam;
          }
          return block;
        });
      } else {
        sanitizedContent = convertedContent;
      }
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
      const toolUseId = sanitizeToolId(msg.tool_call_id || '', emptyToolResultCounter++);
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

  // Recovery mode is deliberately additive: do not discard an assistant's
  // tool_use just because a worker crashed before its result was persisted.
  // Instead, synthesize an explicit failed result. That restores the provider
  // protocol without claiming the tool actually completed, and lets the model
  // continue from a truthful state on the retry.
  if (synthesizeMissingToolResults) {
    const existingResultIds = new Set<string>();
    for (const entry of converted) {
      for (const id of entry.toolResultIds) existingResultIds.add(id);
    }

    const repaired: typeof converted = [];
    let synthesizedCount = 0;
    for (const entry of converted) {
      repaired.push(entry);
      if (entry.originalRole !== 'assistant' || entry.toolCallIds.length === 0) continue;

      const missingIds = entry.toolCallIds.filter((id) => !existingResultIds.has(id));
      if (missingIds.length === 0) continue;

      synthesizedCount += missingIds.length;
      repaired.push({
        originalRole: 'tool',
        toolCallIds: [],
        toolResultIds: missingIds,
        param: {
          role: 'user',
          content: missingIds.map((toolUseId) => ({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: '<tool_error>Tool execution did not complete. This result was synthesized during conversation recovery.</tool_error>',
            is_error: true,
          })) as ContentBlockParam[],
        },
      });
    }
    if (synthesizedCount > 0) {
      logger.warn(
        `[toAnthropicMessages] Synthesized ${synthesizedCount} missing tool_result block(s) for recovery`,
      );
    }
    converted.splice(0, converted.length, ...repaired);
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

  // Step 2b: Detect duplicate tool_use IDs and rename each occurrence pair.
  //
  // Even with the global counter fix above, a misbehaving provider could
  // emit the SAME non-empty tool_use.id across multiple calls. We rename
  // each *occurrence* of the duplicated id so that the Nth tool_use with
  // that id pairs with the Nth tool_result with the same tool_use_id.
  const useIdCounts = new Map<string, number>();
  const resultIdCounts = new Map<string, number>();
  for (const entry of result) {
    if (entry.role === 'assistant' && Array.isArray(entry.content)) {
      for (const b of entry.content) {
        if (typeof b !== 'object' || b === null) continue;
        if ((b as { type?: string }).type !== 'tool_use') continue;
        const id = (b as { id?: string }).id || '';
        if (id) useIdCounts.set(id, (useIdCounts.get(id) || 0) + 1);
      }
    }
    if (entry.role === 'user' && Array.isArray(entry.content)) {
      for (const b of entry.content) {
        if (typeof b !== 'object' || b === null) continue;
        if ((b as { type?: string }).type !== 'tool_result') continue;
        const id = (b as { tool_use_id?: string }).tool_use_id || '';
        if (id) resultIdCounts.set(id, (resultIdCounts.get(id) || 0) + 1);
      }
    }
  }

  const duplicatedIds = new Set<string>();
  for (const [id, count] of useIdCounts) {
    if (count > 1) duplicatedIds.add(id);
  }
  for (const [id, count] of resultIdCounts) {
    if (count > 1) duplicatedIds.add(id);
  }

  if (duplicatedIds.size > 0) {
    const occurrenceIndex = new Map<string, number>();
    const idMappings = new Map<string, Map<number, string>>();
    let dupRenameCounter = 0;
    let duplicateUseIdRenamed = 0;

    // Rename USE occurrences: first occurrence keeps original id,
    // subsequent ones get tool_dup_<n>.
    for (const entry of result) {
      if (entry.role !== 'assistant' || !Array.isArray(entry.content)) continue;
      for (let bi = 0; bi < entry.content.length; bi++) {
        const block = entry.content[bi];
        if (typeof block !== 'object' || block === null) continue;
        if ((block as { type?: string }).type !== 'tool_use') continue;
        const id = (block as { id?: string }).id || '';
        if (!id || !duplicatedIds.has(id)) continue;
        const idx = occurrenceIndex.get(id) || 0;
        occurrenceIndex.set(id, idx + 1);
        let perIdMap = idMappings.get(id);
        if (!perIdMap) {
          perIdMap = new Map();
          idMappings.set(id, perIdMap);
        }
        let finalId = perIdMap.get(idx);
        if (!finalId) {
          finalId = idx === 0 ? id : `tool_dup_${dupRenameCounter++}`;
          perIdMap.set(idx, finalId);
        }
        if (finalId !== id) {
          (entry.content as ContentBlockParam[])[bi] = { ...block, id: finalId } as ContentBlockParam;
          duplicateUseIdRenamed++;
        }
      }
    }

    // Rename RESULT occurrences using the same chronological mapping.
    occurrenceIndex.clear();
    for (const entry of result) {
      if (entry.role !== 'user' || !Array.isArray(entry.content)) continue;
      for (let bi = 0; bi < entry.content.length; bi++) {
        const block = entry.content[bi];
        if (typeof block !== 'object' || block === null) continue;
        if ((block as { type?: string }).type !== 'tool_result') continue;
        const id = (block as { tool_use_id?: string }).tool_use_id || '';
        if (!id || !duplicatedIds.has(id)) continue;
        const idx = occurrenceIndex.get(id) || 0;
        occurrenceIndex.set(id, idx + 1);
        const perIdMap = idMappings.get(id);
        const finalId = perIdMap?.get(idx);
        if (finalId && finalId !== id) {
          (entry.content as ContentBlockParam[])[bi] = { ...block, tool_use_id: finalId } as ContentBlockParam;
        }
      }
    }

    logger.warn(
      `[toAnthropicMessages] Renamed ${duplicateUseIdRenamed} duplicate tool_use occurrence(s) ` +
        `for id(s): ${Array.from(duplicatedIds).join(', ')}`
    );
  }

  // Step 3: Restore provider-required ordering for complete tool rounds.
  // A global ID match alone is not enough: MiniMax rejects a task
  // notification between tool_use and tool_result with error 2013.
  const ordered = normalizeToolResultOrdering(result);

  // Step 4: Strip orphaned tool_results (no matching tool_use). This is
  // now mostly redundant with the bidirectional cleanup above, but
  // stripOrphanToolResults still runs as a final safety net — it
  // operates on the post-cleanup result and guards against any edge
  // case the per-entry pass missed.
  const strippedResults = stripOrphanToolResults(ordered);

  // Step 5: Merge consecutive same-role messages
  const merged = mergeConsecutiveRoles(strippedResults);

  // Step 6: Handle thinking blocks according to endpoint type
  const withThinkingHandled = handleThinkingBlocks(merged, baseURL);

  // Step 7: Final tool pairing repair. This is the last safety net
  // before the request goes to the API. It removes any remaining
  // unmatched tool_use/tool_result blocks and logs the exact IDs and
  // positions so we can diagnose the root cause.
  const repaired = repairToolPairing(withThinkingHandled);

  return repaired;
}

function isMiniMaxInvalidParameters2013(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b2013\b/.test(message) && /invalid params|invalid_request_error/i.test(message);
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
    // SSRF protection: reject file:// and internal/private network URLs
    const urlSafety = isSafeUrlSync(imgBlock.source.data);
    if (!urlSafety.safe) {
      logger.warn(`[AnthropicClient] Dropped unsafe image URL: ${urlSafety.reason}`);
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
      maxOutputTokens?: number;
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
        ? getMiniMaxAnthropicMaxTokens(this.model, options?.maxOutputTokens ?? options?.contextWindow)
        : options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const effort = options?.effort;
      const hasEffort = typeof effort === 'string' && effort.length > 0;

      // MiniMax M3 thinking only accepts `adaptive` / `disabled` shapes.
      // `enabled + budget_tokens` is rejected. effort=auto omits thinking
      // so M3 stays on its documented default (thinking off).
      // See https://platform.minimaxi.com/docs/api-reference/text-anthropic-api#thinking-控制
      const thinking = this.isMiniMax
        ? (hasEffort ? { type: 'adaptive' as const } : undefined)
        : (() => {
            const requestedBudget = hasEffort && effort ? BUDGET_BY_EFFORT[effort] : undefined;
            const budget = requestedBudget !== undefined
              ? Math.min(requestedBudget, maxTokens - 1)
              : undefined;
            return budget !== undefined
              ? { type: 'enabled' as const, budget_tokens: budget }
              : undefined;
          })();
      stream = await this.client.messages.stream(
        {
          model: this.model,
          max_tokens: maxTokens,
          temperature: options?.temperature ?? 1,
          system: options?.systemPrompt || '',
          messages: anthropicMessages as MessageParam[],
          tools: tools?.length ? tools : undefined,
          ...(thinking ? { thinking } : {}),
        },
        options?.signal ? { signal: options.signal } : undefined
      );
      logger.debug('Stream created successfully', undefined, 'AnthropicClient');
    } catch (streamError) {
      if (!this.isMiniMax || !isMiniMaxInvalidParameters2013(streamError) || options?.signal?.aborted) {
        logger.error('Failed to create stream', streamError instanceof Error ? streamError : new Error(String(streamError)), undefined, 'AnthropicClient');
        throw streamError;
      }

      // MiniMax sometimes reduces malformed history to the unhelpful generic
      // `invalid params, 400 (2013)`. Recover once before exposing an error:
      // synthesize missing failed tool results, remove cache directives, omit
      // optional thinking, and reserve a conservative output budget.
      anthropicMessages = toAnthropicMessages(messages, this.baseURL, true);
      logger.warn(
        '[AnthropicClient] MiniMax returned 2013; retrying once with repaired tool history and conservative request parameters',
        { messageCount: anthropicMessages.length },
        'AnthropicClient',
      );
      try {
        stream = await this.client.messages.stream(
          {
            model: this.model,
            max_tokens: Math.min(
              getMiniMaxAnthropicMaxTokens(this.model, options?.maxOutputTokens ?? options?.contextWindow),
              MINIMAX_RECOVERY_MAX_TOKENS,
            ),
            temperature: options?.temperature ?? 1,
            system: options?.systemPrompt || '',
            messages: anthropicMessages,
            tools: tools?.length ? tools : undefined,
          },
          options?.signal ? { signal: options.signal } : undefined,
        );
        logger.info('MiniMax 2013 recovery retry created stream successfully', undefined, 'AnthropicClient');
      } catch (recoveryError) {
        logger.error('MiniMax 2013 recovery retry failed', recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError)), undefined, 'AnthropicClient');
        throw recoveryError;
      }
    }
    logger.debug('Starting to read events', undefined, 'AnthropicClient');

    let currentToolUse: { id: string; name: string; input: Record<string, unknown> } | null = null;
    let toolResultContent = '';
    let lastToolPreviewSignature = '';
    let textContentSinceLastTool = '';
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
      for await (const event of withIdleTimeout(stream)) {
        eventCount++;
        if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop' || event.type === 'message_delta' || event.type === 'message_start') {
          logger.debug(`[AnthropicClient] Event ${eventCount}: type=${event.type}`);
        }
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          // MiniMax-M3 (and possibly other third-party Anthropic-compatible
          // providers) occasionally return an empty `tool_use.id`. Left
          // unchecked, the empty ID propagates into:
          //   - the assistant message's content JSON (stored as `""`)
          //   - the tool_result message's `tool_call_id` (stored as NULL,
          //     because `'' || null` collapses to null in appendMessages)
          // On hot-restart, messageRowToMessage substitutes the NULL
          // tool_call_id with `undefined`, while the assistant tool_use
          // block gets either a row-UUID (msg_type='tool_use') or keeps
          // the empty string (msg_type='text'). The result is an
          // unrecoverable pairing break that no downstream repair pass
          // can fully clean up — and the provider rejects the next
          // request with HTTP 400 "tool call id is invalid (2013)".
          //
          // Fix: synthesize a stable, globally-unique ID at the source.
          // The synth ID flows through the in-memory assistant message,
          // StreamingToolExecutor, tool_result.tool_call_id, and the DB
          // write — so reload reads the same ID back. The synth ID also
          // satisfies the Anthropic [a-zA-Z0-9_-] charset constraint.
          const synthId = synthesizeRuntimeToolId(event.content_block.id);
          if (synthId !== event.content_block.id) {
            logger.warn(
              `[AnthropicClient] Synthesized tool_use.id — provider returned empty/invalid id`,
              {
                toolName: event.content_block.name,
                originalId: event.content_block.id,
                synthId,
              },
              'AnthropicClient'
            );
          }
          currentToolUse = {
            id: synthId,
            name: event.content_block.name,
            input: {},
          };
          toolResultContent = '';
          lastToolPreviewSignature = '';
          toolStartTimes.set(synthId, Date.now());
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
              // Reset extraction gate so subsequent think blocks are also extracted
              hasExtractedThinkContent = false;
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
              // Clear accumulated text to prevent the same content from being
              // re-yielded as thinking or text in subsequent processing.
              textContentSinceLastTool = '';
            }
            yield {
              type: 'text',
              data: textDelta,
            };
          }
        } else if (event.delta.type === 'thinking_delta') {
          // MiniMax thinking delta - yield incremental content
          const thinkingDelta = extractAnthropicThinkingDelta(event.delta);
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
          const previewInput = extractToolInputPreview(toolResultContent);
          if (hasToolInputPreview(previewInput)) {
            const previewSignature = JSON.stringify(previewInput);
            if (previewSignature !== lastToolPreviewSignature) {
              lastToolPreviewSignature = previewSignature;
              yield {
                type: 'tool_use_started',
                data: {
                  ...currentToolUse,
                  input: previewInput,
                },
              };
            }
          }
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
          lastToolPreviewSignature = '';
        }
      } else if (event.type === 'message_start') {
        // Capture input/cache token counts from message_start (sent once
        // at the beginning of the stream). These fields are NOT present
        // in message_delta, so we must extract them here.
        const startUsage = (event as unknown as { message?: { usage?: Record<string, number> } }).message?.usage;
        if (startUsage) {
          accumulatedUsage = {
            input_tokens: startUsage.input_tokens ?? 0,
            output_tokens: startUsage.output_tokens ?? 0,
            cache_hit_tokens: (startUsage as Record<string, number>).cache_read_input_tokens,
            cache_creation_tokens: (startUsage as Record<string, number>).cache_creation_input_tokens,
          };
        }
      } else if (event.type === 'message_delta') {
        // message_delta only carries cumulative output_tokens.
        // Preserve input/cache tokens captured from message_start.
        // Cast to TokenUsage | null to defeat TS's control-flow narrowing
        // which otherwise collapses the variable to `never` here (the only
        // non-null assignment lives in the mutually-exclusive message_start
        // branch, so within a single iteration TS thinks it can only be null).
        const prevUsage = accumulatedUsage as TokenUsage | null;
        const deltaUsage = event.usage as unknown as Record<string, number> | undefined;
        if (deltaUsage && deltaUsage.output_tokens !== undefined && deltaUsage.output_tokens !== null) {
          accumulatedUsage = {
            input_tokens: prevUsage?.input_tokens ?? 0,
            output_tokens: deltaUsage.output_tokens,
            cache_hit_tokens: prevUsage?.cache_hit_tokens,
            cache_creation_tokens: prevUsage?.cache_creation_tokens,
          };
        }
      }
    }
    } catch (streamReadError) {
      logger.error('Error reading stream events', streamReadError instanceof Error ? streamReadError : new Error(String(streamReadError)), undefined, 'AnthropicClient');
      throw streamReadError;
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

      logger.info(`[AnthropicClient] Yielding result event: input=${accumulatedUsage.input_tokens}, output=${accumulatedUsage.output_tokens}, cache_hit=${accumulatedUsage.cache_hit_tokens}, cache_creation=${accumulatedUsage.cache_creation_tokens}`, undefined, 'AnthropicClient');

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

    const usage = response.usage;
    const usageRecord = usage as unknown as Record<string, number> | undefined;

    return {
      content: textBlocks.join('\n'),
      usage: usage
        ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_hit_tokens: usageRecord?.cache_read_input_tokens,
            cache_creation_tokens: usageRecord?.cache_creation_input_tokens,
          }
        : undefined,
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
