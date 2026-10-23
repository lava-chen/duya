/**
 * The volatile-context rail (plan 619 Phase 3).
 *
 * The system prompt is the provider's cache prefix: the more of it that
 * changes between turns, the less of it the provider can reuse. The parts
 * that change every turn — the working directory, the memory projection,
 * the skill catalog — are therefore delivered through the MESSAGE channel
 * instead, wrapped in a `<system-reminder>` envelope so the model reads
 * them as system information rather than as something the user typed.
 *
 * The rail follows the same rules as the hook rail
 * (`worker-hooks/injection.ts`), with two differences that matter:
 *
 *   - its own metadata key namespace, so a hook block and a context block
 *     with the same content cannot dedupe each other away, and
 *   - it removes blocks that are no longer wanted. A section that stops
 *     rendering (the Apps catalog empties out) must not keep its stale text
 *     in the request.
 *
 * The rail lives in the working array only: it is never appended to the
 * session timeline, so it cannot pile up and does not survive into the
 * transcript.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ReminderSourceId } from '@duya/agent-core/context/reminder-sources';
import { renderUserChannelReminder } from '@duya/agent-core/context/reminders';

import type { InjectableMessage } from '../worker-hooks/injection.js';

/** Metadata key holding the rail block's id (its stable slot name). */
export const CONTEXT_RAIL_KEY_METADATA = 'contextRailKey';
/** Metadata key holding the hash of the block's rendered text. */
export const CONTEXT_RAIL_HASH_METADATA = 'contextRailHash';

/** One block of volatile context. */
export interface ContextBlock {
  /** Stable slot name — the prompt section name, for example. */
  readonly id: string
  /** The taxonomy entry the block is rendered under. */
  readonly source: ReminderSourceId
  /** The raw text, before the reminder envelope. */
  readonly content: string
}

/**
 * Deliver the rail into a provider message array.
 *
 * The array is rebuilt from the session timeline on every request, so this
 * never accumulates: a block is present exactly once per request, with
 * the current turn's text.
 */
export function applyContextRail(
  messages: InjectableMessage[],
  blocks: readonly ContextBlock[],
  opts: { now: number },
): void {
  if (blocks.length === 0) {
    removeOrphanedRailBlocks(messages, new Set<string>());
    return;
  }

  const wanted = new Map<string, ContextBlock>();
  for (const block of blocks) {
    wanted.set(block.id, block);
  }
  removeOrphanedRailBlocks(messages, new Set(wanted.keys()));

  for (const block of wanted.values()) {
    const content = renderUserChannelReminder(block.content, block.source);
    const hash = hashContext(content);
    const existing = messages.find(
      (message) => message.metadata?.[CONTEXT_RAIL_KEY_METADATA] === block.id,
    );
    if (existing) {
      existing.content = content;
      existing.metadata = { ...existing.metadata, [CONTEXT_RAIL_HASH_METADATA]: hash };
      continue;
    }
    messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: opts.now,
      metadata: {
        runtimeContext: true,
        source: block.source,
        [CONTEXT_RAIL_KEY_METADATA]: block.id,
        [CONTEXT_RAIL_HASH_METADATA]: hash,
      },
    });
  }
}

/** Drop rail blocks whose slot is no longer filled. */
function removeOrphanedRailBlocks(
  messages: InjectableMessage[],
  wanted: ReadonlySet<string>,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const key = messages[i]?.metadata?.[CONTEXT_RAIL_KEY_METADATA];
    if (typeof key !== 'string') continue;
    if (wanted.has(key)) continue;
    messages.splice(i, 1);
  }
}

function hashContext(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
