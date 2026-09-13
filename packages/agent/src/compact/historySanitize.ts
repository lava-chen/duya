/**
 * Tool-call invariant enforcement for compacted histories.
 *
 * Guarantees every tool_result (in content arrays) and every role: 'tool' message
 * has a matching preceding tool_use; orphaned results are stripped.
 * Also validates the final history shape.
 */

import type { Message } from '../types.js'
import { estimateMessagesTokens } from './tokenBudget.js'

/**
 * Message content block with a type discriminator.
 */
type ContentBlock = {
  type: string
  [key: string]: unknown
}

/**
 * Collect the ids of tool_use blocks in `messages` (in order).
 */
function collectToolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as unknown as ContentBlock[]) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        ids.add(block.id)
      }
    }
  }
  return ids
}

/**
 * Remove orphaned role: 'tool' messages whose tool_call_id has no matching
 * tool_use in any preceding assistant message. This handles the case where
 * compaction removed an assistant message with tool_use blocks but left the
 * corresponding tool result messages behind.
 */
function removeOrphanedToolRoleMessages(
  messages: readonly Message[],
  toolUseIds: Set<string>,
): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== 'tool') return true
    // If no tool_call_id, keep it (let the API validate)
    if (typeof msg.tool_call_id !== 'string') return true
    // Orphan if the tool_call_id doesn't match any tool_use
    return toolUseIds.has(msg.tool_call_id)
  })
}

/**
 * Remove tool_result blocks whose tool_use_id has no matching tool_use.
 * Mutates nothing; returns a new message array.
 */
export function sanitizeCompactedHistory(messages: readonly Message[]): Message[] {
  // Collect tool_use ids from the whole history first so a result whose call
  // lives earlier in the same history is not treated as orphaned.
  const toolUseIds = collectToolUseIds(messages)

  // First pass: remove orphaned role: 'tool' messages
  const afterToolRoleFilter = removeOrphanedToolRoleMessages(messages, toolUseIds)

  const result: Message[] = []
  for (const msg of afterToolRoleFilter) {
    if (!Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    const blocks = msg.content as unknown as ContentBlock[]
    const orphaned = blocks.filter(
      (block) =>
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !toolUseIds.has(block.tool_use_id),
    )
    if (orphaned.length === 0) {
      result.push(msg)
      continue
    }

    const kept = blocks.filter((block) => !orphaned.includes(block))
    if (kept.length === 0) {
      // Whole message was orphaned tool results — drop it.
      continue
    }
    result.push({ ...msg, content: kept as unknown as Message['content'] })
  }

  return result
}

/**
 * Validate that every tool_result (in content arrays) and every role: 'tool'
 * message has a matching preceding tool_use.
 * Returns a list of offending tool_use_ids / tool_call_ids (empty when valid).
 */
export function validateCompactedHistory(messages: readonly Message[]): string[] {
  const orphaned: string[] = []
  const seenToolUses = new Set<string>()

  for (const msg of messages) {
    // Collect tool_use ids from assistant messages and check content blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown as ContentBlock[]) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          seenToolUses.add(block.id)
        } else if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          !seenToolUses.has(block.tool_use_id)
        ) {
          orphaned.push(block.tool_use_id)
        }
      }
    }
    // Check standalone role: 'tool' messages (OpenAI format)
    if (msg.role === 'tool') {
      // Format 1: tool_call_id at top level (OpenAI)
      if (typeof msg.tool_call_id === 'string') {
        if (!seenToolUses.has(msg.tool_call_id)) {
          orphaned.push(msg.tool_call_id)
        }
      }
      // Format 2: tool_result blocks in content array (Anthropic)
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as unknown as ContentBlock[]) {
          if (
            block.type === 'tool_result' &&
            typeof block.tool_use_id === 'string' &&
            !seenToolUses.has(block.tool_use_id)
          ) {
            orphaned.push(block.tool_use_id)
          }
        }
      }
    }
  }

  return orphaned
}

/**
 * Fit a compacted history into a token budget with graceful degradation.
 * Keeps the leading summary/prefix and the most recent tool round-trip;
 * drops intermediate messages until the budget is met. Assumes the input is
 * already sanitized (no orphaned tool results).
 */
export function fitCompactedToBudget(
  messages: Message[],
  maxTokens: number,
): Message[] {
  if (estimateMessagesTokens(messages) <= maxTokens) return [...messages]

  // Always keep the head (summary + system prefix) and the last message.
  const head: Message[] = []
  const tail: Message[] = []
  let headTokens = 0
  for (let i = 0; i < messages.length; i += 1) {
    const tok = estimateMessagesTokens([messages[i]])
    if (headTokens + tok <= maxTokens * 0.7) {
      head.push(messages[i])
      headTokens += tok
    } else {
      break
    }
  }
  tail.push(messages[messages.length - 1])

  let result = [...head, ...tail]
  if (estimateMessagesTokens(result) <= maxTokens) return result

  // Last resort: keep only the head.
  return head
}