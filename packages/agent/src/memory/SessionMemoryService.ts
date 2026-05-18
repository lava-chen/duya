/**
 * Session Memory Service
 * Automatically extracts and manages session memory in the background.
 *
 * Inspired by claude-code-haha's session memory implementation:
 * - Extracts key information from conversations
 * - Stores memory persistently for cross-session continuity
 * - Runs extraction asynchronously to avoid blocking
 * - Triggers based on token count and tool usage thresholds
 */

import type { Message } from '../types.js'
import { estimateMessagesTokens, estimateMessageTokens } from '../compact/tokenBudget.js'

/**
 * Session memory configuration
 */
export interface SessionMemoryConfig {
  /** Minimum tokens before memory extraction is considered */
  minTokenThreshold: number
  /** Minimum tool calls since last extraction */
  minToolCallThreshold: number
  /** Maximum memory file size (chars) */
  maxMemorySize: number
  /** Enable automatic background extraction */
  enableAutoExtract: boolean
  /** Interval to check for extraction needs (ms) */
  checkIntervalMs: number
}

/**
 * Session memory data structure
 */
export interface SessionMemory {
  id: string
  sessionId: string
  primaryRequest: string
  keyDecisions: string[]
  filesModified: FileModification[]
  errorsEncountered: ErrorRecord[]
  currentWorkState: string
  pendingTasks: string[]
  technicalConcepts: string[]
  createdAt: number
  updatedAt: number
  version: number
}

/**
 * File modification record
 */
export interface FileModification {
  filePath: string
  operation: 'read' | 'write' | 'edit' | 'create' | 'delete'
  timestamp: number
  summary?: string
}

/**
 * Error record with resolution
 */
export interface ErrorRecord {
  error: string
  resolution: string
  timestamp: number
}

/**
 * Memory extraction result
 */
export interface ExtractionResult {
  success: boolean
  memory: SessionMemory | null
  error?: string
  tokensProcessed: number
  messagesProcessed: number
  extractionTime: number
}

/**
 * Callback types
 */
export type MemoryUpdateCallback = (memory: SessionMemory) => void
export type ExtractionStartCallback = () => void
export type ExtractionCompleteCallback = (result: ExtractionResult) => void

/**
 * SessionMemoryService - Manages automatic session memory extraction
 *
 * Features:
 * - Background memory extraction using forked agent pattern
 * - Token-based and tool-call-based triggering thresholds
 * - Persistent memory storage
 * - Cross-session continuity
 * - Configurable extraction behavior
 */
export class SessionMemoryService {
  private config: Required<SessionMemoryConfig>
  private currentMemory: SessionMemory | null = null
  private lastExtractionTime = 0
  private lastMessageUuid: string | null = null
  private checkIntervalId: ReturnType<typeof setInterval> | null = null
  private isExtracting = false

  // Callbacks
  private onMemoryUpdate?: MemoryUpdateCallback
  private onExtractionStart?: ExtractionStartCallback
  private onExtractionComplete?: ExtractionCompleteCallback

  // Summarizer function (injected LLM client)
  private summarizer?: (
    text: string,
    prompt: string,
  ) => Promise<string>

  constructor(config: Partial<SessionMemoryConfig> = {}) {
    this.config = {
      minTokenThreshold: config.minTokenThreshold ?? 50000,
      minToolCallThreshold: config.minToolCallThreshold ?? 10,
      maxMemorySize: config.maxMemorySize ?? 10000,
      enableAutoExtract: config.enableAutoExtract ?? true,
      checkIntervalMs: config.checkIntervalMs ?? 30000,
    }
  }

  /**
   * Set the LLM summarizer for memory extraction
   */
  setSummarizer(
    summarizer: (text: string, prompt: string) => Promise<string>,
  ): void {
    this.summarizer = summarizer
  }

  /**
   * Set callback handlers
   */
  setCallbacks(callbacks: {
    onMemoryUpdate?: MemoryUpdateCallback
    onExtractionStart?: ExtractionStartCallback
    onExtractionComplete?: ExtractionCompleteCallback
  }): void {
    this.onMemoryUpdate = callbacks.onMemoryUpdate
    this.onExtractionStart = callbacks.onExtractionStart
    this.onExtractionComplete = callbacks.onExtractionComplete
  }

  /**
   * Start the automatic memory extraction service
   */
  start(sessionId: string): void {
    if (!this.config.enableAutoExtract) return

    // Initialize memory if not exists
    if (!this.currentMemory) {
      this.currentMemory = this.createEmptyMemory(sessionId)
    }

    // Start periodic checking
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
    }

    this.checkIntervalId = setInterval(() => {
      // Check logic will be called externally via shouldExtractMemory()
    }, this.config.checkIntervalMs)
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }
  }

  /**
   * Create empty session memory
   */
  private createEmptyMemory(sessionId: string): SessionMemory {
    return {
      id: `mem_${Date.now()}`,
      sessionId,
      primaryRequest: '',
      keyDecisions: [],
      filesModified: [],
      errorsEncountered: [],
      currentWorkState: '',
      pendingTasks: [],
      technicalConcepts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    }
  }

  /**
   * Check if memory should be extracted based on conversation state.
   * This is called when new messages arrive or at intervals.
   */
  shouldExtractMemory(messages: Message[]): boolean {
    if (!this.config.enableAutoExtract || !this.summarizer) return false
    if (this.isExtracting) return false

    const currentTokenCount = estimateMessagesTokens(messages)

    // Check token threshold
    const hasMetTokenThreshold =
      currentTokenCount - (this.lastExtractionTime ? 0 : 0) >
      this.config.minTokenThreshold

    // Count tool calls since last extraction
    const toolCallsSinceLast = this.countToolCallsSince(messages)
    const hasMetToolCallThreshold =
      toolCallsSinceLast >= this.config.minToolCallThreshold

    // Also extract if last turn has no tool calls (good stopping point)
    const hasNoToolCallsInLastTurn = !this.hasToolCallsInLastTurn(messages)

    return (
      (hasMetTokenThreshold && hasMetToolCallThreshold) ||
      (hasMetTokenThreshold && hasNoToolCallsInLastTurn)
    )
  }

  /**
   * Count tool calls since last extraction point
   */
  countToolCallsSince(messages: Message[]): number {
    let count = 0

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === 'tool_use') {
            count++
          }
        }
      }
    }

    return count
  }

  /**
   * Check if last assistant turn has tool calls
   */
  hasToolCallsInLastTurn(messages: Message[]): boolean {
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
   * Trigger memory extraction manually
   */
  async extractMemory(
    messages: Message[],
    sessionId: string,
  ): Promise<ExtractionResult> {
    if (!this.summarizer) {
      return {
        success: false,
        memory: null,
        error: 'Summarizer not configured',
        tokensProcessed: 0,
        messagesProcessed: 0,
        extractionTime: 0,
      }
    }

    this.isExtracting = true
    const startTime = Date.now()

    if (this.onExtractionStart) {
      this.onExtractionStart()
    }

    try {
      // Prepare conversation text
      const conversationText = this.extractTextFromMessages(messages)
      const prompt = this.getExtractionPrompt()

      // Call LLM to extract memory
      const rawResult = await this.summarizer(conversationText, prompt)

      // Parse the result into structured memory
      const memory = this.parseMemoryResult(rawResult, sessionId)

      // Merge with existing memory
      if (this.currentMemory) {
        this.currentMemory = this.mergeMemories(this.currentMemory, memory)
      } else {
        this.currentMemory = memory
      }

      this.lastExtractionTime = Date.now()

      // Notify callback
      if (this.onMemoryUpdate && this.currentMemory) {
        this.onMemoryUpdate(this.currentMemory)
      }

      const result: ExtractionResult = {
        success: true,
        memory: this.currentMemory,
        tokensProcessed: estimateMessagesTokens(messages),
        messagesProcessed: messages.length,
        extractionTime: Date.now() - startTime,
      }

      if (this.onExtractionComplete) {
        this.onExtractionComplete(result)
      }

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      const result: ExtractionResult = {
        success: false,
        memory: this.currentMemory,
        error: errorMessage,
        tokensProcessed: estimateMessagesTokens(messages),
        messagesProcessed: messages.length,
        extractionTime: Date.now() - startTime,
      }

      if (this.onExtractionComplete) {
        this.onExtractionComplete(result)
      }

      return result
    } finally {
      this.isExtracting = false
    }
  }

  /**
   * Get current session memory
   */
  getMemory(): SessionMemory | null {
    return this.currentMemory
  }

  /**
   * Update memory with incremental changes
   */
  updateMemory(updates: Partial<SessionMemory>): SessionMemory | null {
    if (!this.currentMemory) return null

    this.currentMemory = {
      ...this.currentMemory,
      ...updates,
      updatedAt: Date.now(),
      version: this.currentMemory.version + 1,
    }

    if (this.onMemoryUpdate) {
      this.onMemoryUpdate(this.currentMemory)
    }

    return this.currentMemory
  }

  /**
   * Clear current memory
   */
  clearMemory(): void {
    this.currentMemory = null
    this.lastExtractionTime = 0
    this.lastMessageUuid = null
  }

  /**
   * Export memory as formatted text (for display/injection)
   */
  exportMemoryAsText(): string {
    if (!this.currentMemory) return ''

    const m = this.currentMemory
    let text = ''

    if (m.primaryRequest) {
      text += `**Primary Request**: ${m.primaryRequest}\n\n`
    }

    if (m.technicalConcepts.length > 0) {
      text += `**Key Concepts**:\n${m.technicalConcepts.map(c => `- ${c}`).join('\n')}\n\n`
    }

    if (m.filesModified.length > 0) {
      text += `**Files Modified**:\n${m.filesModified.map(f => `- \`${f.filePath}\` (${f.operation})`).join('\n')}\n\n`
    }

    if (m.keyDecisions.length > 0) {
      text += `**Key Decisions**:\n${m.keyDecisions.map(d => `- ${d}`).join('\n')}\n\n`
    }

    if (m.errorsEncountered.length > 0) {
      text += `**Errors Resolved**:\n${m.errorsEncountered.map(e => `- ${e.error} → ${e.resolution}`).join('\n')}\n\n`
    }

    if (m.currentWorkState) {
      text += `**Current State**: ${m.currentWorkState}\n\n`
    }

    if (m.pendingTasks.length > 0) {
      text += `**Pending Tasks**:\n${m.pendingTasks.map(t => `- [ ] ${t}`).join('\n')}\n\n`
    }

    return text.trim()
  }

  /**
   * Extract text content from messages
   */
  private extractTextFromMessages(messages: Message[]): string {
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

          // Include tool use info
          const toolUses = msg.content
            .filter((b: any) => b.type === 'tool_use')
            .map((b: any) => `[Tool: ${(b as any).name}]`)
            .join(', ')

          let result = `[${msg.role.toUpperCase()}]: ${textContent}`
          if (toolUses) result += `\n${toolUses}`

          return result
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n---\n\n')
  }

  /**
   * Get the extraction prompt for LLM
   */
  private getExtractionPrompt(): string {
    return `You are a session memory extractor. Analyze the conversation below and extract key information that would be useful for continuing this session later.

Extract and format as JSON:
{
  "primaryRequest": "What the user is trying to accomplish",
  "keyTechnicalConcepts": ["important technologies, patterns, APIs"],
  "filesAndCode": [{"path": "...", "operation": "read|write|edit", "summary": "brief description"}],
  "errorsAndProblems": [{"error": "...", "resolution": "..."}],
  "decisionsMade": [{"decision": "...", "rationale": "..."}],
  "currentWorkState": "What was being worked on",
  "pendingTasks": ["tasks not yet completed"]
}

Focus on actionable information. Be concise but comprehensive. Do NOT include full code unless critical.

IMPORTANT: Respond with ONLY the JSON object, no other text.`
  }

  /**
   * Parse LLM response into SessionMemory
   */
  private parseMemoryResult(rawResult: string, sessionId: string): SessionMemory {
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(rawResult)

      return {
        id: this.currentMemory?.id || `mem_${Date.now()}`,
        sessionId,
        primaryRequest: parsed.primaryRequest || this.currentMemory?.primaryRequest || '',
        keyDecisions: [
          ...(this.currentMemory?.keyDecisions || []),
          ...(parsed.decisionsMade?.map((d: any) => d.decision) || []),
        ],
        filesModified: [
          ...(this.currentMemory?.filesModified || []),
          ...(parsed.filesAndCode?.map((f: any) => ({
            filePath: f.path,
            operation: f.operation || 'read',
            timestamp: Date.now(),
            summary: f.summary,
          })) || []),
        ],
        errorsEncountered: [
          ...(this.currentMemory?.errorsEncountered || []),
          ...(parsed.errorsAndProblems?.map((e: any) => ({
            error: e.error,
            resolution: e.resolution,
            timestamp: Date.now(),
          })) || []),
        ],
        currentWorkState: parsed.currentWorkState || this.currentMemory?.currentWorkState || '',
        pendingTasks: parsed.pendingTasks || this.currentMemory?.pendingTasks || [],
        technicalConcepts: [
          ...(new Set([
            ...(this.currentMemory?.technicalConcepts || []),
            ...(parsed.keyTechnicalConcepts || []),
          ])),
        ],
        createdAt: this.currentMemory?.createdAt || Date.now(),
        updatedAt: Date.now(),
        version: (this.currentMemory?.version || 0) + 1,
      }
    } catch {
      // If parsing fails, create simple memory from raw text
      return {
        id: this.currentMemory?.id || `mem_${Date.now()}`,
        sessionId,
        primaryRequest: this.currentMemory?.primaryRequest || '',
        keyDecisions: this.currentMemory?.keyDecisions || [],
        filesModified: this.currentMemory?.filesModified || [],
        errorsEncountered: this.currentMemory?.errorsEncountered || [],
        currentWorkState: rawResult.slice(0, 1000),
        pendingTasks: this.currentMemory?.pendingTasks || [],
        technicalConcepts: this.currentMemory?.technicalConcepts || [],
        createdAt: this.currentMemory?.createdAt || Date.now(),
        updatedAt: Date.now(),
        version: (this.currentMemory?.version || 0) + 1,
      }
    }
  }

  /**
   * Merge two memories, keeping most recent data
   */
  private mergeMemories(existing: SessionMemory, fresh: SessionMemory): SessionMemory {
    return {
      ...existing,
      ...fresh,
      id: existing.id,
      sessionId: existing.sessionId,
      primaryRequest: fresh.primaryRequest || existing.primaryRequest,
      keyDecisions: this.deduplicateArray([...existing.keyDecisions, ...fresh.keyDecisions]),
      filesModified: this.mergeFileModifications(existing.filesModified, fresh.filesModified),
      errorsEncountered: [...existing.errorsEncountered, ...fresh.errorsEncountered].slice(-20),
      currentWorkState: fresh.currentWorkState || existing.currentWorkState,
      pendingTasks: fresh.pendingTasks.length > 0 ? fresh.pendingTasks : existing.pendingTasks,
      technicalConcepts: this.deduplicateArray([...existing.technicalConcepts, ...fresh.technicalConcepts]),
      updatedAt: Date.now(),
      version: existing.version + 1,
    }
  }

  /**
   * Deduplicate array while preserving order
   */
  private deduplicateArray<T>(arr: T[]): T[] {
    return [...new Set(arr)]
  }

  /**
   * Merge file modifications, updating existing entries
   */
  private mergeFileModifications(
    existing: FileModification[],
    fresh: FileModification[],
  ): FileModification[] {
    const map = new Map<string, FileModification>()

    for (const f of existing) {
      map.set(f.filePath, f)
    }

    for (const f of fresh) {
      map.set(f.filePath, f) // Fresh takes precedence
    }

    return Array.from(map.values()).slice(-50) // Keep last 50 files
  }

  /**
   * Get service statistics
   */
  getStats(): {
    isRunning: boolean
    isExtracting: boolean
    lastExtractionTime: number
    memorySize: number
    memoryVersion: number
  } {
    return {
      isRunning: this.checkIntervalId !== null,
      isExtracting: this.isExtracting,
      lastExtractionTime: this.lastExtractionTime,
      memorySize: this.exportMemoryAsText().length,
      memoryVersion: this.currentMemory?.version || 0,
    }
  }
}

/**
 * Create default session memory service
 */
export function createSessionMemoryService(
  config?: Partial<SessionMemoryConfig>,
): SessionMemoryService {
  return new SessionMemoryService(config)
}
