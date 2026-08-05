/**
 * Provider-specific message transformation helpers.
 *
 * This module consolidates the provider transformation logic (previously
 * scattered across anthropic-client.ts and openai-client.ts) into a single
 * boundary. It exposes:
 *
 * - {@link toAnthropicMessages}: converts legacy `Message[]` to Anthropic
 *   message params (tool ID sanitization, orphan cleanup, role alternation,
 *   thinking handling, pairing repair).
 * - {@link toOpenAIMessages}: converts legacy `Message[]` to OpenAI chat
 *   messages (content conversion, tool_call extraction, CDN URL filtering,
 *   tool message normalization).
 */

import type {
  ImageContent,
  Message,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
} from '../types.js';
import { isCDNImageUrl, isSafeUrlSync } from '../utils/urlSafety.js';

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Minimal Anthropic content block representation. Avoids a direct dependency
 * on `@anthropic-ai/sdk` types to prevent circular imports. The projector
 * output is consumed by the Anthropic client, which casts to the SDK types.
 */
export interface AnthropicContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Minimal Anthropic message param. Anthropic requires strict role alternation
 * between 'user' and 'assistant'; system content is carried separately.
 */
export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * Minimal OpenAI chat message representation. Avoids a direct dependency on
 * the `openai` package types.
 */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | readonly OpenAIContentPart[] | null;
  tool_calls?: readonly OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

// ─── Anthropic transformation helpers ───────────────────────────────────

/** Valid ID characters for Anthropic API: alphanumeric, underscore, hyphen. */
const ANTHROPIC_VALID_ID_REGEX = /[^a-zA-Z0-9_-]/g;

/** Content block types that represent thinking output. */
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/**
 * Sanitize a tool call ID for the Anthropic API.
 * Replaces invalid characters with underscores and synthesizes a deterministic
 * ID when the result would be empty.
 */
function sanitizeToolId(toolId: string, synthCounter: number): string {
  const cleaned = (toolId || '').replace(ANTHROPIC_VALID_ID_REGEX, '_');
  if (cleaned) {
    return cleaned;
  }
  return `tool_synth_${synthCounter.toString(36)}`;
}

/**
 * Check if a base URL represents a third-party Anthropic-compatible endpoint.
 * Third-party proxies cannot validate Anthropic thinking signatures.
 */
function isThirdPartyEndpoint(baseURL?: string): boolean {
  if (!baseURL) {
    return false;
  }
  const normalized = baseURL.replace(/\/$/, '').toLowerCase();
  if (normalized.includes('anthropic.com')) {
    return false;
  }
  return true;
}

/**
 * Convert a single duya content block to the Anthropic format.
 * Returns `null` for blocks that should be filtered out (e.g. tool_result
 * in assistant content, CDN image URLs, unsafe URLs).
 */
function convertContentBlockToAnthropic(
  block: MessageContent,
): AnthropicContentBlock | null {
  if (block.type === 'text') {
    return { type: 'text', text: (block as TextContent).text };
  }
  if (block.type === 'tool_use') {
    const toolBlock = block as ToolUseContent;
    return {
      type: 'tool_use',
      id: toolBlock.id,
      name: toolBlock.name,
      input: toolBlock.input,
    };
  }
  if (block.type === 'tool_result') {
    // tool_result blocks are handled separately as user-role messages.
    return null;
  }
  if (block.type === 'image') {
    const imgBlock = block as ImageContent;
    if (imgBlock.source.type === 'base64') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imgBlock.source.media_type,
          data: imgBlock.source.data,
        },
      };
    }
    if (isCDNImageUrl(imgBlock.source.data)) {
      return null;
    }
    const urlSafety = isSafeUrlSync(imgBlock.source.data);
    if (!urlSafety.safe) {
      return null;
    }
    return {
      type: 'image',
      source: { type: 'url', url: imgBlock.source.data },
    };
  }
  if (block.type === 'thinking') {
    const thinkBlock = block as ThinkingContent;
    return {
      type: 'thinking',
      thinking: thinkBlock.thinking,
      signature: thinkBlock.thinkingSignature ?? '',
    };
  }
  return { type: 'text', text: String(block) };
}

/**
 * Convert duya Message[] to Anthropic MessageParam[].
 *
 * Pipeline (simplified equivalent of anthropic-client.ts `toAnthropicMessages`):
 * 1. Convert each message, sanitizing tool IDs with a global counter.
 * 2. Bidirectional orphan cleanup (tool_use without result, result without use).
 * 3. Rename duplicate tool_use IDs so each occurrence pairs correctly.
 * 4. Restore tool_result ordering (results immediately follow their tool_use).
 * 5. Merge consecutive same-role messages.
 * 6. Handle thinking blocks according to endpoint type.
 * 7. Final tool pairing repair (safety net).
 */
export function toAnthropicMessages(
  messages: readonly Message[],
  baseURL?: string,
  synthesizeMissingToolResults = false,
): AnthropicMessageParam[] {
  // Step 1: Convert all messages, sanitizing tool IDs.
  let emptyToolUseCounter = 0;
  let emptyToolResultCounter = 0;

  const converted: AnthropicMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    if (msg.role === 'user') {
      const content = convertContentToAnthropic(msg.content);
      converted.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const rawContent = convertContentToAnthropic(msg.content);
      if (Array.isArray(rawContent)) {
        const sanitized = rawContent.map(block => {
          if (block.type === 'tool_use') {
            const rawId = (block.id as string) || '';
            const sanitizedId = sanitizeToolId(rawId, emptyToolUseCounter++);
            return { ...block, id: sanitizedId };
          }
          return block;
        });
        converted.push({ role: 'assistant', content: sanitized });
      } else {
        converted.push({ role: 'assistant', content: rawContent });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      const toolUseId = sanitizeToolId(msg.tool_call_id || '', emptyToolResultCounter++);
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: toolContent,
        }],
      });
      continue;
    }
  }

  // Step 2: Bidirectional orphan cleanup. In recovery mode, orphan tool_use
  // blocks are kept so they can receive a synthetic failed result below.
  let result = stripOrphanToolBlocks(converted, synthesizeMissingToolResults);

  // Step 3: Rename duplicate tool_use IDs.
  result = renameDuplicateToolIds(result);

  // Step 4: Restore tool_result ordering (results immediately follow their
  // tool_use), synthesizing missing results during recovery.
  result = normalizeToolResultOrder(result, synthesizeMissingToolResults);

  // Step 5: Merge consecutive same-role messages.
  result = mergeConsecutiveRoles(result);

  // Step 6: Handle thinking blocks.
  result = handleThinkingBlocks(result, baseURL);

  // Step 7: Final tool pairing repair.
  result = repairToolPairing(result);

  // Step 8: In recovery, a delayed result cannot remain after its original
  // round has been closed with a synthetic failure result. Remove it so every
  // retained tool_result belongs to the directly preceding assistant turn.
  if (synthesizeMissingToolResults) {
    result = stripNonAdjacentToolResults(result);
  }

  return result;
}

/**
 * Convert duya MessageContent to Anthropic content format.
 * Handles string content that may be a stringified JSON array (DB storage).
 */
function convertContentToAnthropic(
  content: string | MessageContent[],
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') {
    if (content.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          const blocks = parsed
            .map(convertContentBlockToAnthropic)
            .filter((b): b is AnthropicContentBlock => b !== null);
          if (blocks.length > 0) {
            return blocks;
          }
        }
      } catch {
        // Not JSON — treat as plain text.
      }
    }
    return content;
  }

  if (Array.isArray(content)) {
    const blocks = content
      .map(convertContentBlockToAnthropic)
      .filter((b): b is AnthropicContentBlock => b !== null);
    return blocks;
  }

  return String(content);
}

/**
 * Bidirectional orphan cleanup: remove tool_use blocks without a matching
 * tool_result and vice versa. When a message becomes empty after filtering,
 * replace its content with a text placeholder so adjacent content survives.
 *
 * In recovery mode (`retainOrphanToolUses`), orphan tool_use blocks are kept
 * so {@link normalizeToolResultOrder} can synthesize a failed result for them.
 */
function stripOrphanToolBlocks(
  messages: AnthropicMessageParam[],
  retainOrphanToolUses = false,
): AnthropicMessageParam[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const id = (block.id as string) || '';
        if (id) toolUseIds.add(id);
      } else if (block.type === 'tool_result') {
        const id = (block.tool_use_id as string) || '';
        if (id) toolResultIds.add(id);
      }
    }
  }

  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;

    const filtered = msg.content.filter(block => {
      if (block.type === 'tool_use') {
        const id = (block.id as string) || '';
        if (retainOrphanToolUses) return true;
        return toolResultIds.has(id);
      }
      if (block.type === 'tool_result') {
        const id = (block.tool_use_id as string) || '';
        return toolUseIds.has(id);
      }
      return true;
    });

    if (filtered.length === 0) {
      const placeholder = msg.role === 'assistant'
        ? '(tool call removed)'
        : '(orphaned tool result removed)';
      return { ...msg, content: [{ type: 'text', text: placeholder }] };
    }
    return { ...msg, content: filtered };
  });
}

/**
 * Detect and rename duplicate tool_use IDs so each occurrence pairs with the
 * correct tool_result. The first occurrence keeps the original ID; subsequent
 * occurrences get `tool_dup_<n>`.
 */
function renameDuplicateToolIds(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const useIdCounts = new Map<string, number>();
  const resultIdCounts = new Map<string, number>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const id = (block.id as string) || '';
        if (id) useIdCounts.set(id, (useIdCounts.get(id) || 0) + 1);
      } else if (block.type === 'tool_result') {
        const id = (block.tool_use_id as string) || '';
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
    return messages;
  }

  const occurrenceIndex = new Map<string, number>();
  const idMappings = new Map<string, Map<number, string>>();
  let dupCounter = 0;

  // Rename tool_use occurrences (first keeps original, rest get tool_dup_<n>).
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type !== 'tool_use') continue;
      const id = (block.id as string) || '';
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
        finalId = idx === 0 ? id : `tool_dup_${dupCounter++}`;
        perIdMap.set(idx, finalId);
      }
      if (finalId !== id) {
        msg.content[bi] = { ...block, id: finalId };
      }
    }
  }

  // Rename tool_result occurrences using the same chronological mapping.
  occurrenceIndex.clear();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type !== 'tool_result') continue;
      const id = (block.tool_use_id as string) || '';
      if (!id || !duplicatedIds.has(id)) continue;
      const idx = occurrenceIndex.get(id) || 0;
      occurrenceIndex.set(id, idx + 1);
      const perIdMap = idMappings.get(id);
      const finalId = perIdMap?.get(idx);
      if (finalId && finalId !== id) {
        msg.content[bi] = { ...block, tool_use_id: finalId };
      }
    }
  }

  return messages;
}

/**
 * Restore strict tool_use → tool_result ordering.
 *
 * Anthropic-compatible providers require tool_result blocks to immediately
 * follow the assistant tool_use turn. This simplified version collects
 * matching results and emits them right after the assistant round, deferring
 * any intervening content. The full implementation (handling consecutive
 * assistant rounds, synthesized results, etc.) will be unified during the
 * client refactor.
 */
function normalizeToolResultOrder(
  messages: AnthropicMessageParam[],
  synthesizeMissingToolResults: boolean,
): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      continue;
    }

    const toolUseIds = msg.content
      .filter(b => b.type === 'tool_use')
      .map(b => (b.id as string) || '')
      .filter(Boolean);

    if (toolUseIds.length === 0) {
      continue;
    }

    const pendingIds = new Set(toolUseIds);
    const resultBlocks: AnthropicContentBlock[] = [];
    const deferred: AnthropicMessageParam[] = [];
    let consumedUpTo = i;

    for (let j = i + 1; j < messages.length && pendingIds.size > 0; j++) {
      const next = messages[j];

      if (next.role === 'assistant') {
        // An assistant message with tool_use starts a new round.
        if (Array.isArray(next.content) && next.content.some(b => b.type === 'tool_use')) {
          deferred.push(next);
          consumedUpTo = j;
          break;
        }
        // Text-only assistant — defer and keep scanning.
        deferred.push(next);
        consumedUpTo = j;
        continue;
      }

      consumedUpTo = j;

      if (next.role === 'user' && Array.isArray(next.content)) {
        const matching = next.content.filter(b => {
          if (b.type !== 'tool_result') return false;
          const id = (b.tool_use_id as string) || '';
          return id !== '' && pendingIds.has(id);
        });

        if (matching.length > 0) {
          for (const block of matching) {
            const id = (block.tool_use_id as string) || '';
            if (id) pendingIds.delete(id);
            resultBlocks.push(block);
          }
          const remaining = next.content.filter(b => !matching.includes(b));
          if (remaining.length > 0) {
            deferred.push({ ...next, content: remaining });
          }
          continue;
        }
      }

      deferred.push(next);
    }

    if (pendingIds.size > 0 && synthesizeMissingToolResults) {
      for (const id of pendingIds) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: '<tool_error>Tool execution did not complete. This result was synthesized during conversation recovery.</tool_error>',
          is_error: true,
        });
      }
    }

    if (resultBlocks.length > 0) {
      result.push({ role: 'user', content: resultBlocks });
    }
    result.push(...deferred);
    i = consumedUpTo;
  }

  return result;
}

/**
 * Enforce strict role alternation by merging consecutive same-role messages.
 * - Consecutive user messages: merge content.
 * - Consecutive assistant messages: drop thinking blocks from the second,
 *   then merge remaining content.
 */
function mergeConsecutiveRoles(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];

  for (const m of messages) {
    if (result.length > 0 && result[result.length - 1].role === m.role) {
      const prev = result[result.length - 1];
      const prevContent = prev.content;
      const currContent = m.content;

      if (m.role === 'user') {
        prev.content = mergeContent(prevContent, currContent);
      } else {
        // assistant: strip thinking from the second message before merging.
        const filteredCurr = Array.isArray(currContent)
          ? currContent.filter(b => !THINKING_TYPES.has(b.type))
          : currContent;
        const normalizedCurr = Array.isArray(filteredCurr) && filteredCurr.length === 0
          ? [{ type: 'text', text: '(empty)' }]
          : filteredCurr;
        prev.content = mergeContent(prevContent, normalizedCurr);
      }
    } else {
      result.push({ ...m });
    }
  }

  return result;
}

function mergeContent(
  prev: string | AnthropicContentBlock[],
  curr: string | AnthropicContentBlock[],
): string | AnthropicContentBlock[] {
  if (typeof prev === 'string' && typeof curr === 'string') {
    return prev + '\n' + curr;
  }
  const prevArr = typeof prev === 'string'
    ? [{ type: 'text', text: prev }]
    : [...prev];
  const currArr = typeof curr === 'string'
    ? [{ type: 'text', text: curr }]
    : [...curr];
  return [...prevArr, ...currArr];
}

/**
 * Handle thinking blocks according to endpoint type:
 * - Third-party: strip ALL thinking blocks (cannot validate signatures).
 * - Direct Anthropic, non-last assistant: strip ALL thinking blocks.
 * - Direct Anthropic, last assistant: keep signed thinking, downgrade
 *   unsigned to text.
 * - Strip cache_control from remaining thinking blocks.
 */
function handleThinkingBlocks(
  messages: AnthropicMessageParam[],
  baseURL?: string,
): AnthropicMessageParam[] {
  const isThirdParty = isThirdPartyEndpoint(baseURL);

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

    let newContent: AnthropicContentBlock[];

    if (isThirdParty || idx !== lastAssistantIdx) {
      // Strip ALL thinking blocks.
      newContent = m.content.filter(b => !THINKING_TYPES.has(b.type));
    } else {
      // Last assistant on direct Anthropic: selective handling.
      newContent = [];
      for (const b of m.content) {
        if (!THINKING_TYPES.has(b.type)) {
          newContent.push(b);
          continue;
        }
        if (b.type === 'redacted_thinking') {
          if (b.data) newContent.push(b);
        } else if (b.signature) {
          newContent.push(b);
        } else {
          const thinkingText = (b.thinking as string) || '';
          if (thinkingText) {
            newContent.push({ type: 'text', text: thinkingText });
          }
        }
      }
    }

    if (newContent.length === 0) {
      newContent = [{ type: 'text', text: '(empty)' }];
    }

    // Strip cache_control from thinking blocks.
    for (const b of newContent) {
      if (THINKING_TYPES.has(b.type)) {
        delete (b as Record<string, unknown>).cache_control;
      }
    }

    return { ...m, content: newContent };
  });
}

/**
 * Final safety net: ensure every tool_result has a matching tool_use and
 * every tool_use has a matching tool_result. Removes any remaining
 * unmatched blocks.
 */
function repairToolPairing(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const id = (b.id as string) || '';
        if (id) toolUseIds.add(id);
      } else if (b.type === 'tool_result') {
        const id = (b.tool_use_id as string) || '';
        if (id) toolResultIds.add(id);
      }
    }
  }

  const unmatchedUses = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) unmatchedUses.add(id);
  }
  const unmatchedResults = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) unmatchedResults.add(id);
  }

  if (unmatchedUses.size === 0 && unmatchedResults.size === 0) {
    return messages;
  }

  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;

    const filtered = m.content.filter(b => {
      if (b.type === 'tool_use') {
        const id = (b.id as string) || '';
        return !unmatchedUses.has(id);
      }
      if (b.type === 'tool_result') {
        const id = (b.tool_use_id as string) || '';
        return !unmatchedResults.has(id);
      }
      return true;
    });

    if (filtered.length === 0) {
      const placeholder = m.role === 'assistant'
        ? '(tool call removed)'
        : '(orphaned tool result removed)';
      return { ...m, content: [{ type: 'text', text: placeholder }] };
    }
    return { ...m, content: filtered };
  });
}

// ─── OpenAI transformation helpers ──────────────────────────────────────

/** CDN image URL patterns to strip from OpenAI message content. */
/**
 * Recovery requests must not retain delayed tool results after a synthetic
 * result has already closed the tool round. Anthropic-compatible endpoints
 * accept tool_result blocks only in the user turn immediately after the
 * corresponding assistant tool_use turn.
 */
function stripNonAdjacentToolResults(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  return messages.map((message, index) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message;
    }

    const previous = messages[index - 1];
    const expectedIds = new Set<string>();
    if (previous?.role === 'assistant' && Array.isArray(previous.content)) {
      for (const block of previous.content) {
        if (block.type !== 'tool_use') continue;
        const id = (block.id as string) || '';
        if (id) expectedIds.add(id);
      }
    }

    const seenIds = new Set<string>();
    const content = message.content.filter((block) => {
      if (block.type !== 'tool_result') return true;
      const id = (block.tool_use_id as string) || '';
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
      : { ...message, content: [{ type: 'text', text: '(delayed tool result removed)' }] };
  });
}
const CDN_IMAGE_DOMAIN_PATTERNS = [
  /https?:\/\/[^\s]*\.oss-cn-[a-z0-9-]+\.aliyuncs\.com[^\s]*/gi,
  /https?:\/\/[^\s]*\.minimax\.io[^\s]*/gi,
  /https?:\/\/[^\s]*\.minimaxi\.com[^\s]*/gi,
  /https?:\/\/[^/]*\.alicdn\.com[^\s]*/gi,
  /https?:\/\/[^/]*\.aliyuncs\.com[^\s]*/gi,
];

function stripCDNUrlsFromText(text: string): string {
  let result = text;
  for (const pattern of CDN_IMAGE_DOMAIN_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

/**
 * Filter CDN image URLs from OpenAI content parts.
 */
function filterCDNImageUrls(
  parts: OpenAIContentPart[],
): OpenAIContentPart[] {
  return parts.filter(part => {
    if (part.type === 'image_url') {
      const url = (part as { image_url?: { url?: string } }).image_url?.url;
      if (typeof url === 'string' && isCDNImageUrl(url)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Parse message content that may be stored as a stringified JSON array.
 */
function parseMessageContent(
  content: string | MessageContent[],
): string | MessageContent[] {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as MessageContent[];
      }
    } catch {
      // Not JSON — return as-is.
    }
  }
  return content;
}

/**
 * Convert duya MessageContent to OpenAI content parts format.
 */
function convertContentToOpenAI(
  content: string | MessageContent[],
): string | OpenAIContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const parts: OpenAIContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: (block as TextContent).text });
    } else if (block.type === 'image') {
      const imgBlock = block as ImageContent;
      if (imgBlock.source.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`,
          },
        });
      } else if (!isCDNImageUrl(imgBlock.source.data)) {
        parts.push({
          type: 'image_url',
          image_url: { url: imgBlock.source.data },
        });
      }
    }
    // tool_result and tool_use are handled separately.
  }
  return parts;
}

/**
 * Extract tool_use blocks from assistant content as OpenAI tool_calls.
 */
function extractToolCalls(
  content: string | MessageContent[],
): OpenAIToolCall[] | undefined {
  if (typeof content === 'string') return undefined;

  const toolCalls: OpenAIToolCall[] = [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      const toolBlock = block as ToolUseContent;
      toolCalls.push({
        id: toolBlock.id,
        type: 'function',
        function: {
          name: toolBlock.name,
          arguments: JSON.stringify(toolBlock.input),
        },
      });
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Convert duya Message[] to OpenAI ChatCompletionMessageParam[].
 *
 * Equivalent of openai-client.ts `toOpenAIMessages` with the following
 * transformations:
 * 1. Convert each message to OpenAI format.
 * 2. Filter CDN image URLs from content parts.
 * 3. Strip CDN URLs from assistant text content.
 * 4. Skip empty assistant messages (thinking-only artifacts).
 * 5. Normalize tool message ordering (drop pending tool calls without results).
 */
export function toOpenAIMessages(
  messages: readonly Message[],
  includeToolCalls: boolean,
): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: String(msg.content) });
      continue;
    }

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        if (includeToolCalls) {
          for (const block of toolResultBlocks) {
            const resultBlock = block as ToolResultContent;
            result.push({
              role: 'tool',
              tool_call_id: resultBlock.tool_use_id,
              content: typeof resultBlock.content === 'string'
                ? resultBlock.content
                : JSON.stringify(resultBlock.content),
            });
          }
        }

        if (otherBlocks.length > 0) {
          const content = convertContentToOpenAI(otherBlocks);
          if (typeof content === 'string') {
            result.push({ role: 'user', content });
          } else {
            const filtered = filterCDNImageUrls(content);
            if (filtered.length > 0) {
              result.push({ role: 'user', content: filtered });
            }
          }
        }
      } else {
        result.push({ role: 'user', content: String(msg.content) });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const parsedContent = parseMessageContent(msg.content);
      const toolCalls = includeToolCalls ? extractToolCalls(parsedContent) : undefined;

      let textContent = '';
      if (typeof parsedContent === 'string') {
        textContent = parsedContent;
      } else if (Array.isArray(parsedContent)) {
        for (const block of parsedContent) {
          if (block.type === 'text') {
            textContent += (block as TextContent).text;
          }
        }
      }
      textContent = stripCDNUrlsFromText(textContent);

      if (!textContent.trim() && (!toolCalls || toolCalls.length === 0)) {
        continue;
      }

      const assistantMsg: OpenAIChatMessage = {
        role: 'assistant',
        content: textContent || null,
      };
      if (toolCalls) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
      continue;
    }

    if (msg.role === 'tool') {
      if (includeToolCalls) {
        result.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id || '',
          content: typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content),
        });
      }
      continue;
    }
  }

  return normalizeOpenAIToolMessages(result);
}

/**
 * Drop pending tool calls from the last assistant message when no matching
 * tool result follows.
 */
function dropPendingToolCalls(
  messages: OpenAIChatMessage[],
  pendingToolCallIds: Set<string>,
): void {
  if (pendingToolCallIds.size === 0) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      continue;
    }

    const keptToolCalls = message.tool_calls.filter(
      tc => !pendingToolCallIds.has(tc.id),
    );
    if (keptToolCalls.length > 0) {
      messages[i] = { ...message, tool_calls: keptToolCalls };
    } else {
      const { tool_calls: _dropped, ...rest } = message;
      if (rest.content === null || rest.content === '') {
        messages.splice(i, 1);
      } else {
        messages[i] = rest;
      }
    }
    pendingToolCallIds.clear();
    return;
  }

  pendingToolCallIds.clear();
}

/**
 * Normalize tool message ordering: ensure every assistant tool_call has a
 * matching tool result. Pending tool calls without results are dropped.
 */
function normalizeOpenAIToolMessages(
  messages: OpenAIChatMessage[],
): OpenAIChatMessage[] {
  const normalized: OpenAIChatMessage[] = [];
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id;
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        normalized.push(message);
        pendingToolCallIds.delete(toolCallId);
      }
      continue;
    }

    dropPendingToolCalls(normalized, pendingToolCallIds);
    normalized.push(message);

    if (message.role === 'assistant' && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        pendingToolCallIds.add(toolCall.id);
      }
    }
  }

  dropPendingToolCalls(normalized, pendingToolCallIds);
  return normalized;
}