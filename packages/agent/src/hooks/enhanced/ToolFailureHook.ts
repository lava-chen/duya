/**
 * ToolFailureHook - Hook for handling tool execution failures
 *
 * Automatically evaluates tool failures and decides whether to:
 * - Retry the same tool
 * - Use a fallback tool
 * - Skip the tool
 * - Abort the execution chain
 */

import type { HookContext, HookExecutor } from './types.js'
import { ToolRetryExecutor } from '../../tool/retry/ToolRetryExecutor.js'
import { DEFAULT_RETRY_STRATEGIES } from '../../tool/retry/BuiltInStrategies.js'
import { RetryAction } from '../../tool/retry/types.js'

/**
 * ToolFailureHook configuration
 */
export interface ToolFailureHookConfig {
  /** Enable automatic retry on failure */
  enableRetry?: boolean
  /** Enable fallback to alternative tools */
  enableFallback?: boolean
  /** Custom retry strategies */
  retryStrategies?: typeof DEFAULT_RETRY_STRATEGIES
  /** Maximum fallback attempts */
  maxFallbackAttempts?: number
}

/**
 * ToolFailureHook provides automatic failure handling for tool execution
 */
export class ToolFailureHook {
  private retryExecutor: ToolRetryExecutor
  private config: Required<ToolFailureHookConfig>

  constructor(config: ToolFailureHookConfig = {}) {
    this.retryExecutor = new ToolRetryExecutor()
    this.config = {
      enableRetry: config.enableRetry ?? true,
      enableFallback: config.enableFallback ?? true,
      retryStrategies: config.retryStrategies ?? DEFAULT_RETRY_STRATEGIES,
      maxFallbackAttempts: config.maxFallbackAttempts ?? 2,
    }
  }

  /**
   * Create a hook executor for ON_TOOL_FAILURE phase
   */
  createHook(): HookExecutor {
    return async (context: HookContext) => {
      if (!context.toolUse) {
        return { action: 'continue' }
      }

      const toolName = context.toolUse.name
      const toolInput = context.toolUse.input
      const error = context.toolResult?.error

      if (!error) {
        return { action: 'continue' }
      }

      // Evaluate whether to retry/fallback
      const decision = await this.evaluateFailure(toolName, toolInput, error)

      return {
        action: decision.shouldRetry ? 'continue' : 'stop',
        modified: decision.fallbackTool !== undefined,
        metadata: {
          shouldRetry: decision.shouldRetry,
          fallbackTool: decision.fallbackTool,
          errorMessage: decision.errorMessage,
          retryAttempts: decision.retryAttempts ?? 0,
        },
      }
    }
  }

  /**
   * Evaluate a failure and decide next action
   */
  private async evaluateFailure(
    toolName: string,
    toolInput: Record<string, unknown>,
    errorMessage: string,
  ): Promise<{
    shouldRetry: boolean
    fallbackTool?: string
    errorMessage?: string
    retryAttempts?: number
  }> {
    const error = new Error(errorMessage)

    // Use ToolRetryExecutor to evaluate
    const result = await this.retryExecutor.executeWithRetry(
      {
        toolUseId: `hook-${Date.now()}`,
        toolName,
        toolInput,
      },
      this.config.retryStrategies,
      async () => {
        // This is just for evaluation - we don't actually execute
        return { error: errorMessage }
      },
    )

    if (result.success) {
      return {
        shouldRetry: true,
        retryAttempts: result.attempts,
      }
    }

    // Check for fallback
    if (this.config.enableFallback && result.finalAction === RetryAction.FALLBACK) {
      return {
        shouldRetry: false,
        fallbackTool: toolName, // Would be set by retry executor in actual use
        errorMessage: errorMessage,
      }
    }

    return {
      shouldRetry: false,
      errorMessage: errorMessage,
    }
  }

  /**
   * Check if error indicates a retryable failure
   */
  static isRetryableError(error: Error): boolean {
    const timeoutPatterns = ['timeout', 'timed out', 'etimedout']
    const networkPatterns = ['ECONNREFUSED', 'ENOTFOUND', 'network']

    const message = error.message.toLowerCase()

    return (
      timeoutPatterns.some(p => message.includes(p)) ||
      networkPatterns.some(p => message.includes(p))
    )
  }

  /**
   * Check if error indicates a fallback scenario
   */
  static shouldFallback(error: Error): boolean {
    const fallbackPatterns = [
      'soffice',
      'libreoffice',
      'office',
      'not found',
      'enoent',
    ]

    const message = error.message.toLowerCase()

    return fallbackPatterns.some(p => message.includes(p))
  }
}

/**
 * Create a default tool failure hook
 */
export function createToolFailureHook(config?: ToolFailureHookConfig): HookExecutor {
  const hook = new ToolFailureHook(config)
  return hook.createHook()
}

/**
 * Pre-configured tool failure hook for common scenarios
 */
export const DEFAULT_TOOL_FAILURE_HOOK = createToolFailureHook({
  enableRetry: true,
  enableFallback: true,
  retryStrategies: DEFAULT_RETRY_STRATEGIES,
})

export default ToolFailureHook