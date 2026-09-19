/**
 * Session Memory Compact Strategy
 * Uses LLM to generate a comprehensive session summary that preserves
 * key decisions, tool calls, and conclusions.
 *
 * Features:
 * 1. Structured memory extraction with key sections
 * 2. File change tracking for post-compact restoration
 * 3. Skill invocation tracking
 * 4. Token budget cut point algorithm
 * 5. Iterative summary updates with previous summary injection
 * 6. Last user query re-injection
 * 7. Tool-call invariant enforcement
 * 8. Degenerate summary detection with retry
 * 9. Wall-clock budget for summarization
 */

import type { CompactOptions, CompactionResult, CompactionStats, CompactionStrategy, Message } from '../types.js'
import { estimateMessagesTokens } from '../tokenBudget.js'
import { sanitizeCompactedHistory } from '../historySanitize.js'
import { cleanSummaryText, isDegenerateSummary } from '../summaryGuard.js'
import { summarizeWithRetryLadder } from '../summaryRetry.js'
import { logger } from '../../utils/logger.js'
import {
  findCutPoint,
  buildSummarizationPrompt,
  serializeMessagesForSummary,
  extractFileOpsFromMessages,
  computeFileLists,
  formatFileOperations,
  createFileOps,
  generateTurnPrefixSummary,
  DEFAULT_CUT_CONFIG,
  type FileOperations,
} from '../tokenBudgetCut.js'

/**
 * Configuration for Session Memory Compact
 */
export interface SessionMemoryCompactConfig {
  /** Keep the most recent N messages (legacy fallback) */
  maxMessagesToKeep: number
  /** Maximum tokens per file to restore after compact */
  maxTokensPerFile?: number
  /** Maximum files to restore */
  maxFilesToRestore?: number
  /** Enable skill tracking */
  enableSkillTracking?: boolean
  /** Number of recent tokens to keep (not summarize) - if set, overrides maxMessagesToKeep */
  keepRecentTokens?: number
  /**
   * Previous summary from the last compaction, for iterative updates. Mutated
   * via `setPreviousSummary`; the transient prefire seed is passed via
   * `CompactOptions.previousSummary` instead so it never leaks across sessions.
   */
  previousSummary?: string
  /** Accumulated file operations from previous compactions */
  accumulatedFileOps?: FileOperations
  /** Wall-clock budget (ms) for a single summarization call. Defaults to none. */
  wallClockBudgetMs?: number
}

/**
 * Tracked skill invocation for post-compact restoration
 */
export interface SkillInvocation {
  name: string
  path: string
  invokedAt: number
  content: string
}

/**
 * File change record for tracking modifications
 */
export interface FileChangeRecord {
  filePath: string
  operation: 'read' | 'write' | 'edit' | 'create'
  timestamp: number
  summary?: string
}

/**
 * Session Memory structure for persistent storage
 */
export interface SessionMemoryData {
  primaryRequest: string
  keyDecisions: string[]
  filesModified: FileChangeRecord[]
  errorsEncountered: Array<{ error: string; resolution: string }>
  currentWork: string
  pendingTasks: string[]
  technicalConcepts: string[]
  createdAt: number
  updatedAt: number
}


/**
 * Extract tool invocations from messages for tracking
 */
function extractToolInvocations(messages: Message[]): Map<string, number> {
  const tools = new Map<string, number>()

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if ((block as any).type === 'tool_use') {
        const toolName = (block as any).name
        if (typeof toolName === 'string') {
          tools.set(toolName, (tools.get(toolName) || 0) + 1)
        }
      }
    }
  }

  return tools
}

/**
 * Extract the last real user query (a user message that is not a tool_result
 * carrier) from the message list, re-injected into the compacted history so the
 * successor retains the user's most recent intent.
 */
function extractLastUserQuery(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    if (Array.isArray(msg.content)) {
      // Skip tool_result carriers (user messages wrapping tool results).
      if (msg.content.some((b) => (b as unknown as Record<string, unknown>).type === 'tool_result')) {
        continue
      }
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => (b as unknown as Record<string, unknown>).type === 'text')
        .map((b) => b.text)
        .filter(Boolean)
        .join('\n')
      if (text.trim()) return text
    } else if (typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content
    }
  }
  return undefined
}

function extractFileOperations(messages: Message[]): FileChangeRecord[] {
  const operations: FileChangeRecord[] = []

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if ((block as any).type === 'tool_use') {
        const toolName = (block as any).name
        const input = (block as any).input

        let operation: FileChangeRecord['operation'] | null = null
        let filePath: string | undefined

        switch (toolName) {
          case 'Read':
            operation = 'read'
            filePath = input?.file_path
            break
          case 'Write':
            operation = 'create'
            filePath = input?.file_path
            break
          case 'Edit':
            operation = 'edit'
            filePath = input?.file_path
            break
          case 'Bash':
            // Detect file creation/editing from bash commands
            if (typeof input?.command === 'string') {
              const cmd = input.command.toLowerCase()
              if (cmd.includes('touch ') || cmd.includes('mkdir ') || cmd.includes('> ') || cmd.includes('>> ')) {
                operation = 'create'
              }
            }
            break
        }

        if (operation && filePath && typeof filePath === 'string') {
          // Avoid duplicates - keep latest operation per file
          const existingIdx = operations.findIndex(o => o.filePath === filePath)
          if (existingIdx >= 0) {
            operations[existingIdx] = { filePath, operation, timestamp: Date.now() }
          } else {
            operations.push({ filePath, operation, timestamp: Date.now() })
          }
        }
      }
    }
  }

  return operations
}

/**
 * Count tool calls in messages
 */
function countToolCalls(messages: Message[]): number {
  let count = 0

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    if (Array.isArray(msg.content)) {
      count += msg.content.filter((b: any) => b.type === 'tool_use').length
    }
  }

  return count
}

/**
 * Check if last assistant turn has tool calls (safe extraction point)
 */
function hasToolCallsInLastTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    if (Array.isArray(msg.content)) {
      return msg.content.some((b: any) => b.type === 'tool_use')
    }
  }

  return false
}

/**
 * Format the session memory into a readable summary message
 */
function formatSessionMemorySummary(memoryText: string): string {
  try {
    const parsed = JSON.parse(memoryText)

    let formatted = `## Session Memory Summary\n\n`
    formatted += `**Primary Request**: ${parsed.primaryRequest || 'N/A'}\n\n`

    if (parsed.keyTechnicalConcepts?.length > 0) {
      formatted += `**Key Concepts**:\n${parsed.keyTechnicalConcepts.map((c: string) => `- ${c}`).join('\n')}\n\n`
    }

    if (parsed.toolActions?.length > 0) {
      formatted += `**Tool Actions Taken**:\n${parsed.toolActions.map((t: { tool?: string; input?: string; result?: string }) => `- \`${t.tool || 'unknown'}\`: ${t.input || 'N/A'} → ${(t.result || 'N/A').slice(0, 200)}`).join('\n')}\n\n`
    }

    if (parsed.filesAndCode?.length > 0) {
      formatted += `**Files**:\n${parsed.filesAndCode.map((f: { path?: string; operation?: string; summary?: string }) => `- \`${f.path || 'unknown'}\` (${f.operation || 'unknown'}): ${f.summary || ''}`).join('\n')}\n\n`
    }

    if (parsed.errorsAndProblems?.length > 0) {
      formatted += `**Errors Resolved**:\n${parsed.errorsAndProblems.map((e: { error?: string; resolution?: string }) => `- ${e.error || 'unknown'} → ${e.resolution || 'unknown'}`).join('\n')}\n\n`
    }

    formatted += `**Current State**: ${parsed.currentWorkState || 'N/A'}\n\n`

    if (parsed.pendingTasks?.length > 0) {
      formatted += `**Pending Tasks**:\n${parsed.pendingTasks.map((t: string) => `- [ ] ${t}`).join('\n')}\n\n`
    }

    return formatted
  } catch {
    return memoryText
  }
}

/**
 * Extract key inputs from tool calls for compact summaries.
 * Extracts file paths, search queries, command strings, and other
 * actionable details that are essential for context continuity
 * after compaction.
 */
function extractKeyToolInputs(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const keyFields: Record<string, string[]> = {
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    Bash: ['command'],
    Grep: ['pattern', 'path'],
    Glob: ['pattern', 'path'],
    WebSearch: ['query'],
    WebFetch: ['url'],
    Task: ['query', 'description'],
  }

  const fields = keyFields[toolName] || []
  const results: string[] = []
  for (const field of fields) {
    const val = input[field]
    if (typeof val === 'string' && val.trim()) {
      const truncated = val.length > 120 ? val.slice(0, 117) + '...' : val
      results.push(`${field}=${truncated}`)
    }
  }
  return results
}

/**
 * Session Memory Compact Strategy - Enhanced deep compression
 *
 * Strategy:
 * - Keep system prompt and recent N messages
 * - Use LLM to generate comprehensive structured session memory
 * - Track file changes, tool calls, skills for restoration
 * - Threshold: 85% of max tokens
 */
export class SessionMemoryCompactStrategy implements CompactionStrategy {
  name = 'session_memory'
  private config: SessionMemoryCompactConfig
  private summarizer?: (text: string, prompt: string) => Promise<string>

  constructor(config: Partial<SessionMemoryCompactConfig> = {}) {
    this.config = {
      maxMessagesToKeep: config.maxMessagesToKeep ?? 15,
      maxTokensPerFile: config.maxTokensPerFile ?? 5000,
      maxFilesToRestore: config.maxFilesToRestore ?? 5,
      enableSkillTracking: config.enableSkillTracking ?? true,
      keepRecentTokens: config.keepRecentTokens ?? DEFAULT_CUT_CONFIG.keepRecentTokens,
      previousSummary: config.previousSummary,
      accumulatedFileOps: config.accumulatedFileOps ?? createFileOps(),
    }
  }

  /**
   * Set the summarization function (injected LLM client)
   */
  setSummarizer(summarizer: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = summarizer
  }

  /**
   * Run the summarizer with an optional wall-clock budget.
   */
  private async summarize(text: string, prompt: string): Promise<string> {
    if (!this.summarizer) return ''
    const budgetMs = this.config.wallClockBudgetMs
    if (!budgetMs || budgetMs <= 0) return this.summarizer(text, prompt)

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Summary generation exceeded wall-clock budget (${budgetMs}ms)`))
      }, budgetMs)
      this.summarizer!(text, prompt)
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  /**
   * Generate a standalone summary for the given messages. Used as a background
   * prefire pass so an up-to-date summary is ready before a real compaction.
   * Returns cleaned text, or '' when unavailable/degenerate.
   */
  async summarizeConversation(messages: Message[]): Promise<string> {
    if (!this.summarizer || messages.length === 0) return ''
    const text = serializeMessagesForSummary(this.stripImagesFromMessages(messages))
    const prompt = buildSummarizationPrompt(text, this.config.previousSummary)
    try {
      const result = cleanSummaryText(await this.summarize(text, prompt))
      return isDegenerateSummary(result) ? '' : result
    } catch {
      return ''
    }
  }

  /**
   * Extract text content from messages for summarization.
   * Enhanced to include tool_use details and tool_result summaries so the
   * compaction summary preserves actionable context — file paths, command
   * arguments, and result excerpts are retained for future turns.
   */
  private extractTextFromMessages(messages: Message[]): string {
    const MAX_TOOL_RESULT_LENGTH = 500
    // Track per-message tool_use blocks so we can attach them to tool_results
    const toolUseById = new Map<string, { name: string; input: Record<string, unknown> }>()
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'tool_use' && (block as unknown as Record<string, unknown>).id) {
          toolUseById.set((block as unknown as Record<string, string>).id as string, {
            name: (block as unknown as Record<string, string>).name as string || 'unknown',
            input: (block as unknown as Record<string, unknown>).input as Record<string, unknown> || {},
          })
        }
      }
    }

    return messages
      .map(msg => {
        if (typeof msg.content === 'string') {
          return `[${msg.role.toUpperCase()}]: ${msg.content.slice(0, 2000)}`
        }
        if (Array.isArray(msg.content)) {
          const blocks = msg.content as unknown as Array<Record<string, unknown>>
          const parts: string[] = []

          for (const block of blocks) {
            if (block.type === 'text') {
              const text = (block as { text: string }).text || ''
              if (text.trim()) parts.push(text.slice(0, 2000))
            } else if (block.type === 'tool_use') {
              const name = (block as { name: string }).name || 'unknown'
              const input = (block as { input: Record<string, unknown> }).input || {}
              const keyInputs = extractKeyToolInputs(name, input)
              const inputSummary = keyInputs.length > 0
                ? ` (${keyInputs.join(', ')})`
                : ''
              parts.push(`[Tool Call: ${name}${inputSummary}]`)
            } else if (block.type === 'tool_result') {
              const toolUseId = (block as { tool_use_id: string }).tool_use_id || ''
              const toolInfo = toolUseById.get(toolUseId as string)
              const toolName = toolInfo?.name || 'unknown'
              const content = (block as { content: string | Array<{ type: string; text: string }> }).content
              let resultText = ''
              if (typeof content === 'string') {
                resultText = content
              } else if (Array.isArray(content)) {
                resultText = content
                  .filter((c: { type: string }) => c.type === 'text')
                  .map((c: { text: string }) => c.text || '')
                  .join('\n')
              }
              const isError = typeof content === 'string' && content.includes('<tool_error>')
              const truncated = resultText.slice(0, MAX_TOOL_RESULT_LENGTH)
              const suffix = resultText.length > MAX_TOOL_RESULT_LENGTH ? '...' : ''
              parts.push(`[Result: ${toolName}${isError ? ' (ERROR)' : ''}]: ${truncated}${suffix}`)
            } else if (block.type === 'thinking') {
              const thinking = (block as { thinking: string }).thinking || ''
              if (thinking.trim()) parts.push(`[Thinking]: ${thinking.slice(0, 500)}`)
            }
          }

          const label = msg.role.toUpperCase()
          const content = parts.join('\n')
          return content ? `[${label}]:\n${content}` : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * Strip image blocks from messages so they never ride into the
   * summarizer input (plan 552 — the previous implementation was a no-op
   * and images silently consumed summarizer context). Each removed image
   * is replaced by a one-line text note so the summary can still mention
   * that an image existed. Mirrors mcode's "[image]" flattening.
   */
  private stripImagesFromMessages(messages: Message[]): Message[] {
    return messages.map(message => {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        return message
      }
      let imageCount = 0
      const content = message.content.map(block => {
        if ((block as { type?: string }).type !== 'image') return block
        imageCount += 1
        return {
          type: 'text' as const,
          text: '[image omitted from summarization input]',
        }
      })
      if (imageCount === 0) return message
      return { ...message, content }
    })
  }

  /**
   * Execute session memory compaction with token budget cut point and iterative summary updates
   */
  async compact(messages: Message[], stats: CompactionStats, options?: CompactOptions): Promise<CompactionResult> {
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

    // If conversation is small enough, no need to compact. `force` (Plan 495
    // G2 image-threshold trigger) bypasses the message-count guard — image
    // volume can degrade the context long before the message count does —
    // while still respecting the nothing-to-summarize early return below.
    if (!options?.force && conversationMessages.length <= this.config.maxMessagesToKeep) {
      return {
        messages,
        tokensRemoved: 0,
        tokensRetained: estimateMessagesTokens(messages),
        strategy: this.name,
      }
    }

    // Use token budget cut point algorithm
    const keepRecentTokens = this.config.keepRecentTokens ?? DEFAULT_CUT_CONFIG.keepRecentTokens
    const cutPoint = findCutPoint(conversationMessages, 0, conversationMessages.length, keepRecentTokens)

    // Extract messages based on cut point
    const recentMessages = conversationMessages.slice(cutPoint.firstKeptIndex)
    const olderMessages = conversationMessages.slice(0, cutPoint.firstKeptIndex)

    // Nothing older to summarize — everything fits within the recent-token
    // budget. Inserting a summary message here would *grow* the history.
    if (olderMessages.length === 0) {
      return {
        messages,
        tokensRemoved: 0,
        tokensRetained: estimateMessagesTokens(messages),
        strategy: this.name,
      }
    }

    // Resolve the previous-summary seed. `options.previousSummary` (from the
    // manager's two-pass prefire pipeline) wins over the strategy's persistent
    // `config.previousSummary`, but neither is mutated here — so a shared
    // strategy cannot leak a previous session's summary into the next one.
    const effectivePreviousSummary = options?.previousSummary ?? this.config.previousSummary

    // Handle split turn if necessary
    let turnPrefixSummary = ''
    if (cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0) {
      const turnPrefixMessages = conversationMessages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
      if (turnPrefixMessages.length > 0 && this.summarizer) {
        try {
          turnPrefixSummary = await generateTurnPrefixSummary(
            turnPrefixMessages,
            this.summarizer,
            serializeMessagesForSummary,
          )
        } catch (error) {
          // Re-throw so CompactionManager.compact() can route the error into
          // the 5-state suppression machine. Turn-prefix is "optional" in the
          // sense that the strategy could skip it, but a summarizer failure
          // here is a hard failure for the whole compaction pass — same as
          // the main summarizer call below.
          throw error
        }
      }
    }

    // Calculate tokens saved
    const tokensRemoved = estimateMessagesTokens(olderMessages)
    const tokensRetained = estimateMessagesTokens([...systemMessages, ...recentMessages])

    // Extract file operations (accumulate with previous compactions)
    const fileOps = this.config.accumulatedFileOps ?? createFileOps()
    extractFileOpsFromMessages(olderMessages, fileOps)
    if (cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0) {
      const turnPrefixMessages = conversationMessages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
      extractFileOpsFromMessages(turnPrefixMessages, fileOps)
    }
    const { readFiles, modifiedFiles } = computeFileLists(fileOps)

    // Generate comprehensive session memory with iterative update support
    let summaryText = ''
    if (this.summarizer && olderMessages.length > 0) {
      const cleanedMessages = this.stripImagesFromMessages(olderMessages)
      const conversationText = serializeMessagesForSummary(cleanedMessages)

      const toolCount = countToolCalls(olderMessages)
      const fileOpsList = extractFileOperations(olderMessages)
      const hasRecentToolCalls = hasToolCallsInLastTurn(olderMessages)
      const statsSuffix = `\n\n---\n\nConversation Statistics:\n- Total older messages: ${olderMessages.length}\n- Tool calls: ${toolCount}\n- File operations: ${fileOpsList.length}\n- Has tool calls in last turn: ${hasRecentToolCalls}`
      const buildPrompt = (conversationTextForPrompt: string): string =>
        buildSummarizationPrompt(conversationTextForPrompt, effectivePreviousSummary, undefined) + statsSuffix
      const enhancedPrompt = buildPrompt(conversationText)

      // Retry ladder (Plan 495 G4, grok self-summary alignment): output-length
      // failures get a one-shot shorter-output instruction, input-length
      // failures shrink the summarized range (tool traffic drops first), and
      // up to MAX_SUMMARY_RETRIES attempts run before the failure escapes.
      // Plan 523 P6: forward each attempt's outcome to the manager hook for
      // SSE observability + structured logging.
      const reportAttempt = options?.onSummaryAttempt
      let rawSummary = ''
      try {
        rawSummary = cleanSummaryText(
          (
            await summarizeWithRetryLadder(
              (text, promptText) => this.summarize(text, promptText),
              {
                conversationText,
                prompt: enhancedPrompt,
                messages: cleanedMessages,
                rebuild: (reduced) => {
                  const text = serializeMessagesForSummary([...reduced])
                  return { conversationText: text, prompt: buildPrompt(text) }
                },
              },
              (t) => isDegenerateSummary(t),
              (r) => {
                if (r.outcome !== 'success') {
                  logger.warn('[compact] summarization attempt not usable', {
                    attempt: r.attempt,
                    outcome: r.outcome,
                    errorKind: r.errorKind,
                    chars: r.chars,
                  })
                }
                reportAttempt?.(r)
              },
            )
          ).text,
        )
      } catch (summaryError) {
        // Re-throw so CompactionManager.compact() can route the error into
        // the suppression machine (see `classifySuppressReason`). A summarizer
        // that keeps failing on the same content must not loop forever.
        throw summaryError
      }

      // Plan 523 P1: the ladder now throws `SummaryDegenerateError` when every
      // attempt is degenerate, so `rawSummary` reaching here is always usable —
      // the post-495 placeholder branch (silently replacing real history with
      // "[Session memory unavailable…]") is removed. Degenerate exhaustion
      // propagates via the catch above into the suppression machine instead.
      summaryText = formatSessionMemorySummary(rawSummary)
      summaryText += formatFileOperations(readFiles, modifiedFiles)
      if (turnPrefixSummary) {
        summaryText = `${summaryText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`
      }
      // NOTE: do NOT mutate this.config.previousSummary here. The manager
      // now owns the iterative summary (driven by result.summaryText), and
      // mutating the strategy would leak across sessions if the strategy is shared.
    } else {
      summaryText = `[${olderMessages.length} messages from earlier in the conversation]`
    }

    // Create summary message with continuation instruction
    const compactedIds = olderMessages.map(m => m.id).filter((id): id is string => !!id)
    const lastUserQuery = extractLastUserQuery(recentMessages.length > 0 ? recentMessages : olderMessages)
    const userQueryPreamble = lastUserQuery
      ? `\n\n<user_query>\n${lastUserQuery}\n</user_query>\n\n`
      : ''
    const summaryMessage: Message = {
      role: 'system',
      content: `This session is being continued from a previous conversation that ran out of context. The session memory below covers the earlier portion of the conversation.${userQueryPreamble}

${summaryText}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the memory, do not recap what was happening. Pick up the last task as if the break never happened.`,
      timestamp: Date.now(),
      isCompactSummary: true,
      compactedMessageCount: olderMessages.length,
      compactedMessageIds: compactedIds,
      metadata: {
        strategy: 'session_memory',
        messagesCompressed: olderMessages.length,
        fileOperations: modifiedFiles.length,
        toolCalls: countToolCalls(olderMessages),
        compactedAt: Date.now(),
        isSplitTurn: cutPoint.isSplitTurn,
        readFiles: readFiles.length,
        modifiedFiles: modifiedFiles.length,
      },
    }

    // Build compressed history
    const compressedMessages = sanitizeCompactedHistory([
      ...systemMessages,
      summaryMessage,
      ...recentMessages,
    ])

    return {
      messages: compressedMessages,
      tokensRemoved,
      tokensRetained,
      strategy: this.name,
      // Surface the formatted summary so the manager can store it for
      // iterative compactions and feed it to the memory-flush sink without
      // having to regex-extract it from the embedded summary message.
      summaryText,
    }
  }

}

/**
 * Create default session memory compact strategy
 */
export function createSessionMemoryCompactStrategy(config?: Partial<SessionMemoryCompactConfig>): SessionMemoryCompactStrategy {
  return new SessionMemoryCompactStrategy(config)
}
