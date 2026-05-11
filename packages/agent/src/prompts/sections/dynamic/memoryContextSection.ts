/**
 * Memory Context Section - Dynamic prefetch for system prompt
 *
 * Called every turn to prefetch relevant memories based on the user's query.
 * Uses volatile section pattern so content is recalculated each time.
 */

import type { PromptContext } from '../../types.js'
import { getMemoryManager } from '../../../memory/index.js'

/**
 * Get the memory context section for the current turn.
 * Prefetches relevant memories based on last user message.
 *
 * @param ctx - Prompt context with lastUserMessage if available
 * @returns Memory context block or empty string
 */
export function getMemoryContextSection(ctx: PromptContext): string {
  const manager = getMemoryManager()

  // Get last user message from context if available
  // lastUserMessage is optional in PromptContext - may be added in future
  const query = (ctx as { lastUserMessage?: string }).lastUserMessage ?? ''

  // Prefetch relevant memories
  const prefetched = manager.prefetch(query)

  // Return prefetched content (buildMemoryContextBlock is called inside manager.prefetch)
  return prefetched
}