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
 * Robustness features ported from anthropic-client.ts (plan 310 closeout):
 * - MiniMax max_tokens clamping (getMiniMaxAnthropicMaxTokens)
 * - MiniMax 2013 / tool-ordering recovery retry with synthesized results
 * - Tool name validation against the Anthropic-compatible charset
 * - Tool ID sanitization (history) + runtime ID synthesis (streaming)
 * - Full toAnthropicMessages pipeline: duplicate ID renaming, tool round
 *   ordering normalization, thinking handling, final pairing repair
 * - Prompt caching (checkCacheEligibility / applyCacheControl)
 * - Stream idle timeout (withIdleTimeout)
 *
 * This package cannot import the agent logger; all diagnostics go to
 * console.warn / console.error with a '[duya-ai]' prefix (the agent
 * subprocess forwards stderr).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type {
  AIClient, AIClientOptions, AssistantMessage, AssistantMessageEvent,
  Message, MessageContent, Model, SSEEvent,
  TextContent, ThinkingContent, ToolUseContent,
} from '../types.js';
import { transformMessages } from './transform-messages.js';
import { emitSSE } from './emit-sse.js';
import { collectDiagnostics } from '../utils/simple-options.js';
import { checkCacheEligibility, applyCacheControl } from '../utils/prompt-caching.js';
import { withIdleTimeout } from '../utils/idle-timeout.js';

// =============================================================================
// Constants
// =============================================================================

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Valid ID characters for Anthropic API: alphanumeric, underscore, hyphen */
const VALID_ID_REGEX = /[^a-zA-Z0-9_-]/g;

/** Anthropic-compatible endpoints validate tool names with this contract. */
const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

// =============================================================================
// Tool ID sanitization
// =============================================================================

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
export function sanitizeToolId(toolId: string, synthCounter: number): string {
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
 * written into the live assistant message the moment a tool_use block
 * arrives from the stream, so the in-memory message, the tool executor,
 * the tool_result message, and the DB row all carry the same synth ID.
 */
export function synthesizeRuntimeToolId(rawId: string | undefined | null): string {
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

// =============================================================================
// Endpoint detection
// =============================================================================

/**
 * Check if a base URL represents a third-party Anthropic-compatible endpoint.
 * Third-party proxies (MiniMax, Azure, etc.) cannot validate Anthropic
 * thinking signatures and require special handling.
 */
export function isThirdPartyEndpoint(baseURL?: string): boolean {
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
 */
export function isMiniMaxEndpoint(baseURL?: string): boolean {
  if (!baseURL) {
    return false;
  }
  const normalized = baseURL.replace(/\/$/, '').toLowerCase();
  return (
    normalized.startsWith('https://api.minimax.io/anthropic') ||
    normalized.startsWith('https://api.minimaxi.com/anthropic')
  );
}

/**
 * Resolve the max_tokens ceiling for MiniMax Anthropic-compatible endpoints.
 * A positive configured value wins when it is below the model ceiling.
 */
export function getMiniMaxAnthropicMaxTokens(model: string, configuredMaxTokens?: number): number {
  const normalizedModel = model.trim().toLowerCase();
  let ceiling: number;
  if (normalizedModel === 'minimax-m3') {
    ceiling = MINIMAX_M3_MAX_TOKENS;
  } else if (normalizedModel.includes('highspeed')) {
    // Highspeed variants have a lower max_tokens ceiling than their base
    // models. Check before the generic minimax-m prefix branch so the
    // more specific case wins.
    ceiling = MINIMAX_HIGHSPEED_MAX_TOKENS;
  } else {
    ceiling = MINIMAX_DEFAULT_MAX_TOKENS;
  }
  return typeof configuredMaxTokens === 'number' && configuredMaxTokens > 0
    ? Math.min(configuredMaxTokens, ceiling)
    : ceiling;
}

// =============================================================================
// Provider error classification
// =============================================================================

/**
 * MiniMax reports a generic `invalid params, 400 (2013)` for several
 * distinct payload problems (max_tokens ceiling, broken tool rounds, ...).
 */
export function isMiniMaxInvalidParameters2013(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b2013\b/.test(message) && /invalid params|invalid_request_error/i.test(message);
}

/**
 * Anthropic-compatible providers that pinpoint broken tool rounds produce
 * an error mentioning tool_use/tool_result ordering requirements.
 */
export function isToolResultOrderingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tool_use[\s\S]{0,200}tool_result|tool_result[\s\S]{0,200}tool_use/i.test(message) &&
    /immediately after|corresponding|must have/i.test(message);
}

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

/**
 * Handle thinking blocks according to endpoint type:
 * - MiniMax Anthropic-compatible: strip ALL thinking blocks. MiniMax does not
 *   validate thinking signatures, and replaying unsigned historical thinking
 *   blocks can cause the model to emit reasoning without any text reply.
 * - Other third-party: strip ALL thinking blocks (can't validate signatures)
 * - Direct Anthropic, non-last assistant: strip ALL thinking blocks
 * - Direct Anthropic, last assistant: keep signed thinking, downgrade unsigned to text
 * - Strip cache_control from remaining thinking blocks
 *
 * Adapted from packages/agent/src/llm/anthropic-client.ts.
 */
export function handleThinkingBlocks(
  messages: MessageParam[],
  model: Model<'anthropic'>,
): MessageParam[] {
  const isThirdParty = isThirdPartyEndpoint(model.baseUrl);
  const isMiniMax = isMiniMaxEndpoint(model.baseUrl) || !!model.compat?.forceAdaptiveThinking;

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

    if (isMiniMax || isThirdParty) {
      // MiniMax and other third-party endpoints: strip ALL thinking blocks.
      // MiniMax cannot validate signatures, and preserving unsigned thinking
      // in history breaks multi-turn text generation.
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
 * (with message index and id) so we can diagnose the root cause if a
 * provider/proxy still produces unpairable blocks.
 *
 * This runs after all other transformations (merge, thinking handling,
 * etc.) so it operates on the exact payload that would be sent to the API.
 *
 * Copied from packages/agent/src/llm/anthropic-client.ts.
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
  console.error(
    '[duya-ai] [toAnthropicMessages] Tool pairing mismatch detected: ' +
      `${unmatchedUses.size} tool_use(s) without result, ${unmatchedResults.size} tool_result(s) without use`,
    { unmatchedUseIds: Array.from(unmatchedUses), unmatchedResultIds: Array.from(unmatchedResults) },
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
          console.error(
            `[duya-ai] [toAnthropicMessages] Removing unmatched tool_use at message[${mi}]: id=${id}`,
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
          console.error(
            `[duya-ai] [toAnthropicMessages] Removing unmatched tool_result at message[${mi}]: tool_use_id=${id}`,
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
 * Ensure every assistant tool_use turn is immediately followed by a user
 * turn containing its tool_result blocks.
 *
 * Anthropic-compatible providers require tool_result blocks to be the very
 * next message after the assistant tool_use turn. A background task
 * notification, a model correction, or a streaming save can otherwise land
 * between the call and its result. Merely checking that both IDs exist
 * somewhere in history is insufficient: MiniMax rejects that sequence with
 * error 2013.
 *
 * This implementation takes a global view: it identifies each assistant
 * tool_use round, pairs it with the chronological first matching tool_result
 * blocks found anywhere later in the history, and rebuilds the sequence so
 * the results sit directly after the round. Non-tool content from the
 * original locations is preserved in sequence.
 */
export function normalizeToolResultOrdering(
  messages: MessageParam[],
  synthesizeMissingToolResults = false,
): MessageParam[] {
  if (messages.length === 0) return messages;

  type ToolRound = {
    start: number;
    end: number;
    ids: string[];
    results: ContentBlockParam[];
    missingIds: string[];
  };

  // ── Step 1: identify every assistant tool_use round ───────────────────────
  const rounds: ToolRound[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) {
      i++;
      continue;
    }

    const ids = m.content
      .filter((block) => {
        if (typeof block !== 'object' || block === null) return false;
        return (block as { type?: string }).type === 'tool_use';
      })
      .map((block) => (block as { id?: string }).id)
      .filter((id): id is string => !!id);

    if (ids.length === 0) {
      i++;
      continue;
    }

    const start = i;
    const roundIds: string[] = [...ids];
    i++;
    while (i < messages.length) {
      const candidate = messages[i];
      if (candidate.role !== 'assistant' || !Array.isArray(candidate.content)) break;

      const moreIds = candidate.content
        .filter((block) => {
          if (typeof block !== 'object' || block === null) return false;
          return (block as { type?: string }).type === 'tool_use';
        })
        .map((block) => (block as { id?: string }).id)
        .filter((id): id is string => !!id);

      if (moreIds.length === 0) break;
      roundIds.push(...moreIds);
      i++;
    }

    rounds.push({ start, end: i, ids: roundIds, results: [], missingIds: [] });
  }

  // ── Step 2: pair each round with its tool_results in chronological order ──
  const usedResults = new Set<ContentBlockParam>();
  for (const round of rounds) {
    for (const id of round.ids) {
      let found: ContentBlockParam | null = null;
      for (let j = round.end; j < messages.length; j++) {
        const m = messages[j];
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;

        for (const block of m.content) {
          if (typeof block !== 'object' || block === null) continue;
          if ((block as { type?: string }).type !== 'tool_result') continue;
          if ((block as { tool_use_id?: string }).tool_use_id === id && !usedResults.has(block)) {
            found = block;
            break;
          }
        }
        if (found) break;
      }

      if (found) {
        round.results.push(found);
        usedResults.add(found);
      } else {
        round.missingIds.push(id);
      }
    }
  }

  // ── Step 3: rebuild the message sequence ──────────────────────────────────
  const normalized: MessageParam[] = [];
  let reorderedRounds = 0;
  let synthesizedCount = 0;
  let roundIdx = 0;

  for (let mi = 0; mi < messages.length; mi++) {
    const round = rounds[roundIdx];
    if (!round || round.start !== mi) {
      // Normal message. Strip any tool_result blocks that were hoisted to
      // their correct round so they are not emitted twice.
      const m = messages[mi];
      if (m.role === 'user' && Array.isArray(m.content)) {
        const remaining = m.content.filter((block) => {
          if (typeof block !== 'object' || block === null) return true;
          if ((block as { type?: string }).type !== 'tool_result') return true;
          return !usedResults.has(block);
        });
        if (remaining.length > 0) {
          normalized.push({ ...m, content: remaining });
        }
      } else {
        normalized.push(m);
      }
      continue;
    }

    // Emit the assistant round first.
    if (round.missingIds.length > 0 && !synthesizeMissingToolResults) {
      // Non-recovery path: drop orphan tool_use blocks whose results are gone.
      for (let k = round.start; k < round.end; k++) {
        const m = messages[k];
        const filtered = (m.content as ContentBlockParam[]).filter((block) => {
          if (typeof block !== 'object' || block === null) return true;
          if ((block as { type?: string }).type !== 'tool_use') return true;
          const id = (block as { id?: string }).id;
          return id && !round.missingIds.includes(id);
        });
        normalized.push({
          ...m,
          content: filtered.length > 0
            ? filtered
            : [{ type: 'text', text: '(tool call removed)' } as ContentBlockParam],
        });
      }
      roundIdx++;
      mi = round.end - 1;
      continue;
    }

    for (let k = round.start; k < round.end; k++) {
      normalized.push(messages[k]);
    }

    // Then emit the paired results immediately after.
    const resultBlocks: ContentBlockParam[] = [...round.results];
    for (const missingId of round.missingIds) {
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: missingId,
        content: '<tool_error>Tool execution did not complete. This result was synthesized during conversation recovery.</tool_error>',
        is_error: true,
      } as ContentBlockParam);
      synthesizedCount++;
    }

    if (resultBlocks.length > 0) {
      normalized.push({ role: 'user', content: resultBlocks });
    }

    reorderedRounds++;
    roundIdx++;
    mi = round.end - 1;
  }

  if (reorderedRounds > 0) {
    console.warn(
      `[duya-ai] [toAnthropicMessages] Reordered ${reorderedRounds} tool round(s) so tool_result blocks immediately follow tool_use`,
    );
  }

  if (synthesizedCount > 0) {
    console.warn(
      `[duya-ai] [toAnthropicMessages] Synthesized ${synthesizedCount} missing tool_result block(s) for recovery`,
    );
  }

  return normalized;
}

/**
 * Recovery requests must not retain delayed tool results after a synthetic
 * result has already closed the tool round. Anthropic-compatible endpoints
 * accept tool_result blocks only in the user turn immediately after the
 * corresponding assistant tool_use turn.
 *
 * Copied from packages/agent/src/llm/anthropic-client.ts.
 */
function stripNonAdjacentToolResults(messages: MessageParam[]): MessageParam[] {
  return messages.map((message, index) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message;
    }

    const previous = messages[index - 1];
    const expectedIds = new Set<string>();
    if (previous?.role === 'assistant' && Array.isArray(previous.content)) {
      for (const block of previous.content) {
        if (typeof block !== 'object' || block === null || (block as { type?: string }).type !== 'tool_use') {
          continue;
        }
        const id = (block as { id?: string }).id;
        if (id) expectedIds.add(id);
      }
    }

    const seenIds = new Set<string>();
    const content = (message.content as ContentBlockParam[]).filter((block) => {
      if (typeof block !== 'object' || block === null || (block as { type?: string }).type !== 'tool_result') {
        return true;
      }
      const id = (block as { tool_use_id?: string }).tool_use_id;
      if (!id || !expectedIds.has(id) || seenIds.has(id)) {
        return false;
      }
      seenIds.add(id);
      return true;
    });

    if (content.length === message.content.length) {
      return message;
    }
    return content.length > 0
      ? { ...message, content }
      : { ...message, content: [{ type: 'text', text: '(delayed tool result removed)' } as ContentBlockParam] };
  });
}

/**
 * Detect duplicate tool_use IDs and rename each occurrence pair.
 *
 * Even with the global counter fix in the conversion step, a misbehaving
 * provider could emit the SAME non-empty tool_use.id across multiple calls.
 * We rename each *occurrence* of the duplicated id so that the Nth tool_use
 * with that id pairs with the Nth tool_result with the same tool_use_id.
 *
 * Copied from packages/agent/src/llm/anthropic-client.ts (step 2b).
 */
function renameDuplicateToolIds(result: MessageParam[]): MessageParam[] {
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

  if (duplicatedIds.size === 0) {
    return result;
  }

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

  console.warn(
    `[duya-ai] [toAnthropicMessages] Renamed ${duplicateUseIdRenamed} duplicate tool_use occurrence(s) ` +
      `for id(s): ${Array.from(duplicatedIds).join(', ')}`
  );

  return result;
}

// =============================================================================
// Thinking resolver
// =============================================================================

/**
 * Resolve the Anthropic `thinking` parameter from model capabilities and
 * user-requested effort level.
 *
 * - Non-reasoning models → undefined (thinking disabled).
 * - effort 'off' → undefined (thinking disabled).
 * - effort undefined (auto) → treated as 'medium' for reasoning models.
 * - model.compat?.forceAdaptiveThinking → { type: 'adaptive' } (MiniMax shape).
 * - Otherwise → { type: 'enabled', budget_tokens } capped at 80% of maxTokens.
 */
export function resolveAnthropicThinking(
  model: Model<'anthropic'>,
  effort?: string,
): { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' } | undefined {
  if (!model.reasoning) return undefined;
  if (effort === 'off') return undefined;

  const effectiveEffort = effort ?? 'medium';

  // MiniMax M3 and similar third-party endpoints accept only the adaptive shape.
  if (model.compat?.forceAdaptiveThinking) {
    return { type: 'adaptive' };
  }

  if (effectiveEffort === undefined) return undefined;

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

  const budget = BUDGET[effectiveEffort];
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
        // MiniMax-M3 (and possibly other third-party Anthropic-compatible
        // providers) occasionally return an empty `tool_use.id`. Synthesize
        // a stable, globally-unique ID at the source so the in-memory
        // assistant message, the tool executor, and the persisted
        // tool_result all carry the same ID — otherwise the next request
        // comes back with HTTP 400 "tool call id is invalid (2013)".
        const synthId = synthesizeRuntimeToolId(block.id);
        if (synthId !== block.id) {
          console.warn('[duya-ai] Synthesized tool_use.id — provider returned empty/invalid id', {
            toolName: block.name,
            originalId: block.id,
            synthId,
          });
        }
        const toolBlock: ToolUseContent = {
          type: 'tool_use',
          id: synthId,
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
      // message_delta carries stop_reason + usage but does NOT signal the
      // end of the stream — message_stop does. Returning `done` here would
      // produce two `done` SSE events (one from message_delta, one from
      // message_stop), causing DuyaAgent to push two assistant messages
      // and the frontend to render duplicate replies. Only update the
      // accumulated state and return a non-yielding `start` event.
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
      return { type: 'start', partial: assistantMsg };
    }

    case 'message_stop':
      return { type: 'done', reason: assistantMsg.stopReason || 'completed', message: assistantMsg };

    default:
      return { type: 'start', partial: assistantMsg };
  }
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * Pre-assign consistent synthetic IDs to tool_use/tool_result pairs whose
 * original IDs are empty or invalid.
 *
 * The per-block counter approach used in the main converter assumes that the
 * Nth empty tool_use and the Nth empty tool_result appear in the same global
 * order. That breaks when results arrive out of order (e.g. two parallel
 * calls where result B is persisted before result A). We therefore do a
 * separate pass first: number empty tool_use IDs in chronological order, then
 * number empty tool_result IDs in chronological order, and pair them by
 * position. If counts differ, the unmatched blocks keep empty IDs and are
 * cleaned up by the orphan-removal passes later.
 */
function hasNoValidToolId(toolId: string | undefined | null): boolean {
  return !(toolId || '').replace(VALID_ID_REGEX, '_');
}

function assignEmptyToolIds(messages: Message[]): Message[] {
  const emptyUsePositions: Array<{ msgIndex: number; blockIndex: number }> = [];
  const emptyResultPositions: Array<{ msgIndex: number; blockIndex: number }> = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach((block, bi) => {
        if (block.type === 'tool_use' && hasNoValidToolId(block.id)) {
          emptyUsePositions.push({ msgIndex: mi, blockIndex: bi });
        }
      });
    } else if (msg.role === 'tool') {
      if (hasNoValidToolId(msg.tool_call_id)) {
        emptyResultPositions.push({ msgIndex: mi, blockIndex: -1 });
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content.forEach((block, bi) => {
        if (block.type === 'tool_result' && hasNoValidToolId(block.tool_use_id)) {
          emptyResultPositions.push({ msgIndex: mi, blockIndex: bi });
        }
      });
    }
  }

  const syntheticIds = emptyUsePositions.map((_, i) => `tool_synth_${i.toString(36)}`);

  const result = messages.map(m => ({ ...m }));

  for (let i = 0; i < emptyUsePositions.length; i++) {
    const pos = emptyUsePositions[i];
    const msg = result[pos.msgIndex];
    if (Array.isArray(msg.content)) {
      const block = msg.content[pos.blockIndex];
      if (block.type === 'tool_use') {
        msg.content[pos.blockIndex] = { ...block, id: syntheticIds[i] };
      }
    }
  }

  for (let i = 0; i < emptyResultPositions.length; i++) {
    const pos = emptyResultPositions[i];
    if (i >= syntheticIds.length) break;
    const msg = result[pos.msgIndex];
    if (pos.blockIndex === -1) {
      msg.tool_call_id = syntheticIds[i];
    } else if (Array.isArray(msg.content)) {
      const block = msg.content[pos.blockIndex];
      if (block.type === 'tool_result') {
        msg.content[pos.blockIndex] = { ...block, tool_use_id: syntheticIds[i] };
      }
    }
  }

  return result;
}

/**
 * Convert duya Message[] to Anthropic MessageParam[].
 *
 * Full pipeline:
 * 0. assignEmptyToolIds — pair empty tool_use/tool_result IDs by position.
 * 1. Convert each Message to MessageParam, sanitizing remaining tool IDs.
 * 2. Rename duplicate tool_use IDs so occurrences pair chronologically.
 * 3. stripOrphanToolUses / stripOrphanToolResults — drop blocks with no
 *    counterpart anywhere in history. (stripOrphanToolUses is skipped in
 *    recovery mode so orphan calls survive to receive synthesized results.)
 * 4. normalizeToolResultOrdering — tool_result blocks must immediately
 *    follow the assistant tool_use turn; deferred user messages move later.
 * 5. mergeConsecutiveRoles — enforce strict role alternation.
 * 6. handleThinkingBlocks — strip/downgrade thinking per endpoint type.
 * 7. repairToolPairing — final safety net on the exact API payload.
 * 8. Recovery mode only: stripNonAdjacentToolResults — drop delayed results
 *    whose round was already closed by a synthesized failure.
 */
export function toAnthropicMessages(
  messages: Message[],
  model: Model<'anthropic'>,
  synthesizeMissingToolResults = false,
): MessageParam[] {
  // Step 0: Pair empty tool IDs before the main conversion pass.
  const messagesWithToolIds = assignEmptyToolIds(messages);

  // Step 1: Convert all messages to Anthropic format, sanitizing tool IDs.
  // Empty IDs were already synthesized in step 0, so sanitizeToolId will
  // only clean invalid characters here.
  const result: MessageParam[] = [];
  let emptyToolUseCounter = 0;
  let emptyToolResultCounter = 0;

  for (const msg of messagesWithToolIds) {
    if (msg.role === 'system') continue; // System goes in the `system` param.

    if (msg.role === 'tool') {
      // Standalone tool message → wrap as user/tool_result.
      // When content is a MessageContent[] array (tool returned inline images,
      // e.g. ReadTool on a pure image file), convert each block to its
      // Anthropic-native form so vision-capable models see the image directly.
      // transformMessages has already downgraded image blocks to placeholder
      // text for non-vision models, so here we can pass image blocks through.
      let toolContent: string | ContentBlockParam[];
      if (typeof msg.content === 'string') {
        toolContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        toolContent = msg.content
          .map((block) => convertContentBlock(block, model))
          .filter((block): block is ContentBlockParam => block !== null);
        if (toolContent.length === 0) toolContent = '';
      } else {
        toolContent = JSON.stringify(msg.content);
      }
      const toolUseId = sanitizeToolId(msg.tool_call_id || '', emptyToolResultCounter++);
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: toolContent,
        } as ContentBlockParam],
      });
      continue;
    }

    let content: ContentBlockParam[] = [];

    if (typeof msg.content === 'string') {
      // Plain string content — preserve as a single text block. Empty strings
      // are dropped at the merge step if adjacent to another message.
      content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const converted = convertContentBlock(block, model);
        if (converted) content.push(converted);
      }
    }

    // Sanitize tool IDs in a single pass so the counter value used for a
    // tool_use block (or tool_result block) is stable per position.
    if (msg.role === 'assistant') {
      content = content.map(block => {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
          const rawId = (block as { id?: string }).id || '';
          const sanitizedId = sanitizeToolId(rawId, emptyToolUseCounter++);
          return { ...block, id: sanitizedId } as ContentBlockParam;
        }
        return block;
      });
    } else {
      // user message — sanitize any embedded tool_result ids with the
      // shared result counter.
      content = content.map(block => {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result') {
          const rawId = (block as { tool_use_id?: string }).tool_use_id || '';
          const sanitizedId = sanitizeToolId(rawId, emptyToolResultCounter++);
          return { ...block, tool_use_id: sanitizedId } as ContentBlockParam;
        }
        return block;
      });
    }

    if (content.length > 0) {
      result.push({ role: msg.role as 'user' | 'assistant', content });
    } else if (msg.role === 'user') {
      // Preserve empty user turns so the request never has zero messages.
      result.push({ role: 'user', content: '' });
    }
  }

  // Step 2: Rename duplicate tool_use IDs (provider misbehavior guard).
  const deduped = renameDuplicateToolIds(result);

  // Step 3: Bidirectional orphan cleanup using GLOBAL id matching.
  // In recovery mode (synthesizeMissingToolResults), keep orphan tool_use
  // blocks: normalizeToolResultOrdering will synthesize a truthful failed
  // result for them instead of silently erasing the call.
  const withoutOrphanUses = synthesizeMissingToolResults
    ? deduped
    : stripOrphanToolUses(deduped);
  const withoutOrphans = stripOrphanToolResults(withoutOrphanUses);

  // Step 4: Restore provider-required ordering for complete tool rounds.
  // A global ID match alone is not enough: MiniMax rejects a task
  // notification between tool_use and tool_result with error 2013.
  const ordered = normalizeToolResultOrdering(withoutOrphans, synthesizeMissingToolResults);

  // Step 5: Merge consecutive same-role messages.
  const merged = mergeConsecutiveRoles(ordered);

  // Step 6: Handle thinking blocks according to endpoint type.
  const withThinkingHandled = handleThinkingBlocks(merged, model);

  // Step 7: Final tool pairing repair on the exact payload.
  const repaired = repairToolPairing(withThinkingHandled);

  // Step 8: In recovery, a delayed result cannot remain after its original
  // round has been closed with a synthetic failure result.
  return synthesizeMissingToolResults
    ? stripNonAdjacentToolResults(repaired)
    : repaired;
}

/**
 * Convert a single duya MessageContent block to an Anthropic ContentBlockParam.
 * Returns null for blocks that should be filtered out.
 *
 * Thinking blocks are intentionally dropped for MiniMax Anthropic-compatible
 * endpoints; replaying unsigned historical thinking blocks causes the model to
 * emit reasoning without any text reply. Signed thinking blocks are kept for
 * direct Anthropic replay. For cross-model cases, unsigned thinking was already
 * downgraded to text by transformMessages.
 */
function convertContentBlock(
  block: MessageContent,
  model: Model<'anthropic'>,
): ContentBlockParam | null {
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
    // emit the Anthropic tool_result block. Inline image blocks are preserved
    // so vision-capable models see them (transformMessages already
    // downgraded them to placeholder text for non-vision models).
    const resultContent: string | ContentBlockParam[] = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map(c => convertContentBlock(c, model))
            .filter((c): c is ContentBlockParam => c !== null)
        : '';
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: resultContent,
      is_error: block.is_error,
    } as unknown as ContentBlockParam;
  }
  if (block.type === 'thinking') {
    const isMiniMax = isMiniMaxEndpoint(model.baseUrl) || !!model.compat?.forceAdaptiveThinking;
    // Drop all thinking blocks for MiniMax; the endpoint cannot validate
    // signatures and replaying them breaks multi-turn text generation.
    if (isMiniMax) {
      return null;
    }
    // Include signed thinking blocks for direct Anthropic same-model replay.
    if (block.thinkingSignature) {
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.thinkingSignature,
      } as ContentBlockParam;
    }
    // Unsigned thinking for direct Anthropic cannot be validated, so drop it.
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

  // Prompt-cache eligibility is fixed per provider/model/endpoint, so
  // compute it once at factory time.
  const cacheEligibility = checkCacheEligibility(options.providerId, options.model, options.baseURL);

  // MiniMax detection: explicit provider id, endpoint shape, or the
  // adaptive-thinking compat flag (set for MiniMax routes in models.ts).
  const isMiniMax =
    options.providerId === 'minimax-anthropic' ||
    isMiniMaxEndpoint(options.baseURL) ||
    !!options.modelCapabilities?.forceAdaptiveThinking;

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
      let anthropicMessages = toAnthropicMessages(transformed, model);

      // 3.5. Apply prompt caching breakpoints when the provider supports it.
      if (cacheEligibility.eligible) {
        anthropicMessages = applyCacheControl(
          anthropicMessages,
          cacheEligibility,
          'short',
          options.baseURL,
        ) as MessageParam[];
      }

      // 4. Resolve thinking config from model + effort.
      // totalOutputBudget takes precedence over maxOutputTokens/maxTokens.
      // For Anthropic, max_tokens is the TOTAL output (thinking + text).
      // MiniMax rejects max_tokens above its per-model ceiling, so clamp.
      const requestedMaxTokens = chatOptions?.totalOutputBudget
        ?? chatOptions?.maxOutputTokens
        ?? chatOptions?.maxTokens
        ?? 4096;
      const maxTokens = isMiniMax
        ? Math.min(
            requestedMaxTokens,
            getMiniMaxAnthropicMaxTokens(options.model, chatOptions?.maxOutputTokens),
          )
        : requestedMaxTokens;

      // reasoningSettings takes precedence over the simple effort field.
      const effectiveEffort = chatOptions?.reasoningSettings?.intensity
        ?? chatOptions?.effort;
      let thinking = resolveAnthropicThinking(model, effectiveEffort);

      // Override budget_tokens if reasoningBudget is explicitly set.
      // For Anthropic, thinking.budget_tokens must be < max_tokens.
      if (thinking && chatOptions?.reasoningBudget && thinking.type === 'enabled') {
        const clampedBudget = Math.min(chatOptions.reasoningBudget, maxTokens - 1);
        thinking = { ...thinking, budget_tokens: clampedBudget };
      }

      // 'deep' mode: boost budget by 2x for extended thinking.
      if (chatOptions?.reasoningSettings?.mode === 'deep' && thinking?.type === 'enabled') {
        const currentBudget = thinking.budget_tokens ?? 4096;
        thinking = { ...thinking, budget_tokens: Math.min(currentBudget * 2, maxTokens - 1) };
      }
      // 'fast' mode: use minimal thinking budget.
      if (chatOptions?.reasoningSettings?.mode === 'fast' && thinking?.type === 'enabled') {
        thinking = { ...thinking, budget_tokens: 1024 };
      }

      // Final clamp: the API requires budget_tokens < max_tokens. The level
      // defaults (e.g. high → 16384) exceed small request budgets, so clamp
      // to the request-level ceiling regardless of how the budget was set.
      if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
        const clamped = Math.min(thinking.budget_tokens, maxTokens - 1);
        if (clamped < 1024) {
          // Anthropic requires budget_tokens >= 1024; the request budget
          // leaves no room for thinking — omit the field entirely.
          thinking = undefined;
        } else if (clamped !== thinking.budget_tokens) {
          thinking = { ...thinking, budget_tokens: clamped };
        }
      }

      // 5. Build request params. Tool names can originate in MCP servers,
      // so reject names the provider cannot represent before serializing.
      const requestedTools = chatOptions?.tools ?? [];
      const compatibleTools = requestedTools.filter((tool) => ANTHROPIC_TOOL_NAME_PATTERN.test(tool.name));
      const invalidToolNames = requestedTools
        .filter((tool) => !ANTHROPIC_TOOL_NAME_PATTERN.test(tool.name))
        .map((tool) => tool.name);
      if (invalidToolNames.length > 0) {
        console.warn('[duya-ai] Excluded tools with invalid Anthropic-compatible names', { invalidToolNames });
      }
      const tools = compatibleTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      }));

      const systemPromptForRequest = chatOptions?.systemPrompt || '';
      // Diagnostic: verify the assembled system prompt actually reaches the
      // wire. This is critical because third-party Anthropic-compatible
      // endpoints (MiniMax) may silently drop the `system` field.
      console.warn('[duya-ai] anthropic request system prompt', {
        length: systemPromptForRequest.length,
        hasMemorySection: systemPromptForRequest.includes('Persistent memory'),
        isMiniMax,
        model: options.model,
        preview: systemPromptForRequest.slice(0, 200),
      });
      const params: Anthropic.MessageCreateParams = {
        model: options.model,
        max_tokens: maxTokens,
        temperature: chatOptions?.temperature ?? 1,
        system: systemPromptForRequest,
        messages: anthropicMessages,
        tools: tools.length ? tools : undefined,
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

      // 6.5. Emit parameter diagnostics before the stream starts.
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

      // 7. Open the stream. If the provider rejects the payload with a
      // MiniMax 2013 or a tool-result ordering error, rebuild the history
      // with synthesized failure results for unclosed tool rounds and
      // retry exactly once.
      let stream: Awaited<ReturnType<typeof client.messages.stream>>;
      try {
        stream = await client.messages.stream(
          params,
          chatOptions?.signal ? { signal: chatOptions.signal } : undefined,
        );
      } catch (streamError) {
        const isMiniMax2013 = isMiniMax && isMiniMaxInvalidParameters2013(streamError);
        const isToolOrderingFailure = isToolResultOrderingError(streamError);
        if ((!isMiniMax2013 && !isToolOrderingFailure) || chatOptions?.signal?.aborted) {
          throw streamError;
        }

        // Some Anthropic-compatible providers identify the broken tool round
        // precisely, while MiniMax reports only `invalid params, 400 (2013)`.
        // Recover once with an exact, strict tool-result pairing repair.
        anthropicMessages = toAnthropicMessages(transformed, model, true);
        console.warn(
          '[duya-ai] Retrying once with repaired tool history after provider rejected tool-result ordering',
          { messageCount: anthropicMessages.length, isMiniMax2013 },
        );
        // Retry params intentionally omit `thinking`: with the reduced
        // recovery ceiling a carried-over budget_tokens could exceed
        // max_tokens and get rejected again.
        const retryParams: Anthropic.MessageCreateParams = {
          model: options.model,
          max_tokens: isMiniMax2013
            ? Math.min(maxTokens, MINIMAX_RECOVERY_MAX_TOKENS)
            : maxTokens,
          temperature: chatOptions?.temperature ?? 1,
          system: chatOptions?.systemPrompt || '',
          messages: anthropicMessages,
          tools: tools.length ? tools : undefined,
          stream: true,
        };
        // A second failure is thrown to the caller.
        stream = await client.messages.stream(
          retryParams,
          chatOptions?.signal ? { signal: chatOptions.signal } : undefined,
        );
      }

      // 8. Drain events (with idle timeout), parse, and yield SSE.
      // When the `done` internal event arrives (from message_stop), we
      // intercept it to ensure `result` (usage) is yielded BEFORE `done`.
      // DuyaAgent's `done` handler triggers turn finalization (pushing the
      // assistant message, executing tools); if `result` arrives after
      // `done`, usage tracking may be attributed to the wrong turn.
      let pendingDone: SSEEvent | null = null;
      for await (const event of withIdleTimeout<Anthropic.MessageStreamEvent>(stream)) {
        const internalEvent = parseAnthropicEvent(event, assistantMsg, state);
        if (internalEvent.type === 'done') {
          // Yield usage first, then the done event.
          if (internalEvent.message.usage) {
            yield { type: 'result', data: internalEvent.message.usage };
          }
          const doneSse = emitSSE(internalEvent);
          if (doneSse) {
            pendingDone = doneSse;
          }
        } else {
          const sse = emitSSE(internalEvent);
          if (sse) yield sse;
        }
      }
      if (pendingDone) {
        yield pendingDone;
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
