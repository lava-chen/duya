/**
 * Plan 241 Phase 3: tool_search discovery scanner.
 *
 * Pulls tool names out of `tool_search` `tool_result` content so the
 * caller can add them to the active tool set for the next turn.
 *
 * The agent runtime already pairs `assistant_message.tool_use[id]`
 * with `tool_result.tool_use_id` blocks; this helper operates on the
 * tool_result payload and assumes the caller has already filtered to
 * `tool_search` invocations (or is willing to ignore non-tool_search
 * JSON results — both are safe).
 */

import type { Message, MessageContent } from '../types.js';

/**
 * Extract tool names from a tool_result JSON payload produced by
 * `ToolSearchTool.execute`. The result shape is:
 *   {
 *     "query": "...",
 *     "results": [{ "name": "...", "description": "...", ... }, ...],
 *     "count": N
 *   }
 *
 * Returns an empty array on parse failure or missing fields. Never
 * throws — caller can drop the result on the floor without aborting
 * the streamChat.
 */
export function extractToolNamesFromSearchResult(resultText: string): string[] {
  if (!resultText || typeof resultText !== 'string') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const results = obj.results;
  if (!Array.isArray(results)) return [];

  const names: string[] = [];
  for (const entry of results) {
    if (entry && typeof entry === 'object' && typeof (entry as unknown as Record<string, unknown>).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/**
 * Convenience: scan a batch of `tool_result` Message objects and add
 * every discovered tool name into the provided Set. Returns the count
 * of new names added (useful for tests + log lines).
 */
export function harvestDiscoveredTools(
  toolResultMessages: readonly Message[],
  accumulator: Set<string>,
): number {
  let added = 0;
  for (const msg of toolResultMessages) {
    const content = msg.content;

    let text: string | null = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // tool_result content blocks are user-role MessageContent[]; the
      // payload sits in `content.content` for type==='tool_result'.
      const blocks = content as MessageContent[];
      for (const block of blocks) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_result') {
          const inner = b.content;
          if (typeof inner === 'string') {
            text = inner;
          } else if (Array.isArray(inner)) {
            text = inner
              .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
              .join('');
          }
          if (text !== null) break;
        }
      }
    }

    if (text === null) continue;
    const names = extractToolNamesFromSearchResult(text);
    for (const name of names) {
      if (!accumulator.has(name)) {
        accumulator.add(name);
        added++;
      }
    }
  }
  return added;
}