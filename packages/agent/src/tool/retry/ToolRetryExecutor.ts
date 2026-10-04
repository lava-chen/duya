/**
 * ToolRetryExecutor - Handles retry logic for failed tool executions
 *
 * Provides automatic retry with backoff, fallback to alternative tools,
 * and graceful degradation when tools are unavailable.
 */

import type {
  RetryStrategy,
  ToolFailureContext,
  RetryDecision,
  RetryExecutorConfig,
} from './types.js'
import { RetryAction } from './types.js'

/**
 * Tools with side effects that must not be transparently re-run after a
 * failure (a timed-out write may have already persisted, a re-run would
 * double-apply the change). The RETRY action is never issued for these tools;
 * a matching strategy falls through to FALLBACK (a different tool, which is
 * safe) or ABORT. The check runs while the next attempt is being *scheduled*,
 * so the second execution never happens in the first place.
 */
const NON_IDEMPOTENT_TOOLS = new Set([
  'bash',
  'powershell',
  'write',
  'edit',
  'bash_tool',
  'powershell_tool',
])

/**
 * Default configuration for the retry executor
 */
const DEFAULT_CONFIG: Required<RetryExecutorConfig> = {
  defaultMaxAttempts: 3,
  defaultBackoffMs: 1000,
  enableFallback: true,
  autoRetryOnTimeout: true,
  customStrategies: [],
}

/**
 * ToolRetryExecutor manages retry strategies for tool execution failures.
 *
 * Usage:
 * ```typescript
 * const executor = new ToolRetryExecutor()
 *
 * const result = await executor.executeWithRetry(
 *   { toolName: 'bash', toolInput: { command: 'ls' }, toolUseId: '123' },
 *   [TIMEOUT_RETRY, OFFICE_FALLBACK]
 * )
 * ```
 */
export class ToolRetryExecutor {
  private config: Required<RetryExecutorConfig>

  constructor(config: RetryExecutorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Execute a tool with retry support
   */
  async executeWithRetry(
    execution: {
      toolUseId: string
      toolName: string
      toolInput: Record<string, unknown>
    },
    strategies: RetryStrategy[],
    executorFn: (toolName: string, toolInput: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>,
  ): Promise<{
    success: boolean
    result?: unknown
    error?: Error
    attempts: number
    finalAction: RetryAction
  }> {
    const allStrategies = [...this.config.customStrategies, ...strategies]
    let attempt = 0
    let currentTool = execution.toolName
    let currentInput = execution.toolInput
    // Failure recorded by the previous attempt, if any. The next action is
    // decided from this *before* the tool runs again. The old loop ran the
    // tool first and only consulted the strategies afterwards, so a tool was
    // re-executed (side effects and all) even when no strategy authorised the
    // attempt — the non-idempotency guard below ran too late to prevent it.
    let pendingFailure: ToolFailureContext | undefined

    while (attempt < this.getMaxAttempts(currentTool, allStrategies)) {
      if (pendingFailure) {
        const decision = this.decideNextAction(pendingFailure, allStrategies)

        if (decision.action === RetryAction.ABORT || decision.action === RetryAction.SKIP) {
          return {
            success: false,
            error: pendingFailure.error,
            attempts: attempt,
            finalAction: decision.action,
          }
        }

        if (decision.action === RetryAction.FALLBACK && decision.targetTool) {
          currentTool = decision.targetTool
          currentInput = this.adaptInputForFallback(currentInput, currentTool)
        }

        if (decision.delayMs) {
          await this.sleep(decision.delayMs)
        }
      }

      attempt++

      try {
        const result = await executorFn(currentTool, currentInput)

        // `error === undefined` is the success test, not truthiness: a tool
        // that fails with an empty message (`error: ''`) would otherwise be
        // finalised as a successful, empty `tool_result`.
        if (result.error === undefined) {
          return {
            success: true,
            result: result.result,
            attempts: attempt,
            finalAction: RetryAction.RETRY,
          }
        }

        pendingFailure = {
          toolName: currentTool,
          error: new Error(result.error),
          attemptNumber: attempt,
          toolInput: currentInput,
          availableTools: this.getAvailableTools(currentTool),
        }
      } catch (error) {
        pendingFailure = {
          toolName: currentTool,
          error: error instanceof Error ? error : new Error(String(error)),
          attemptNumber: attempt,
          toolInput: currentInput,
          availableTools: this.getAvailableTools(currentTool),
        }
      }
    }

    return {
      success: false,
      error: new Error(`Max retry attempts (${attempt}) exceeded for tool ${execution.toolName}`),
      attempts: attempt,
      finalAction: RetryAction.ABORT,
    }
  }

  /**
   * Decide the next action based on strategies
   */
  private decideNextAction(
    context: ToolFailureContext,
    strategies: RetryStrategy[],
  ): RetryDecision {
    for (const strategy of strategies) {
      if (strategy.toolFilter && !strategy.toolFilter(context.toolName)) {
        continue
      }

      if (strategy.shouldRetry(context)) {
        if (strategy.getFallbackTool) {
          const fallbackTool = strategy.getFallbackTool(context)
          if (fallbackTool) {
            return {
              action: RetryAction.FALLBACK,
              targetTool: fallbackTool,
              delayMs: strategy.backoffMs,
              reason: `Fallback from ${context.toolName} to ${fallbackTool}`,
            }
          }
        }

        // Never re-run a tool with side effects: a timed-out write may have
        // already persisted, so a second run would double-apply the change.
        // This check runs before the attempt is scheduled (see the loop in
        // `executeWithRetry`), so it actually prevents the second execution.
        // `continue` (rather than abort) so a later strategy can still offer
        // a FALLBACK, which runs a *different* tool and is therefore safe.
        if (NON_IDEMPOTENT_TOOLS.has(context.toolName)) {
          continue
        }

        return {
          action: RetryAction.RETRY,
          delayMs: strategy.backoffMs,
          reason: `Retry attempt ${context.attemptNumber + 1}`,
        }
      }
    }

    return {
      action: RetryAction.ABORT,
      reason: 'No matching retry strategy',
    }
  }

  /**
   * Get max attempts for a tool from strategies
   */
  private getMaxAttempts(toolName: string, strategies: RetryStrategy[]): number {
    for (const strategy of strategies) {
      if (strategy.toolFilter && !strategy.toolFilter(toolName)) {
        continue
      }
      return strategy.maxAttempts
    }
    return this.config.defaultMaxAttempts
  }

  /**
   * Get list of available fallback tools
   */
  private getAvailableTools(currentTool: string): string[] {
    return [currentTool]
  }

  /**
   * Adapt tool input for fallback tool
   */
  private adaptInputForFallback(
    originalInput: Record<string, unknown>,
    fallbackTool: string,
  ): Record<string, unknown> {
    switch (fallbackTool) {
      case 'powershell':
        return { command: `powershell -Command "${originalInput.command}"` }
      case 'read':
        // `ReadTool.input_schema` names the field `file_path`; emitting
        // `filePath` here produced an object the target tool can never
        // validate.
        if (originalInput.file_path) {
          return { file_path: originalInput.file_path }
        }
        return originalInput
      default:
        return originalInput
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Check if a tool should be retried based on error type
   */
  static shouldRetryForError(error: Error, autoRetryTimeout = true): boolean {
    const message = error.message.toLowerCase()
    const timeoutPatterns = ['timeout', 'timed out', 'etimedout', 'connection refused']

    if (autoRetryTimeout && timeoutPatterns.some(p => message.includes(p))) {
      return true
    }

    return false
  }
}

export default ToolRetryExecutor