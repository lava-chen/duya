/**
 * Compact utilities used by the strategies.
 *
 * The legacy LLM-based `compactHistory` / `estimateContextTokens` /
 * `needsCompression` entry points were removed — the append-only
 * `MessageCompactionController` + `CompactionManager` is the only live
 * compaction path. What remains here is shared by the strategies.
 */

import type { Message } from '../types.js'

// Re-exported for DuyaAgent (kept in sync with DEFAULT_CONTEXT_WINDOW in types.js)
export { DEFAULT_CONTEXT_WINDOW } from './types.js'

/**
 * Adjust a slice boundary so it does not fall in the middle of a
 * tool_use/tool_result round-trip. If the message at `startIndex`
 * is a user message containing tool_result blocks (orphaned
 * tool_result whose matching assistant(tool_use) would be left in
 * the discarded portion), scan backwards to find the matching
 * assistant message and move the start index before it.
 *
 * Returns the adjusted start index (possibly the same as input).
 */
export function adjustSliceBoundary(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjustedStart = startIndex;

  // Keep expanding backwards as long as the first message in the
  // "recent" slice is an orphaned tool_result (user message with
  // tool_result blocks whose matching tool_use is outside the slice).
  while (adjustedStart > 0) {
    const msg = messages[adjustedStart];
    if (!msg) break;

    const isUserWithToolResult =
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (b) => (b as unknown as Record<string, unknown>).type === 'tool_result',
      );

    if (!isUserWithToolResult) break;

    // Collect tool_use_ids from the orphaned tool_result blocks
    const toolUseIds = new Set<string>();
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          toolUseIds.add(b.tool_use_id);
        }
      }
    }

    // Scan backwards to find the assistant message containing the
    // matching tool_use blocks
    let foundIndex = -1;
    for (let j = adjustedStart - 1; j >= 0; j--) {
      const prevMsg = messages[j];
      if (!prevMsg) break;
      if (
        prevMsg.role === 'assistant' &&
        Array.isArray(prevMsg.content)
      ) {
        const hasMatchingToolUse = prevMsg.content.some((block) => {
          const b = block as unknown as Record<string, unknown>;
          return b.type === 'tool_use' && typeof b.id === 'string' && toolUseIds.has(b.id);
        });
        if (hasMatchingToolUse) {
          foundIndex = j;
          break;
        }
      }
    }

    if (foundIndex < 0) break;

    // Move the start index before the assistant message so the
    // tool_use/tool_result pair stays together in the "recent" slice.
    adjustedStart = foundIndex;
    // The new first message is now an assistant message, so the loop
    // condition (isUserWithToolResult) will be false and exit.
  }

  return adjustedStart;
}