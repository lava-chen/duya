/**
 * Post-Compact Reinjector
 * Restores critical context after compaction by re-injecting:
 * 1. File state (recently read files)
 * 2. Skill invocation context
 * 3. Active tool states
 * 4. Working directory information
 *
 * Reference: claude-code-haha's post-compact reinjection mechanism
 */

import type { Message } from '../types.js'
import { extractFileState, type FileStateEntry } from './strategies/MicroCompactStrategy.js'
import type { FileChangeRecord } from './strategies/SessionMemoryCompactStrategy.js'

/**
 * Configuration for the reinjector
 */
export interface ReinjectorConfig {
  /** Maximum files to reinject */
  maxFilesToReinject: number
  /** Maximum tokens per file to reinject */
  maxTokensPerFile: number
  /** Whether to include file content */
  includeFileContent: boolean
  /** Whether to include skill context */
  includeSkillContext: boolean
  /** Whether to include working directory info */
  includeWorkingDirectory: boolean
}

/**
 * Skill context entry for reinjection
 */
export interface SkillContextEntry {
  name: string
  description: string
  invokedAt: number
  relevantContext?: string
}

/**
 * Tool state for tracking active operations
 */
export interface ToolState {
  name: string
  status: 'active' | 'completed' | 'error'
  lastInput?: Record<string, unknown>
  lastOutput?: string
  timestamp: number
}

/**
 * Result of the reinjection process
 */
export interface ReinjectResult {
  messages: Message[]
  filesReinjected: FileStateEntry[]
  skillsReinjected: SkillContextEntry[]
  toolsRestored: ToolState[]
  totalTokensAdded: number
}

/**
 * Post-Compact Reinjector - Restores critical context after compaction
 *
 * After compaction removes older messages, important file contents and
 * skill contexts may be lost. This module ensures continuity by
 * selectively re-injecting essential information.
 */
export class PostCompactReinjector {
  private config: ReinjectorConfig
  private cachedFileState: Map<string, FileStateEntry> = new Map()
  private cachedSkillContext: Map<string, SkillContextEntry> = new Map()
  private cachedToolStates: Map<string, ToolState> = new Map()

  constructor(config: Partial<ReinjectorConfig> = {}) {
    this.config = {
      maxFilesToReinject: config.maxFilesToReinject ?? 5,
      maxTokensPerFile: config.maxTokensPerFile ?? 2000,
      includeFileContent: config.includeFileContent ?? true,
      includeSkillContext: config.includeSkillContext ?? true,
      includeWorkingDirectory: config.includeWorkingDirectory ?? true,
    }
  }

  /**
   * Cache file state before compaction (call before compact())
   */
  cacheFileState(messages: Message[]): void {
    const fileState = extractFileState(messages)

    // Merge with existing cache, keeping latest
    for (const [path, entry] of fileState) {
      this.cachedFileState.set(path, entry)
    }

    // Limit cache size
    if (this.cachedFileState.size > this.config.maxFilesToReinject * 2) {
      // Remove oldest entries
      const entries = Array.from(this.cachedFileState.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)

      this.cachedFileState.clear()

      const keepCount = entries.length - Math.floor(entries.length / 2)
      for (let i = entries.length - keepCount; i < entries.length; i++) {
        this.cachedFileState.set(entries[i][0], entries[i][1])
      }
    }
  }

  /**
   * Cache skill context before compaction
   */
  cacheSkillContext(skills: SkillContextEntry[]): void {
    for (const skill of skills) {
      this.cachedSkillContext.set(skill.name, skill)
    }
  }

  /**
   * Cache tool state
   */
  cacheToolState(toolName: string, state: Omit<ToolState, 'name' | 'timestamp'>): void {
    this.cachedToolStates.set(toolName, {
      ...state,
      name: toolName,
      timestamp: Date.now(),
    })
  }

  /**
   * Perform reinjection after compaction
   *
   * This should be called with the compressed message array from compaction.
   * It will add back essential context that was lost during compression.
   */
  async reinject(
    compressedMessages: Message[],
    options?: {
      workingDirectory?: string
      recentChanges?: FileChangeRecord[]
      customContext?: string
    },
  ): Promise<ReinjectResult> {
    const injectionMessages: Message[] = []
    let totalTokensAdded = 0

    // 1. Reinject file state
    if (this.config.includeFileContent && this.cachedFileState.size > 0) {
      const filesToReinject = this.selectFilesToReinject()

      if (filesToReinject.length > 0) {
        const fileMessage = await this.createFileReinjectMessage(filesToReinject)
        injectionMessages.push(fileMessage)
        totalTokensAdded += this.estimateTokenCount(fileMessage.content as string)
      }
    }

    // 2. Reinject skill context
    if (this.config.includeSkillContext && this.cachedSkillContext.size > 0) {
      const skillMessage = this.createSkillReinjectMessage()
      if (skillMessage) {
        injectionMessages.push(skillMessage)
        totalTokensAdded += this.estimateTokenCount(skillMessage.content as string)
      }
    }

    // 3. Reinject tool state
    if (this.cachedToolStates.size > 0) {
      const toolMessage = this.createToolStateMessage()
      if (toolMessage) {
        injectionMessages.push(toolMessage)
        totalTokensAdded += this.estimateTokenCount(toolMessage.content as string)
      }
    }

    // 4. Add working directory info
    if (this.config.includeWorkingDirectory && options?.workingDirectory) {
      const dirMessage = this.createWorkingDirMessage(options.workingDirectory, options.recentChanges)
      injectionMessages.push(dirMessage)
      totalTokensAdded += this.estimateTokenCount(dirMessage.content as string)
    }

    // 5. Add custom context if provided
    if (options?.customContext) {
      injectionMessages.push({
        role: 'system',
        content: options.customContext,
        timestamp: Date.now(),
      })
      totalTokensAdded += this.estimateTokenCount(options.customContext)
    }

    // Insert injection messages after the summary but before recent messages
    const finalMessages = this.insertInjectionMessages(compressedMessages, injectionMessages)

    return {
      messages: finalMessages,
      filesReinjected: Array.from(this.selectFilesToReinject()),
      skillsReinjected: Array.from(this.cachedSkillContext.values()),
      toolsRestored: Array.from(this.cachedToolStates.values()),
      totalTokensAdded,
    }
  }

  /**
   * Select which files to reinject based on recency and importance
   */
  private selectFilesToReinject(): FileStateEntry[] {
    const entries = Array.from(this.cachedFileState.values())
      .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

    return entries.slice(0, this.config.maxFilesToReinject)
  }

  /**
   * Create a message containing file state for reinjection
   */
  private async createFileReinjectMessage(files: FileStateEntry[]): Promise<Message> {
    let content = `## Recently Accessed Files\n\n`

    for (const file of files) {
      content += `### ${file.filePath}\n`

      if (file.isPartialView) {
        content += `*(partial view: offset=${file.offset}, limit=${file.limit})*\n`
      }

      if (this.config.includeFileContent && file.content) {
        // Truncate content if too long
        const truncatedContent = this.truncateContent(
          file.content,
          this.config.maxTokensPerFile * 4, // Rough char estimate
        )
        content += `\`\`\`\n${truncatedContent}\n\`\`\`\n\n`
      } else {
        content += `*(content available on request)*\n\n`
      }
    }

    return {
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: {
        type: 'reinject_files',
        fileCount: files.length,
      },
    } as Message
  }

  /**
   * Create a message containing skill context for reinjection
   */
  private createSkillReinjectMessage(): Message | null {
    const skills = Array.from(this.cachedSkillContext.values())

    if (skills.length === 0) return null

    let content = `## Active Skills Context\n\n`

    for (const skill of skills) {
      content += `- **${skill.name}**: ${skill.description}\n`
      if (skill.relevantContext) {
        content += `  Context: ${skill.relevantContext}\n`
      }
    }

    return {
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: {
        type: 'reinject_skills',
        skillCount: skills.length,
      },
    } as Message
  }

  /**
   * Create a message containing tool state for reinjection
   */
  private createToolStateMessage(): Message | null {
    const tools = Array.from(this.cachedToolStates.values())
      .filter(t => t.status === 'active')

    if (tools.length === 0) return null

    let content = `## Active Tool States\n\n`

    for (const tool of tools) {
      content += `### ${tool.name}\n`
      content += `Status: ${tool.status}\n`
      if (tool.lastOutput) {
        const truncated = this.truncateContent(tool.lastOutput, 500)
        content += `Last Output:\n\`\`\`\n${truncated}\n\`\`\`\n\n`
      }
    }

    return {
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: {
        type: 'reinject_tools',
        toolCount: tools.length,
      },
    } as Message
  }

  /**
   * Create a working directory context message
   */
  private createWorkingDirMessage(workingDir: string, recentChanges?: FileChangeRecord[]): Message {
    let content = `## Working Directory\n\nCurrent working directory: \`${workingDir}\`\n\n`

    if (recentChanges && recentChanges.length > 0) {
      content += `### Recent Changes\n\n`
      for (const change of recentChanges.slice(-10)) {
        const icon = change.operation === 'create' ? '+' : change.operation === 'edit' ? '~' : '-'
        content += `${icon} \`${change.filePath}\` (${change.operation})\n`
      }
      content += '\n'
    }

    return {
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: {
        type: 'reinject_working_dir',
        path: workingDir,
      },
    } as Message
  }

  /**
   * Insert injection messages at the right position in compressed messages
   * (after summary, before recent conversation)
   */
  private insertInjectionMessages(
    compressedMessages: Message[],
    injectionMessages: Message[],
  ): Message[] {
    // Find the insertion point (after system/summary messages, before user messages)
    let insertIndex = 0

    for (let i = 0; i < compressedMessages.length; i++) {
      const msg = compressedMessages[i]

      // Skip system messages and continuation summaries
      if (
        msg.role === 'system' ||
        (typeof msg.content === 'string' &&
          (msg.content.includes('session is being continued') ||
            msg.content.includes('Recently Accessed') ||
            msg.content.includes('Active Skills') ||
            msg.content.includes('Working Directory')))
      ) {
        insertIndex = i + 1
      } else {
        break
      }
    }

    // Insert at the found position
    return [
      ...compressedMessages.slice(0, insertIndex),
      ...injectionMessages,
      ...compressedMessages.slice(insertIndex),
    ]
  }

  /**
   * Truncate content to fit within token budget
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content
    }

    return content.slice(0, maxLength) +
      `\n\n... [truncated, ${content.length - maxLength} chars omitted]`
  }

  /**
   * Rough token count estimation
   */
  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 chars per token
    return Math.ceil(text.length / 4)
  }

  /**
   * Clear all caches (e.g., when starting a new session)
   */
  clearCache(): void {
    this.cachedFileState.clear()
    this.cachedSkillContext.clear()
    this.cachedToolStates.clear()
  }

  /**
   * Get current cache statistics
   */
  getCacheStats(): {
    filesCached: number
    skillsCached: number
    toolsCached: number
  } {
    return {
      filesCached: this.cachedFileState.size,
      skillsCached: this.cachedSkillContext.size,
      toolsCached: this.cachedToolStates.size,
    }
  }
}

/**
 * Create default post-compact reinjector
 */
export function createPostCompactReinjector(config?: Partial<ReinjectorConfig>): PostCompactReinjector {
  return new PostCompactReinjector(config)
}
