/**
 * packages/ai/src/utils/deferred-tools.ts
 *
 * Plan 418 Phase 4 — deferred tools (Anthropic tool-search style).
 *
 * When an endpoint declares `ModelCompat.supportsToolReferences`, tools that
 * were loaded on-demand at runtime (duya `tool_search`, plan 241) no longer
 * need their full schema resent on every turn. This module:
 *   - collects the deferred tool names from message history
 *     (`Message.addedToolNames` on tool-result carriers)
 *   - splits the request tool list into immediate (schema sent) vs deferred
 *     (schema omitted; provider emits a `tool_reference` block on later
 *     tool results instead)
 *
 * Mirrors the client-side mechanism in Claude Code / pi
 * (packages/ai/src/utils/deferred-tools.ts).
 */

import type { Message } from '../types.js';

/**
 * Collect every tool name that was loaded on-demand across the message
 * history. Only tool-result carriers (role 'tool') may carry
 * `addedToolNames`; the field is ignored anywhere else.
 */
export function getDeferredToolNames(messages: readonly Message[]): Set<string> {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.addedToolNames?.length) {
      for (const name of msg.addedToolNames) names.add(name);
    }
  }
  return names;
}

/**
 * Split the request tool list into immediate (schema sent in `tools`) and
 * deferred (schema omitted; referenced via `tool_reference` on later turns).
 * Deferred names that are not part of the current tool list are ignored.
 */
export function splitDeferredTools<T extends { name: string }>(
  tools: ReadonlyArray<T>,
  deferredNames: ReadonlySet<string>,
): { immediate: T[]; deferred: T[] } {
  const immediate: T[] = [];
  const deferred: T[] = [];
  for (const tool of tools) {
    if (deferredNames.has(tool.name)) {
      deferred.push(tool);
    } else {
      immediate.push(tool);
    }
  }
  return { immediate, deferred };
}
