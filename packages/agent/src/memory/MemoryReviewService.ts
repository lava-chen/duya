/**
 * MemoryReviewService — Background Memory Review System
 *
 * After every N conversation turns, a lightweight LLM pass reviews the
 * conversation for durable facts worth persisting. Results are written
 * directly to the MemoryManager, keeping MEMORY.md files up-to-date
 * without user intervention.
 *
 * Design principles:
 * - Non-blocking: review runs asynchronously and never delays the user
 * - Best-effort: failures are silent; memory review is a convenience
 * - Focused prompt: the review prompt is specialized for fact extraction
 * - Structured output: JSON parsing for reliable integration
 */

import type { MemoryManager } from './manager.js'
import type { MemoryToolInput, MemoryToolResult } from './types.js'

export interface MemoryReviewConfig {
  /** Enable automatic background review */
  enabled: boolean
  /** Number of turns between review passes (default: 10) */
  nudgeInterval: number
  /** Minimum assistant tokens before review is considered (avoids noisy triggers) */
  minAssistantTokens: number
  /** Maximum iterations for the review LLM pass (default: 3) */
  maxReviewIterations: number
}

export const DEFAULT_MEMORY_REVIEW_CONFIG: MemoryReviewConfig = {
  enabled: true,
  nudgeInterval: 10,
  minAssistantTokens: 200,
  maxReviewIterations: 3,
}

export interface MemoryReviewAction {
  action: 'add' | 'replace' | 'remove'
  target: 'global' | 'project'
  subtarget: 'memory' | 'user'
  summary: string
  content?: string
  oldText?: string
  reason: string
}

export interface MemoryReviewResult {
  success: boolean
  actions: MemoryReviewAction[]
  actionsApplied: number
  error?: string
  extractionTimeMs: number
  turnsSinceLastReview: number
}

/**
 * Review prompt — instructs the LLM to extract durable facts from the
 * conversation and return structured JSON memory actions.
 */
const MEMORY_REVIEW_PROMPT = `Review the conversation above and extract any **durable facts** worth persisting across sessions.

Focus on:
1. **User facts & preferences** — persona, work style, communication preferences, or personal details the user revealed. These go to the "user" subtarget.
2. **Recurring corrections** — anything the user corrected more than once. These also go to "user".
3. **Environment & tool conventions** — stable project-level facts like build tools, test frameworks, configuration quirks. These go to the "memory" subtarget.
4. **Non-obvious project conventions** — things tool inspection won't reveal (commit workflow, linting rules, team style). These go to "memory" subtarget.

Do NOT extract:
- Task progress, session outcomes, or completed work
- Debugging solutions (the fix is in the code now)
- Code patterns or architecture (derivable from code)
- Anything already well-known from AGENTS.md or the repository

**Entry quality rules:**
- Write as **declarative facts**, not imperative instructions.
  ✓ "User prefers concise responses"  ✗ "Always respond concisely"
  ✓ "Project uses pnpm workspaces"    ✗ "Run pnpm install"
- Use the **summary** field for a short (3-8 word) label.
- Use **content** only when the fact needs explanation beyond the summary.

Return a JSON object:
{
  "actions": [
    {
      "action": "add",
      "target": "global",
      "subtarget": "user",
      "summary": "User prefers concise responses",
      "content": "Prefers brief, direct answers without lengthy explanations",
      "reason": "User corrected verbose responses twice in this conversation"
    }
  ]
}

Actions: "add" (new entry), "replace" (update existing — provide oldText), "remove" (stale entry — provide oldText), or ignore items by omitting them.
Targets: "global" (cross-project facts), "project" (current project only).
Subtargets: "user" (about the human user), "memory" (about environment/tools/project).

If nothing is worth saving, return: { "actions": [] }

IMPORTANT: Respond ONLY with the JSON object, no other text.`

/**
 * MemoryReviewService handles automatic extraction and persistence of
 * durable memory facts from conversations.
 */
export class MemoryReviewService {
  private config: MemoryReviewConfig
  private turnsSinceLastReview = 0
  private isReviewing = false
  private memoryManager: MemoryManager

  /** LLM summarizer — injected by the agent at init time */
  private summarizer?: (prompt: string) => Promise<string>

  constructor(
    memoryManager: MemoryManager,
    config: Partial<MemoryReviewConfig> = {},
  ) {
    this.memoryManager = memoryManager
    this.config = { ...DEFAULT_MEMORY_REVIEW_CONFIG, ...config }
  }

  setSummarizer(summarizer: (prompt: string) => Promise<string>): void {
    this.summarizer = summarizer
  }

  isEnabled(): boolean {
    return this.config.enabled && this.summarizer !== undefined
  }

  resetTurnCounter(): void {
    this.turnsSinceLastReview = 0
  }

  getTurnsSinceLastReview(): number {
    return this.turnsSinceLastReview
  }

  /**
   * Check if a review should be triggered.
   * Call after each turn completes.
   */
  shouldReview(assistantTokens: number): boolean {
    if (!this.isEnabled()) return false
    if (this.isReviewing) return false

    this.turnsSinceLastReview++

    if (this.turnsSinceLastReview < this.config.nudgeInterval) {
      return false
    }

    if (assistantTokens < this.config.minAssistantTokens) {
      return false
    }

    return true
  }

  /**
   * Trigger a memory review pass.
   *
   * @param conversationText — formatted conversation text
   * @returns Review result
   */
  async review(conversationText: string): Promise<MemoryReviewResult> {
    if (!this.summarizer) {
      return {
        success: false,
        actions: [],
        actionsApplied: 0,
        error: 'Summarizer not configured',
        extractionTimeMs: 0,
        turnsSinceLastReview: this.turnsSinceLastReview,
      }
    }

    if (!conversationText.trim()) {
      return {
        success: false,
        actions: [],
        actionsApplied: 0,
        error: 'Empty conversation text',
        extractionTimeMs: 0,
        turnsSinceLastReview: this.turnsSinceLastReview,
      }
    }

    this.isReviewing = true
    const startTime = Date.now()

    try {
      const fullPrompt = `${conversationText}\n\n---\n\n${MEMORY_REVIEW_PROMPT}`
      const rawResult = await this.summarizer(fullPrompt)
      const actions = this.parseActions(rawResult)
      const applied = await this.applyActions(actions)

      // Reset turn counter on successful review
      this.turnsSinceLastReview = 0

      return {
        success: true,
        actions,
        actionsApplied: applied,
        extractionTimeMs: Date.now() - startTime,
        turnsSinceLastReview: 0,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Don't reset counter on failure — try again soon
      this.turnsSinceLastReview = Math.max(
        0,
        this.turnsSinceLastReview - Math.floor(this.config.nudgeInterval / 2),
      )

      return {
        success: false,
        actions: [],
        actionsApplied: 0,
        error: errorMessage,
        extractionTimeMs: Date.now() - startTime,
        turnsSinceLastReview: this.turnsSinceLastReview,
      }
    } finally {
      this.isReviewing = false
    }
  }

  /**
   * Parse LLM output into structured memory actions.
   */
  private parseActions(rawResult: string): MemoryReviewAction[] {
    try {
      const jsonStart = rawResult.indexOf('{')
      const jsonEnd = rawResult.lastIndexOf('}') + 1
      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        return []
      }

      const jsonStr = rawResult.slice(jsonStart, jsonEnd)
      const parsed = JSON.parse(jsonStr)

      if (!parsed.actions || !Array.isArray(parsed.actions)) {
        return []
      }

      return parsed.actions
        .filter((a: Record<string, unknown>) => {
          const action = a.action as string
          return action === 'add' || action === 'replace' || action === 'remove'
        })
        .map((a: Record<string, unknown>) => ({
          action: a.action as MemoryReviewAction['action'],
          target: (a.target as string) === 'project' ? 'project' : 'global',
          subtarget: (a.subtarget as string) === 'user' ? 'user' : 'memory',
          summary: (a.summary as string) || '',
          content: a.content as string | undefined,
          oldText: a.oldText as string | undefined,
          reason: (a.reason as string) || '',
        }))
    } catch {
      return []
    }
  }

  /**
   * Apply extracted actions to the MemoryManager.
   * Returns the number of successfully applied actions.
   */
  private async applyActions(actions: MemoryReviewAction[]): Promise<number> {
    let applied = 0

    for (const action of actions) {
      try {
        const result = await this.executeAction(action)
        if (result.success) {
          applied++
        }
      } catch {
        // Best-effort — continue to next action
      }
    }

    return applied
  }

  /**
   * Execute a single memory action via MemoryManager.
   */
  private async executeAction(action: MemoryReviewAction): Promise<MemoryToolResult> {
    const input: MemoryToolInput = {
      action: action.action,
      target: action.target,
      subtarget: action.subtarget,
      summary: action.summary,
      content: action.content,
      oldText: action.oldText,
    }

    return this.memoryManager.execute(input)
  }

  /**
   * Get service statistics.
   */
  getStats(): {
    isEnabled: boolean
    isReviewing: boolean
    turnsSinceLastReview: number
    nudgeInterval: number
  } {
    return {
      isEnabled: this.isEnabled(),
      isReviewing: this.isReviewing,
      turnsSinceLastReview: this.turnsSinceLastReview,
      nudgeInterval: this.config.nudgeInterval,
    }
  }
}

/**
 * Factory function for MemoryReviewService.
 */
export function createMemoryReviewService(
  memoryManager: MemoryManager,
  config?: Partial<MemoryReviewConfig>,
): MemoryReviewService {
  return new MemoryReviewService(memoryManager, config)
}