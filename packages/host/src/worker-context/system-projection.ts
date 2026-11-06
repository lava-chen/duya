/**
 * Plan 624 B2 — stop discarding post-compaction system content.
 *
 * `projectSystemPrompt` returns either a string or an array of content blocks.
 * The host used to throw the entire array away whenever ANY block was
 * structured (plan 619 defect b), which also discarded every plain text block
 * next to it. That is exactly what happens after a compaction: the entry's
 * `reinjectedSystemMessages` are the only channel carrying legacy system
 * content into the next request, and they were silently lost.
 *
 * A system prompt on this boundary is a string, so text blocks are flattened
 * and non-text blocks are counted. The count is still reported: an image or a
 * tool_use block genuinely cannot be represented here, and pretending otherwise
 * would turn a visible loss into an invisible one.
 */
export interface FlattenedSystemProjection {
  readonly text: string;
  /** Blocks that cannot live in a string system prompt. */
  readonly unrepresentableBlocks: number;
}

export function flattenSystemProjection(
  projected: string | readonly unknown[],
): FlattenedSystemProjection {
  if (typeof projected === 'string') {
    return { text: projected, unrepresentableBlocks: 0 };
  }

  const parts: string[] = [];
  let unrepresentableBlocks = 0;
  for (const block of projected) {
    if (typeof block === 'string') {
      if (block.length > 0) parts.push(block);
      continue;
    }
    if (
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type?: unknown }).type === 'text'
    ) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        parts.push(text);
        continue;
      }
    }
    unrepresentableBlocks += 1;
  }
  return { text: parts.join('\n\n'), unrepresentableBlocks };
}
