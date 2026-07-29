/**
 * Persistent-memory contract. Memory content is intentionally not injected
 * into the base prompt; retrieve or update it with the Memory tool when it is
 * relevant to the task.
 */

import type { PromptContext } from '../../types.js'
import { MEMORY_CHAR_LIMITS } from '../../../memory/types.js'

export function getMemorySection(_ctx: PromptContext): string {
  return `## Persistent memory

Use \`Memory\` only for compact, durable facts that reduce future user steering: stable preferences, recurring corrections, or non-obvious project conventions. Write facts, not imperative instructions.

Do not save task progress, raw logs, source-derived details, completed-work summaries, or material already governed by project instructions. Keep temporary state in the current task or scratchpad. Verify stale memory against the workspace before relying on it. Limits: global ${MEMORY_CHAR_LIMITS.memory.toLocaleString()}, user ${MEMORY_CHAR_LIMITS.user.toLocaleString()}, project ${MEMORY_CHAR_LIMITS.project.toLocaleString()} characters.`
}
