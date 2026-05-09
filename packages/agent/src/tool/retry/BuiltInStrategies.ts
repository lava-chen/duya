/**
 * Built-in Retry Strategies
 *
 * Pre-configured strategies for common failure scenarios:
 * - OFFICE_FALLBACK: LibreOffice unavailable → PowerShell alternative
 * - NETWORK_FALLBACK: Network tool failures → local alternatives
 * - TIMEOUT_RETRY: Timeout errors → single retry with backoff
 */

import type { RetryStrategy, ToolFailureContext } from './types.js'
import { ERROR_PATTERNS, TOOL_FALLBACKS } from './types.js'

/**
 * LibreOffice unavailable fallback strategy
 *
 * When LibreOffice (soffice) fails, tries PowerShell as Windows alternative.
 * Useful for document conversion tasks on Windows.
 *
 * Usage:
 * ```typescript
 * executor.executeWithRetry(toolUse, [OFFICE_FALLBACK, TIMEOUT_RETRY])
 * ```
 */
export const OFFICE_FALLBACK: RetryStrategy = {
  maxAttempts: 2,
  backoffMs: 1000,
  toolFilter: (toolName) => toolName === 'bash',
  shouldRetry: (ctx: ToolFailureContext) => {
    return (
      ctx.attemptNumber < 2 &&
      ERROR_PATTERNS.LIBREOFFICE_NOT_FOUND.test(ctx.error.message)
    )
  },
  getFallbackTool: (ctx: ToolFailureContext) => {
    if (
      ctx.toolName === 'bash' &&
      ERROR_PATTERNS.LIBREOFFICE_NOT_FOUND.test(ctx.error.message)
    ) {
      return 'powershell'
    }
    return null
  },
}

/**
 * Network tool failure fallback strategy
 *
 * Maps network-dependent tools to local alternatives:
 * - web_search → grep
 * - web_fetch → read
 *
 * Usage:
 * ```typescript
 * executor.executeWithRetry(toolUse, [NETWORK_FALLBACK])
 * ```
 */
export const NETWORK_FALLBACK: RetryStrategy = {
  maxAttempts: 1,
  backoffMs: 500,
  shouldRetry: (ctx: ToolFailureContext) => {
    if (ctx.attemptNumber > 1) return false
    const isNetworkError =
      ERROR_PATTERNS.NETWORK_TIMEOUT.test(ctx.error.message) ||
      ERROR_PATTERNS.NOT_FOUND.test(ctx.error.message)
    return isNetworkError
  },
  getFallbackTool: (ctx: ToolFailureContext) => {
    return TOOL_FALLBACKS[ctx.toolName] || null
  },
}

/**
 * Timeout retry strategy
 *
 * Automatically retries on timeout errors with exponential backoff.
 *
 * Usage:
 * ```typescript
 * executor.executeWithRetry(toolUse, [TIMEOUT_RETRY])
 * ```
 */
export const TIMEOUT_RETRY: RetryStrategy = {
  maxAttempts: 2,
  backoffMs: 2000,
  shouldRetry: (ctx: ToolFailureContext) => {
    return (
      ctx.attemptNumber < 2 &&
      ERROR_PATTERNS.TOOL_TIMEOUT.test(ctx.error.message)
    )
  },
}

/**
 * Permission error strategy
 *
 * Fails fast on permission errors rather than retrying.
 */
export const PERMISSION_ERROR: RetryStrategy = {
  maxAttempts: 1,
  backoffMs: 0,
  shouldRetry: (ctx: ToolFailureContext) => {
    return !ERROR_PATTERNS.PERMISSION_DENIED.test(ctx.error.message)
  },
}

/**
 * Default retry strategies for general tool execution
 *
 * Combines timeout retry with network fallback for general use.
 */
export const DEFAULT_RETRY_STRATEGIES: RetryStrategy[] = [
  TIMEOUT_RETRY,
  NETWORK_FALLBACK,
]

/**
 * Retry strategies for document operations
 *
 * Includes LibreOffice fallback for document conversion tasks.
 */
export const DOCUMENT_RETRY_STRATEGIES: RetryStrategy[] = [
  TIMEOUT_RETRY,
  OFFICE_FALLBACK,
]

/**
 * Create a custom retry strategy for a specific tool
 *
 * @param toolName - Tool to match
 * @param maxAttempts - Maximum retry attempts
 * @param backoffMs - Backoff delay between retries
 * @param shouldRetryFn - Custom retry condition
 * @param fallbackToolName - Optional fallback tool name
 */
export function createRetryStrategy(
  toolName: string,
  maxAttempts: number,
  backoffMs: number,
  shouldRetryFn: (ctx: ToolFailureContext) => boolean,
  fallbackToolName?: string,
): RetryStrategy {
  return {
    maxAttempts,
    backoffMs,
    toolFilter: (name) => name === toolName,
    shouldRetry: shouldRetryFn,
    getFallbackTool: fallbackToolName
      ? () => fallbackToolName
      : undefined,
  }
}