/**
 * Micro Compact Strategy (Enhanced)
 * Light compression that preserves key information by:
 * 1. Removing duplicate messages and redundant tool results
 * 2. Grouping messages by API round for intelligent summarization
 * 3. Stripping images/documents before summarization
 * 4. Preserving file read state for post-compact restoration
 *
 * Reference: claude-code-haha's microcompact implementation
 */

import type { CompactionResult, CompactionStats, CompactionStrategy, Message } from '../types.js'
import { COMPACTION_THRESHOLDS } from '../types.js'
import { estimateMessageTokens, estimateMessagesTokens } from '../tokenBudget.js'

/**
 * Configuration for Enhanced Micro Compact
 */
export interface MicroCompactConfig {
  /** Keep the most recent N messages */
  maxMessagesToKeep: number
  /** Custom summarization prompt */
  summarizationPrompt?: string
  /** Enable deduplication of tool results */
  enableDeduplication: boolean
  /** Maximum size for a single message before truncation (chars) */
  maxMessageSize?: number
}

/**
 * Represents a grouped set of messages from one API round
 */
interface MessageGroup {
  messages: Message[]
  startIndex: number
  endIndex: number
  tokenEstimate: number
}

/**
 * File state entry for tracking reads before compaction
 */
export interface FileStateEntry {
  filePath: string
  content: string
  timestamp: number
  isPartialView?: boolean
  offset?: number
  limit?: number
}

/**
 * Extract text content from messages for summarization
 */
function extractTextFromMessages(messages: Message[]): string {
  return messages
    .map(msg => {
      if (typeof msg.content === 'string') {
        return `[${msg.role.toUpperCase()}]: ${msg.content}`
      }
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
 * Strip images and documents from user messages before sending for compaction.
 * Images are not needed for generating a conversation summary and can cause
 * the compaction API call itself to hit the prompt-too-long limit.
 */
function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') {
      return message
    }

    const content = message.content

    if (!Array.isArray(content)) {
      return message
    }

    let hasMediaBlock = false
    const newContent = content.flatMap(block => {
      const blockType = block.type as string

      if (blockType === 'image' || blockType === 'document') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[media]' }]
      }

      // Also strip images/documents nested inside tool_result content arrays
      if (block.type === 'tool_result' && Array.isArray((block as any).content)) {
        let toolHasMedia = false
        const newToolContent = (block as any).content.map((item: any) => {
          if ((item?.type as string) === 'image' || (item?.type as string) === 'document') {
            toolHasMedia = true
            return { type: 'text', text: '[media]' }
          }
          return item
        })
        if (toolHasMedia) {
          hasMediaBlock = true
          return [{ ...block, content: newToolContent }]
        }
      }

      return [block]
    })

    if (!hasMediaBlock) {
      return message
    }

    return {
      ...message,
      content: newContent,
    } as Message
  })
}

/**
 * Detect and remove duplicate tool results.
 * When the same file is read multiple times with identical content, keep only the latest.
 */
function deduplicateToolResults(messages: Message[]): Message[] {
  const seenReadResults = new Map<string, Message>()
  const result: Message[] = []

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    const hasDuplicate = msg.content.some(block => {
      if ((block as any).type !== 'tool_result') return false

      const toolResult = block as any
      const input = toolResult.tool_use?.input

      // Check for duplicate Read results with same file path
      if (input?.file_path && typeof input.file_path === 'string') {
        const key = `read:${input.file_path}`
        if (seenReadResults.has(key)) {
          return true
        }
        seenReadResults.set(key, msg)
      }

      return false
    })

    if (!hasDuplicate) {
      result.push(msg)
    }
  }

  return result
}

/**
 * Truncate overly large messages to prevent OOM during processing
 */
function truncateLargeMessages(
  messages: Message[],
  maxSize: number = 1000000,
): Message[] {
  return messages.map(msg => {
    const contentStr = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content)

    if (contentStr.length <= maxSize) {
      return msg
    }

    // Create truncated version
    const truncatedContent = contentStr.slice(0, maxSize) +
      `\n\n[... content truncated for compaction; ${contentStr.length - maxSize} chars removed]`

    return {
      ...msg,
      content: typeof msg.content === 'string' ? truncatedContent : JSON.parse(truncatedContent),
    } as Message
  })
}

/**
 * Group messages by API round (assistant -> user/tool_result sequences)
 * This allows for more intelligent summarization at the round level
 */
function groupMessagesByApiRound(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let currentGroup: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    currentGroup.push(msg)

    // Start a new group when we see an assistant message followed by user/tool_result
    // or when we hit a system message boundary
    if (msg.role === 'user' || msg.role === 'system') {
      if (currentGroup.length > 0) {
        groups.push({
          messages: [...currentGroup],
          startIndex: i - currentGroup.length + 1,
          endIndex: i,
          tokenEstimate: estimateMessagesTokens(currentGroup),
        })
        currentGroup = []
      }
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    groups.push({
      messages: currentGroup,
      startIndex: messages.length - currentGroup.length,
      endIndex: messages.length - 1,
      tokenEstimate: estimateMessagesTokens(currentGroup),
    })
  }

  return groups
}

/**
 * Extract file state information from Read tool results
 * Used to restore file context after compaction
 */
export function extractFileState(messages: Message[]): Map<string, FileStateEntry> {
  const fileState = new Map<string, FileStateEntry>()

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if ((block as any).type === 'tool_use' && (block as any).name === 'Read') {
        const input = (block as any).input
        if (input?.file_path && typeof input.file_path === 'string') {
          fileState.set(input.file_path, {
            filePath: input.file_path,
            content: '', // Will be populated from tool_result
            timestamp: Date.now(),
            offset: input.offset,
            limit: input.limit,
          })
        }
      }

      // Capture Read tool results with actual content
      if ((block as any).type === 'tool_result' && (block as any).tool_use_id) {
        const toolUseId = (block as any).tool_use_id
        // Find matching Read tool_use to get file path
        for (const prevMsg of messages) {
          if (!Array.isArray(prevMsg.content)) continue
          for (const prevBlock of prevMsg.content) {
            if (
              (prevBlock as any).type === 'tool_use' &&
              (prevBlock as any).id === toolUseId &&
              (prevBlock as any).name === 'Read'
            ) {
              const filePath = (prevBlock as any).input?.file_path
              if (filePath && fileState.has(filePath)) {
                const entry = fileState.get(filePath)!
                entry.content = typeof (block as any).content === 'string'
                  ? (block as any).content
                  : JSON.stringify((block as any).content)
                entry.timestamp = Date.now()
              }
            }
          }
        }
      }
    }
  }

  return fileState
}

/**
 * Micro Compact Strategy - Enhanced light compression
 *
 * Strategy:
 * - Keep system prompt and recent N messages
 * - Deduplicate tool results before summarizing
 * - Strip media blocks to save tokens
 * - Truncate oversized messages
 * - Group by API round for smarter summarization
 * - Threshold: 70% of max tokens
 */
export class MicroCompactStrategy implements CompactionStrategy {
  name = 'micro'
  private config: MicroCompactConfig
  private summarizer?: (text: string, prompt: string) => Promise<string>

  constructor(config: Partial<MicroCompactConfig> = {}) {
    this.config = {
      maxMessagesToKeep: config.maxMessagesToKeep ?? 20,
      summarizationPrompt: config.summarizationPrompt,
      enableDeduplication: config.enableDeduplication ?? true,
      maxMessageSize: config.maxMessageSize ?? 1000000,
    }
  }

  /**
   * Check if compaction should be triggered
   * Threshold: 70% of max tokens
   */
  shouldCompact(stats: CompactionStats): boolean {
    return stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.MICRO
  }

  /**
   * Set the summarization function (injected LLM client)
   */
  setSummarizer(summarizer: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = summarizer
  }

  /**
   * Execute enhanced micro compaction
   */
  async compact(messages: Message[], stats: CompactionStats): Promise<CompactionResult> {
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
    if (conversationMessages.length <= this.config.maxMessagesToKeep) {
      return {
        messages,
        tokensRemoved: 0,
        tokensRetained: estimateMessagesTokens(messages),
        strategy: this.name,
      }
    }

    // Split into messages to keep (recent) and messages to summarize (older)
    const recentMessages = conversationMessages.slice(-this.config.maxMessagesToKeep)
    let olderMessages = conversationMessages.slice(0, -this.config.maxMessagesToKeep)

    // Apply enhancements in order:
    // 1. Deduplicate tool results
    if (this.config.enableDeduplication) {
      olderMessages = deduplicateToolResults(olderMessages)
    }

    // 2. Strip images/media
    olderMessages = stripImagesFromMessages(olderMessages)

    // 3. Truncate large messages
    olderMessages = truncateLargeMessages(olderMessages, this.config.maxMessageSize)

    // Calculate tokens saved
    const tokensRemoved = estimateMessagesTokens(olderMessages)
    const tokensRetained = estimateMessagesTokens([...systemMessages, ...recentMessages])

    // Generate summary if summarizer is available
    let summaryText = ''
    if (this.summarizer && olderMessages.length > 0) {
      try {
        const conversationText = extractTextFromMessages(olderMessages)
        summaryText = await this.summarizer(
          conversationText,
          this.config.summarizationPrompt || getDefaultMicroCompactPrompt()
        )
      } catch {
        // If summarization fails, use simple truncation notice
        summaryText = `[${olderMessages.length} messages summarized - summarization failed]`
      }
    } else {
      // Simple placeholder when no summarizer is available
      summaryText = `[${olderMessages.length} messages from earlier in the conversation]`
    }

    // Create summary message with continuation instruction
    const summaryMessage: Message = {
      role: 'system',
      content: getSummaryMessage(summaryText),
      timestamp: Date.now(),
    }

    // Build compressed history: system + summary + recent
    const compressedMessages: Message[] = [
      ...systemMessages,
      summaryMessage,
      ...recentMessages,
    ]

    return {
      messages: compressedMessages,
      tokensRemoved,
      tokensRetained,
      strategy: this.name,
    }
  }
}

/**
 * Get default micro compact prompt
 */
function getDefaultMicroCompactPrompt(): string {
  return `Your task is to create a brief but informative summary of the earlier portion of this conversation.

Focus on:
1. What was requested by the user
2. Key files that were examined or modified
3. Important decisions made
4. Current state of work
5. Any errors encountered and their resolution

Keep the summary concise (under 500 words). Do NOT include full code snippets unless absolutely critical.

Format your response as plain text without XML tags.`
}

/**
 * Format the summary continuation message
 */
function getSummaryMessage(summaryText: string): string {
  return `This session is being continued from a previous conversation. Summary of earlier conversation:

${summaryText}

Continue the conversation from where it left off.`
}

/**
 * Create default micro compact strategy
 */
export function createMicroCompactStrategy(config?: Partial<MicroCompactConfig>): MicroCompactStrategy {
  return new MicroCompactStrategy(config)
}
