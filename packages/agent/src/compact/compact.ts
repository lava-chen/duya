/**
 * Compact Service - LLM-based conversation summarization
 * Uses claude-code-haha's compact prompt strategy for context window management
 */

import type { Message } from '../types.js'
import { getCompactPrompt, getCompactUserSummaryMessage } from './prompt.js'
import { estimateMessagesTokens, withSafetyMargin } from './tokenBudget.js'
import { DEFAULT_CONTEXT_WINDOW, COMPACTION_THRESHOLDS } from './types.js'
export { DEFAULT_CONTEXT_WINDOW } from './types.js'

/**
 * Compression threshold (aligned with MICRO threshold for proactive compression)
 */
export const COMPRESSION_THRESHOLD = COMPACTION_THRESHOLDS.MICRO

/**
 * Circuit breaker: max consecutive compression failures per session
 */
export const MAX_CONSECUTIVE_FAILURES = 3

export interface CompactResult {
  summary: string
  messagesCompressed: number
  estimatedTokensSaved: number
}

export interface ContextEstimate {
  totalTokens: number
  canAddMore: boolean
  needsCompression: boolean
}

/**
 * Token estimation result with additional metadata
 */
export interface TokenEstimation {
  totalTokens: number
  contextWindow: number
  percentFull: number
  canAddMore: boolean
  needsCompression: boolean
}

// ============================================================
// Token Estimation
// ============================================================

/**
 * Estimates token count for a list of messages with safety margin.
 * Used to determine if context compression is needed.
 *
 * @param messages - Array of messages with role and content
 * @returns Token estimation with context window metadata
 */
export function estimateContextTokens(
  messages: Array<{ role: string; content: string | unknown }>
): TokenEstimation {
  const estimatedTokens = estimateMessagesTokens(messages)
  const totalTokens = withSafetyMargin(estimatedTokens)
  const contextWindow = DEFAULT_CONTEXT_WINDOW
  const percentFull = (totalTokens / contextWindow) * 100
  const canAddMore = totalTokens < contextWindow * COMPRESSION_THRESHOLD
  const needsCompression = percentFull >= COMPRESSION_THRESHOLD * 100

  return {
    totalTokens,
    contextWindow,
    percentFull,
    canAddMore,
    needsCompression,
  }
}

/**
 * Checks if context compression should be triggered.
 * Uses the configured threshold (default: 65%) of the context window.
 *
 * @param estimate - Token estimation from estimateContextTokens
 * @param contextWindow - Optional custom context window (defaults to 200k)
 * @returns true if compression is needed
 */
export function needsCompression(
  estimate: ContextEstimate | TokenEstimation,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW
): boolean {
  if ('percentFull' in estimate) {
    return estimate.percentFull >= COMPRESSION_THRESHOLD * 100
  }
  const percentFull = (estimate.totalTokens / contextWindow) * 100
  return percentFull >= COMPRESSION_THRESHOLD * 100
}

/**
 * Strips images from user messages before sending for compaction.
 * Images are not needed for generating a conversation summary.
 */
function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') {
      return message
    }
    // For user messages, we could strip image content blocks if present
    // For now, just return as-is since duya uses simpler message format
    return message
  })
}

/**
 * Extracts text content from messages for summarization
 */
function extractTextFromMessages(messages: Message[]): string {
  return messages
    .map(msg => {
      if (typeof msg.content === 'string') {
        return `[${msg.role.toUpperCase()}]: ${msg.content}`
      }
      // For content blocks, extract text
      if (Array.isArray(msg.content)) {
        const textContent = msg.content
          .filter(block => block.type === 'text')
          .map(block => (block as { type: 'text'; text: string }).text)
          .join('\n')
        return `[${msg.role.toUpperCase()}]: ${textContent}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Generates a summary of the conversation using the provided summarizer
 */
async function generateSummary(
  summarize: (text: string, prompt: string) => Promise<string>,
  messages: Message[],
): Promise<string> {
  const cleanedMessages = stripImagesFromMessages(messages)
  const conversationText = extractTextFromMessages(cleanedMessages)

  if (!conversationText.trim()) {
    return '[No meaningful content to summarize]'
  }

  const compactPrompt = getCompactPrompt()

  try {
    return await summarize(conversationText, compactPrompt)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return `[Summary generation failed: ${errorMessage}]`
  }
}

/**
 * Compress conversation history using LLM summarization
 */
export async function compactHistory(
  messages: Message[],
  options: {
    summarize: (text: string, prompt: string) => Promise<string>
    maxMessagesToKeep?: number
  },
): Promise<CompactResult> {
  const {
    summarize,
    maxMessagesToKeep = 20,
  } = options

  if (messages.length === 0) {
    return {
      summary: '',
      messagesCompressed: 0,
      estimatedTokensSaved: 0,
    }
  }

  const SYSTEM_MESSAGE_PREFIXES = ['system', 'instruction', 'You are', 'You are a', 'This session is being continued']

  // Separate system messages from conversation
  const systemMessages: Message[] = []
  const conversationMessages: Message[] = []

  for (const msg of messages) {
    const isSystem =
      msg.role === 'system' ||
      SYSTEM_MESSAGE_PREFIXES.some(prefix =>
        typeof msg.content === 'string' && msg.content.startsWith(prefix)
      )

    if (isSystem) {
      systemMessages.push(msg)
    } else {
      conversationMessages.push(msg)
    }
  }

  // If conversation is small enough, no need to compact
  if (conversationMessages.length <= maxMessagesToKeep) {
    return {
      summary: '',
      messagesCompressed: 0,
      estimatedTokensSaved: 0,
    }
  }

  // Split into messages to keep (recent) and messages to summarize (older)
  const recentMessages = conversationMessages.slice(-maxMessagesToKeep)
  const olderMessages = conversationMessages.slice(0, -maxMessagesToKeep)

  // Calculate tokens to be saved
  const estimatedTokensSaved = estimateMessagesTokens(olderMessages)

  // Generate summary of older messages
  const summary = await generateSummary(summarize, olderMessages)

  // Create summary message
  const summaryMessage: Message = {
    role: 'system',
    content: getCompactUserSummaryMessage(summary, true),
    timestamp: Date.now(),
  }

  // Build compressed history: system + summary + recent
  const compressedMessages: Message[] = [
    ...systemMessages,
    summaryMessage,
    ...recentMessages,
  ]

  return {
    summary: formatCompactSummary(summary),
    messagesCompressed: olderMessages.length,
    estimatedTokensSaved,
  }
}

/**
 * Format the summary for display
 */
function formatCompactSummary(summary: string): string {
  // Strip analysis section
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // Extract summary section
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${match[1].trim()}`)
  }

  // Clean up whitespace
  formatted = formatted.replace(/\n\n+/g, '\n\n')

  return formatted.trim()
}

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

export default compactHistory
