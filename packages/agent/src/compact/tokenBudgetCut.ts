/**
 * Token Budget Cut Point Algorithm
 * Adapted from pi's compaction strategy (E:\cloned-projects\pi\packages\coding-agent\src\core\compaction\compaction.ts)
 *
 * Key improvements over message-count-based slicing:
 * 1. Uses token budget instead of message count for more precise context retention
 * 2. Handles split turns (when a single turn exceeds the keep budget)
 * 3. Never cuts in the middle of tool_use/tool_result round-trips
 * 4. Supports iterative summary updates with previous summary injection
 */

import type { Message, MessageContent } from '../types.js'
import { estimateMessageTokens } from './tokenBudget.js'

// ============================================================================
// Types
// ============================================================================

export interface CutPointResult {
  /** Index of first message to keep (in the conversation array, not the full messages array) */
  firstKeptIndex: number
  /** Index of user message that starts the turn being split, or -1 if not splitting */
  turnStartIndex: number
  /** Whether this cut splits a turn (cut point is not a user message) */
  isSplitTurn: boolean
}

export interface TokenBudgetCutConfig {
  /** Number of recent tokens to keep (not summarize) */
  keepRecentTokens: number
  /** Maximum tokens for the summary itself */
  maxSummaryTokens?: number
}

export const DEFAULT_CUT_CONFIG: TokenBudgetCutConfig = {
  keepRecentTokens: 20000, // Keep ~20K tokens of recent context
  maxSummaryTokens: 4096,
}

// ============================================================================
// Cut Point Detection
// ============================================================================

/**
 * Check if a message is a valid cut point.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it and will be kept.
 */
function isCutPointMessage(message: Message): boolean {
  // Never cut at tool results
  if (message.role === 'tool') {
    return false
  }

  // Check for tool_result blocks in user messages (legacy format)
  if (message.role === 'user' && Array.isArray(message.content)) {
    const hasToolResult = message.content.some(
      (b) => (b as unknown as Record<string, unknown>).type === 'tool_result'
    )
    if (hasToolResult) {
      return false
    }
  }

  // Allow cutting at user, assistant, system, and other message types
  return true
}

/**
 * Check if a message starts a new turn (user message or similar).
 */
function isTurnStartMessage(message: Message): boolean {
  // User messages start new turns
  if (message.role === 'user') {
    // But not if they only contain tool_result blocks (continuation of previous turn)
    if (Array.isArray(message.content)) {
      const hasOnlyToolResults = message.content.every(
        (b) => (b as unknown as Record<string, unknown>).type === 'tool_result'
      )
      if (hasOnlyToolResults) {
        return false
      }
    }
    return true
  }

  // System messages and compaction summaries also mark turn boundaries
  if (message.role === 'system') {
    return true
  }

  return false
}

/**
 * Find valid cut points in the message array.
 * Returns indices of messages that are valid cut points.
 */
function findValidCutPoints(messages: Message[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = []
  for (let i = startIndex; i < endIndex; i++) {
    if (isCutPointMessage(messages[i])) {
      cutPoints.push(i)
    }
  }
  return cutPoints
}

/**
 * Find the user message that starts the turn containing the given index.
 * Returns -1 if no turn start found before the index.
 */
function findTurnStartIndex(messages: Message[], index: number, startIndex: number): number {
  for (let i = index; i >= startIndex; i--) {
    if (isTurnStartMessage(messages[i])) {
      return i
    }
  }
  return -1
}

/**
 * Find the cut point in messages that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message tokens.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptIndex: the message index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 */
export function findCutPoint(
  messages: Message[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(messages, startIndex, endIndex)

  if (cutPoints.length === 0) {
    return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false }
  }

  // Walk backwards from newest, accumulating estimated message tokens
  let accumulatedTokens = 0
  let cutIndex = cutPoints[0] // Default: keep from first message

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const messageTokens = estimateMessageTokens(messages[i])
    if (messageTokens === 0) continue
    accumulatedTokens += messageTokens

    // Check if we've exceeded the budget
    if (accumulatedTokens >= keepRecentTokens) {
      // Find the closest valid cut point at or after this message
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c]
          break
        }
      }
      break
    }
  }

  // Determine if this is a split turn
  const cutMessage = messages[cutIndex]
  const startsTurn = isTurnStartMessage(cutMessage)
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(messages, cutIndex, startIndex)

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  }
}

// ============================================================================
// Split Turn Handling
// ============================================================================

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
export async function generateTurnPrefixSummary(
  messages: Message[],
  summarizer: (text: string, prompt: string) => Promise<string>,
  serializeMessages: (msgs: Message[]) => string,
): Promise<string> {
  const conversationText = serializeMessages(messages)
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`

  return await summarizer(conversationText, promptText)
}

// ============================================================================
// Iterative Summary Update
// ============================================================================

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/**
 * Build the summarization prompt with conversation and optional previous summary.
 */
export function buildSummarizationPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
): string {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`

  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    prompt += UPDATE_SUMMARIZATION_PROMPT
  } else {
    prompt += SUMMARIZATION_PROMPT
  }

  if (customInstructions) {
    prompt += `\n\nAdditional focus: ${customInstructions}`
  }

  return prompt
}

// ============================================================================
// File Operation Tracking (Cross-Compaction)
// ============================================================================

export interface FileOperations {
  read: Set<string>
  written: Set<string>
  edited: Set<string>
}

export function createFileOps(): FileOperations {
  return {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  }
}

/**
 * Extract file operations from tool calls in messages.
 */
export function extractFileOpsFromMessages(messages: Message[], fileOps: FileOperations): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      const b = block as unknown as Record<string, unknown>
      if (b.type !== 'tool_use') continue

      const name = b.name as string
      const input = b.input as Record<string, unknown> | undefined
      if (!input) continue

      const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
      if (!filePath) continue

      switch (name) {
        case 'Read':
          fileOps.read.add(filePath)
          break
        case 'Write':
          fileOps.written.add(filePath)
          break
        case 'Edit':
          fileOps.edited.add(filePath)
          break
      }
    }
  }
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written])
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort()
  const modifiedFiles = [...modified].sort()
  return { readFiles: readOnly, modifiedFiles }
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = []
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`)
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`)
  }
  if (sections.length === 0) return ""
  return `\n\n${sections.join("\n\n")}`
}

// ============================================================================
// Message Serialization for Summarization
// ============================================================================

const TOOL_RESULT_MAX_CHARS = 2000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const truncatedChars = text.length - maxChars
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`
}

/**
 * Serialize messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 */
export function serializeMessagesForSummary(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          parts.push(`[User]: ${msg.content}`)
        }
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b): b is { type: 'text'; text: string } => (b as any).type === 'text')
          .map((b) => b.text)
          .filter(Boolean)
        if (textParts.length > 0) {
          parts.push(`[User]: ${textParts.join('\n')}`)
        }
      }
    } else if (msg.role === 'assistant') {
      const thinkingParts: string[] = []
      const toolCalls: string[] = []
      const textParts: string[] = []

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as unknown as Record<string, unknown>
          if (b.type === 'thinking' && typeof b.thinking === 'string') {
            thinkingParts.push(b.thinking)
          } else if (b.type === 'tool_use') {
            const name = b.name as string
            const input = (b.input as Record<string, unknown>) || {}
            const argsStr = Object.entries(input)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ')
            toolCalls.push(`${name}(${argsStr})`)
          } else if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text)
          }
        }
      } else if (typeof msg.content === 'string') {
        textParts.push(msg.content)
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`)
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join('\n')}`)
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
      }
    } else if (msg.role === 'tool' || msg.role === 'system') {
      // Tool results and system messages
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          const label = msg.role === 'tool' ? 'Tool result' : 'System'
          parts.push(`[${label}]: ${truncateForSummary(msg.content, TOOL_RESULT_MAX_CHARS)}`)
        }
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b): b is { type: 'text'; text: string } => (b as any).type === 'text')
          .map((b) => truncateForSummary(b.text, TOOL_RESULT_MAX_CHARS))
          .filter(Boolean)
        if (textParts.length > 0) {
          const label = msg.role === 'tool' ? 'Tool result' : 'System'
          parts.push(`[${label}]: ${textParts.join('\n')}`)
        }
      }
    }
  }

  return parts.join('\n\n')
}
