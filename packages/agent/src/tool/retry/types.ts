/**
 * Tool Retry System Types
 *
 * Provides retry strategies, fallback mechanisms, and error recovery
 * for tool execution failures.
 */

/**
 * Actions that can be taken when a tool fails
 */
export enum RetryAction {
  RETRY = 'retry',       // Retry the current tool
  SKIP = 'skip',         // Skip the tool and continue
  FALLBACK = 'fallback', // Use an alternative tool
  ABORT = 'abort',       // Abort the execution chain
}

/**
 * Context provided when a tool failure occurs
 */
export interface ToolFailureContext {
  toolName: string
  error: Error
  attemptNumber: number
  toolInput: Record<string, unknown>
  availableTools: string[]
  /** Original tool definition if known */
  originalTool?: string
  /** Execution metadata */
  metadata?: Record<string, unknown>
}

/**
 * Strategy for handling tool failures
 */
export interface RetryStrategy {
  /** Maximum number of retry attempts */
  maxAttempts: number
  /** Backoff delay in milliseconds between retries */
  backoffMs: number
  /** Whether to retry based on the failure context */
  shouldRetry: (context: ToolFailureContext) => boolean
  /** Get alternative tool name if fallback is needed */
  getFallbackTool?: (context: ToolFailureContext) => string | null
  /** Whether this strategy only applies to specific tools */
  toolFilter?: (toolName: string) => boolean
  /**
   * Declares that this strategy is only meaningful for side-effect-free
   * tools. The executor already refuses to issue RETRY for the built-in
   * non-idempotent tools (write/edit/bash/powershell/...) unconditionally,
   * so this flag is a redundant, self-documenting hint rather than a switch:
   * keep it set on strategies that re-run a tool in place, and expect a
   * FALLBACK or ABORT for the side-effectful ones.
   */
  idempotentOnly?: boolean
}

/**
 * Result of a retry decision
 */
export interface RetryDecision {
  action: RetryAction
  /** Tool to use for retry or fallback (if action is RETRY or FALLBACK) */
  targetTool?: string
  /** Delay before executing the action */
  delayMs?: number
  /** Reason for the decision */
  reason?: string
}

/**
 * Tool execution with retry support
 */
export interface ToolExecutionWithRetry {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Number of attempts made (including retries) */
  attemptCount: number
  /** Whether execution succeeded */
  succeeded: boolean
  /** Final error if failed */
  error?: Error
  /** Tool result if succeeded */
  result?: unknown
}

/**
 * Retry executor configuration
 */
export interface RetryExecutorConfig {
  /** Default maximum attempts */
  defaultMaxAttempts?: number
  /** Default backoff in ms */
  defaultBackoffMs?: number
  /** Enable fallback to alternative tools */
  enableFallback?: boolean
  /** Enable automatic retry on timeout */
  autoRetryOnTimeout?: boolean
  /** Custom strategies in addition to built-in ones */
  customStrategies?: RetryStrategy[]
}

/**
 * Built-in error patterns for common failure scenarios
 */
export const ERROR_PATTERNS = {
  /** LibreOffice not available — tightened to avoid matching generic "office" substrings */
  LIBREOFFICE_NOT_FOUND: /soffice|libreoffice/i,
  /** Network timeout */
  NETWORK_TIMEOUT: /timeout|ECONNREFUSED|ENOTFOUND/i,
  /** Permission denied */
  PERMISSION_DENIED: /permission denied|EACCES|EPERM/i,
  /** Resource not found */
  NOT_FOUND: /not found|ENOENT|404/i,
  /** Tool execution timeout */
  TOOL_TIMEOUT: /timed out|ETIMEDOUT/i,
} as const

/**
 * Maps common tool failures to potential fallback tools.
 * NOTE: web_search → grep was intentionally removed: grep searches the local
 * filesystem, which is semantically unrelated to a web search and would
 * silently return irrelevant local matches.
 */
export const TOOL_FALLBACKS: Record<string, string> = {
  web_fetch: 'read',
  soffice: 'powershell',
}