/**
 * Image-parts threshold trigger (Plan 495 G2; grok alignment).
 *
 * Grok starts a compaction when the number of image parts in the context
 * reaches `IMAGE_SUMMARIZATION_TRIGGER_COUNT = 85`
 * (abstract-user-message-action-handler.ts:69): visual tokens degrade the
 * model's effective attention long before the token budget is exhausted,
 * so image volume is an independent compaction trigger.
 */

import type { Message } from '../types.js'

/** Image parts tolerated in the live context before forcing a compaction. */
export const IMAGE_COMPACTION_TRIGGER_COUNT = 85

/**
 * Count image content blocks across the given messages. String content
 * counts as zero; a message with no images adds nothing.
 */
export function countImagePartsInMessages(messages: readonly Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if ((block as { type?: string }).type === 'image') count++
    }
  }
  return count
}
