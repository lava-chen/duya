/**
 * API Retry Wrapper with Exponential Backoff
 *
 * Wraps LLM client streams with automatic retry logic for transient failures.
 * Supports configurable retry strategies, error classification, and UI feedback.
 */

import type { SSEEvent } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  calculateBackoffDelay,
  calculatePersistentBackoffDelay,
  sleep,
  sleepWithHeartbeat,
  type BackoffOptions,
} from './backoff.js';
import {
  APIErrorType,
  LLMAPIError,
  createLLMAPIError,
  isRetryableError,
  isStaleConnectionError,
  isAbortError,
  formatErrorForDisplay,
  createRetryEvent,
} from './errors.js';

/**
 * Retry configuration options
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 10) */
  maxRetries: number;
  /** Backoff strategy options */
  backoffOptions: BackoffOptions;
  /** Enable persistent retry mode for unattended sessions */
  persistentMode: boolean;
  /** Maximum time to wait in persistent mode (default: 6 hours) */
  persistentMaxWaitMs: number;
  /** Heartbeat interval for long waits (default: 30 seconds) */
  heartbeatIntervalMs: number;
  /** Optional abort signal */
  signal?: AbortSignal;
  /** Callback for retry events (for UI updates) */
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: LLMAPIError) => void;
  /** Callback for heartbeat during long waits */
  onHeartbeat?: (remainingMs: number) => void;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 10,
  backoffOptions: {
    baseDelayMs: 500,
    maxDelayMs: 32000,
    multiplier: 2,
    jitterFactor: 0.25,
  },
  persistentMode: false,
  persistentMaxWaitMs: 6 * 60 * 60 * 1000, // 6 hours
  heartbeatIntervalMs: 30000, // 30 seconds
};

/**
 * Retry state for tracking attempts
 */
interface RetryState {
  attempt: number;
  consecutive529Errors: number;
  persistentAttempt: number;
  totalWaitMs: number;
}

/**
 * Create initial retry state
 */
function createRetryState(): RetryState {
  return {
    attempt: 0,
    consecutive529Errors: 0,
    persistentAttempt: 0,
    totalWaitMs: 0,
  };
}

/**
 * Check if persistent retry mode is enabled via environment
 */
function isPersistentRetryEnabled(): boolean {
  return process.env.DUYA_UNATTENDED_RETRY === 'true' ||
         process.env.DUYA_PERSISTENT_RETRY === 'true';
}

/**
 * Wrap an async generator with retry logic
 *
 * This function wraps a streaming LLM call and automatically retries on transient failures.
 * It yields retry events for UI display and handles various error types appropriately.
 *
 * @param operation - The streaming operation to wrap
 * @param config - Retry configuration
 * @yields SSE events including retry status events
 */
export async function* withRetry<T extends SSEEvent>(
  operation: () => AsyncGenerator<T>,
  config: Partial<RetryConfig> = {}
): AsyncGenerator<T | SSEEvent> {
  const fullConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
    backoffOptions: {
      ...DEFAULT_RETRY_CONFIG.backoffOptions,
      ...config.backoffOptions,
    },
  };

  // Check environment for persistent mode
  const persistentMode = fullConfig.persistentMode || isPersistentRetryEnabled();

  const state = createRetryState();
  let lastError: unknown;

  while (state.attempt <= fullConfig.maxRetries) {
    // Check for abort
    if (fullConfig.signal?.aborted) {
      logger.debug('Abort signal received, stopping retries', undefined, 'withRetry');
      throw new Error('AbortError');
    }

    state.attempt++;

    try {
      logger.debug(`Attempt ${state.attempt}/${fullConfig.maxRetries + 1}`, undefined, 'withRetry');

      // Execute the operation
      const generator = operation();

      for await (const event of generator) {
        // Pass through all events from the underlying operation
        yield event;
      }

      // Success - operation completed without error
      logger.debug(`Operation succeeded on attempt ${state.attempt}`, undefined, 'withRetry');
      return;

    } catch (error) {
      lastError = error;

      // Don't retry abort errors
      if (isAbortError(error)) {
        logger.debug('Abort error, not retrying', undefined, 'withRetry');
        throw error;
      }

      const llmError = createLLMAPIError(error);

      logger.warn(
        `Attempt ${state.attempt} failed`,
        { type: llmError.type, statusCode: llmError.statusCode, message: llmError.message },
        'withRetry'
      );

      // Check if we should retry this error
      if (!llmError.isRetryable) {
        logger.debug('Error is not retryable, throwing', undefined, 'withRetry');
        throw llmError;
      }

      // Track consecutive 529 errors for special handling
      if (llmError.type === APIErrorType.SERVER_OVERLOAD) {
        state.consecutive529Errors++;
      } else {
        state.consecutive529Errors = 0;
      }

      // Check if we've exhausted retries (unless in persistent mode)
      const isTransientCapacityError =
        llmError.type === APIErrorType.RATE_LIMIT ||
        llmError.type === APIErrorType.SERVER_OVERLOAD;

      const shouldContinueInPersistentMode =
        persistentMode &&
        isTransientCapacityError &&
        state.totalWaitMs < fullConfig.persistentMaxWaitMs;

      if (state.attempt > fullConfig.maxRetries && !shouldContinueInPersistentMode) {
        logger.debug('Max retries exceeded, throwing last error', undefined, 'withRetry');
        throw llmError;
      }

      // Calculate delay before next retry
      let delayMs: number;

      if (persistentMode && isTransientCapacityError) {
        state.persistentAttempt++;
        delayMs = calculatePersistentBackoffDelay(state.persistentAttempt, {
          retryAfterSeconds: llmError.retryAfter,
        });

        // Cap at persistent max wait
        const remainingWait = fullConfig.persistentMaxWaitMs - state.totalWaitMs;
        delayMs = Math.min(delayMs, remainingWait);
      } else {
        delayMs = calculateBackoffDelay(state.attempt, {
          ...fullConfig.backoffOptions,
          retryAfterSeconds: llmError.retryAfter,
        });
      }

      state.totalWaitMs += delayMs;

      // Notify UI about retry
      const retryEvent = createRetryEvent(state.attempt, fullConfig.maxRetries, delayMs);
      yield retryEvent;

      if (fullConfig.onRetry) {
        fullConfig.onRetry(state.attempt, fullConfig.maxRetries, delayMs, llmError);
      }

      // Log retry attempt
      logger.info(
        `Retrying after ${delayMs}ms`,
        { attempt: state.attempt, maxRetries: fullConfig.maxRetries },
        'withRetry'
      );

      // Wait before retry
      if (persistentMode && delayMs > fullConfig.heartbeatIntervalMs) {
        // Use chunked sleep with heartbeat for long waits
        await sleepWithHeartbeat(
          delayMs,
          fullConfig.heartbeatIntervalMs,
          (remaining) => {
            fullConfig.onHeartbeat?.(remaining);
            logger.debug(`Heartbeat: ${remaining}ms remaining`, undefined, 'withRetry');
          },
          fullConfig.signal
        );
      } else {
        await sleep(delayMs, fullConfig.signal);
      }

      // In persistent mode, clamp attempt counter so we never give up
      // until persistentMaxWaitMs is reached
      if (persistentMode && state.attempt >= fullConfig.maxRetries) {
        state.attempt = fullConfig.maxRetries; // Keep at max to continue looping
      }
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error('Max retries exceeded');
}

/**
 * Wrap an LLM client stream with retry support
 *
 * This is a convenience function for wrapping LLM client streams.
 *
 * @param streamFn - Function that returns the stream generator
 * @param config - Retry configuration
 * @returns Generator that yields events with retry handling
 */
export function wrapStreamWithRetry<T extends SSEEvent>(
  streamFn: () => AsyncGenerator<T>,
  config?: Partial<RetryConfig>
): AsyncGenerator<T | SSEEvent> {
  return withRetry(streamFn, config);
}

/**
 * Create a retry wrapper for a specific LLM client
 *
 * This creates a higher-order function that wraps any LLM client method
 * with retry logic.
 *
 * @param clientMethod - The client method to wrap
 * @param defaultConfig - Default retry configuration for this client
 * @returns Wrapped method with retry support
 */
export function createRetryWrapper<T extends SSEEvent>(
  clientMethod: () => AsyncGenerator<T>,
  defaultConfig?: Partial<RetryConfig>
): () => AsyncGenerator<T | SSEEvent> {
  return () => withRetry(clientMethod, defaultConfig);
}

/**
 * Check if an error indicates the connection should be reset
 * (e.g., stale keep-alive connection)
 */
export function shouldResetConnection(error: unknown): boolean {
  return isStaleConnectionError(error);
}

/**
 * Retry result type for non-streaming operations
 */
export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: LLMAPIError;
  attempts: number;
  totalWaitMs: number;
}

/**
 * Retry a non-streaming operation
 *
 * @param operation - Async function to retry
 * @param config - Retry configuration
 * @returns Result of the operation
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<RetryResult<T>> {
  const fullConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  const state = createRetryState();
  let lastError: unknown;

  while (state.attempt <= fullConfig.maxRetries) {
    if (fullConfig.signal?.aborted) {
      throw new Error('AbortError');
    }

    state.attempt++;

    try {
      const data = await operation();
      return {
        success: true,
        data,
        attempts: state.attempt,
        totalWaitMs: state.totalWaitMs,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      lastError = error;
      const llmError = createLLMAPIError(error);

      if (!llmError.isRetryable || state.attempt > fullConfig.maxRetries) {
        return {
          success: false,
          error: llmError,
          attempts: state.attempt,
          totalWaitMs: state.totalWaitMs,
        };
      }

      const delayMs = calculateBackoffDelay(state.attempt, fullConfig.backoffOptions);
      state.totalWaitMs += delayMs;

      fullConfig.onRetry?.(state.attempt, fullConfig.maxRetries, delayMs, llmError);

      await sleep(delayMs, fullConfig.signal);
    }
  }

  return {
    success: false,
    error: createLLMAPIError(lastError),
    attempts: state.attempt,
    totalWaitMs: state.totalWaitMs,
  };
}
