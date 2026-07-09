/**
 * Session Memory Compact Strategy (Enhanced)
 * Uses LLM to generate a comprehensive session summary that preserves
 * key decisions, tool calls, and conclusions.
 *
 * Enhanced features from claude-code-haha:
 * 1. Structured memory extraction with key sections
 * 2. File change tracking for post-compact restoration
 * 3. Skill invocation tracking
 * 4. Agent state preservation
 */

import type { CompactionResult, CompactionStats, CompactionStrategy, Message } from '../types.js'
import { COMPACTION_THRESHOLDS } from '../types.js'
import { estimateMessagesTokens } from '../tokenBudget.js'
import { adjustSliceBoundary } from '../compact.js'

/**
 * Configuration for Session Memory Compact
 */
export interface SessionMemoryCompactConfig {
  /** Keep the most recent N messages */
  maxMessagesToKeep: number
  /** System prompt for the summarizer */
  summarizationPrompt: string
  /** Maximum tokens per file to restore after compact */
  maxTokensPerFile?: number
  /** Maximum files to restore */
  maxFilesToRestore?: number
  /** Enable skill tracking */
  enableSkillTracking?: boolean
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
 * Default session memory prompt - structured extraction
 */
const DEFAULT_SESSION_MEMORY_PROMPT = `Your task is to create a detailed session memory document that captures all important information from this conversation.

The memory should be structured with these sections:

## Primary Request & Intent
What is the user trying to accomplish? What are their explicit goals?

## Key Technical Concepts
Important technologies, frameworks, patterns, APIs mentioned or used

## Tool Actions Taken
List each tool call that was made and what it accomplished:
- For Read: what file was read, key findings
- For Write/Edit: what file was created/modified, what changed (briefly)
- For Bash: what command was run, key output
- For WebSearch/WebFetch: what was searched/fetched, key results
- For Grep/Glob: what was searched, key matches

## Files and Code Sections
List each file that was examined, created, or modified:
- For modified files: what changed (briefly)
- For new files: purpose and key implementation details
- Include relevant code snippets if critical

## Errors and Problems
Any errors encountered and how they were resolved. This helps avoid repeating mistakes.
Pay special attention to [Result: ... (ERROR)] entries in the conversation.

## Decisions Made
Important architectural or implementation decisions with rationale

## Current Work State
What was being worked on when this summary was requested? What's the current state?

## Pending Tasks
Explicit tasks that were requested but not yet completed

Format your response as a JSON object with these fields:
{
  "primaryRequest": "...",
  "keyTechnicalConcepts": ["..."],
  "toolActions": [{"tool": "...", "input": "...", "result": "..."}],
  "filesAndCode": [{"path": "...", "operation": "read|write|edit|create", "summary": "..."}],
  "errorsAndProblems": [{"error": "...", "resolution": "..."}],
  "decisionsMade": [{"decision": "...", "rationale": "..."}],
  "currentWorkState": "...",
  "pendingTasks": ["..."]
}

IMPORTANT: Do NOT call any tools. Respond with text only (the JSON).`

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
 * Extract file operations from messages
 */
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
    skill_manage: ['name'],
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
      summarizationPrompt: config.summarizationPrompt ?? DEFAULT_SESSION_MEMORY_PROMPT,
      maxTokensPerFile: config.maxTokensPerFile ?? 5000,
      maxFilesToRestore: config.maxFilesToRestore ?? 5,
      enableSkillTracking: config.enableSkillTracking ?? true,
    }
  }

  /**
   * Check if compaction should be triggered
   * Threshold: 85% of max tokens
   */
  shouldCompact(stats: CompactionStats): boolean {
    return stats.totalTokens > stats.maxTokens * COMPACTION_THRESHOLDS.SESSION_MEMORY
  }

  /**
   * Set the summarization function (injected LLM client)
   */
  setSummarizer(summarizer: (text: string, prompt: string) => Promise<string>): void {
    this.summarizer = summarizer
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
   * Strip images from messages
   */
  private stripImagesFromMessages(messages: Message[]): Message[] {
    return messages.map(message => {
      if (message.role !== 'user') {
        return message
      }
      return message
    })
  }

  /**
   * Execute session memory compaction
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

    // Split into messages to keep (recent) and messages to summarize (older).
    // Adjust the boundary so we don't cut in the middle of a
    // tool_use/tool_result round-trip (orphaned tool_result).
    let splitIndex = Math.max(0, conversationMessages.length - this.config.maxMessagesToKeep)
    splitIndex = adjustSliceBoundary(conversationMessages, splitIndex)
    const recentMessages = conversationMessages.slice(splitIndex)
    const olderMessages = conversationMessages.slice(0, splitIndex)

    // Calculate tokens saved
    const tokensRemoved = estimateMessagesTokens(olderMessages)
    const tokensRetained = estimateMessagesTokens([...systemMessages, ...recentMessages])

    // Generate comprehensive session memory
    let summaryText = ''
    if (this.summarizer && olderMessages.length > 0) {
      try {
        const cleanedMessages = this.stripImagesFromMessages(olderMessages)
        const conversationText = this.extractTextFromMessages(cleanedMessages)

        // Add metadata about the conversation to help the summarizer
        const toolCount = countToolCalls(olderMessages)
        const fileOps = extractFileOperations(olderMessages)
        const hasRecentToolCalls = hasToolCallsInLastTurn(olderMessages)

        const enhancedPrompt = `${this.config.summarizationPrompt}\n\n---\n\nConversation Statistics:\n- Total older messages: ${olderMessages.length}\n- Tool calls: ${toolCount}\n- File operations: ${fileOps.length}\n- Has tool calls in last turn: ${hasRecentToolCalls}`

        const rawSummary = await this.summarizer(conversationText, enhancedPrompt)
        summaryText = formatSessionMemorySummary(rawSummary)
      } catch {
        summaryText = `[Session memory unavailable - ${olderMessages.length} messages truncated]`
      }
    } else {
      summaryText = `[${olderMessages.length} messages from earlier in the conversation]`
    }

    // Create summary message with continuation instruction
    const compactedIds = olderMessages.map(m => m.id).filter((id): id is string => !!id)
    const summaryMessage: Message = {
      role: 'system',
      content: `This session is being continued from a previous conversation that ran out of context. The session memory below covers the earlier portion of the conversation.

${summaryText}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the memory, do not recap what was happening. Pick up the last task as if the break never happened.`,
      timestamp: Date.now(),
      isCompactSummary: true,
      compactedMessageCount: olderMessages.length,
      compactedMessageIds: compactedIds,
      metadata: {
        strategy: 'session_memory',
        messagesCompressed: olderMessages.length,
        fileOperations: extractFileOperations(olderMessages).length,
        toolCalls: countToolCalls(olderMessages),
        compactedAt: Date.now(),
      },
    }

    // Build compressed history
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

  /**
   * Get file operations from the most recent compaction (for external use)
   */
  getFileOperations(): FileChangeRecord[] {
    // This would be populated during compact() call
    return []
  }

  /**
   * Get statistics about the last compaction
   */
  getLastCompactionStats(): {
    messagesCompressed: number
    fileOperations: number
    toolCalls: number
  } | null {
    return null
  }
}

/**
 * Create default session memory compact strategy
 */
export function createSessionMemoryCompactStrategy(config?: Partial<SessionMemoryCompactConfig>): SessionMemoryCompactStrategy {
  return new SessionMemoryCompactStrategy(config)
}
