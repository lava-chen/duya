/**
 * Exponential Backoff Strategies for API Retry
 *
 * Provides configurable backoff algorithms with jitter to prevent thundering herd.
 */

/**
 * Backoff configuration options
 */
export interface BackoffOptions {
  /** Base delay in milliseconds (default: 500) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 32000) */
  maxDelayMs: number;
  /** Multiplier for exponential increase (default: 2) */
  multiplier: number;
  /** Jitter factor (0-1, default: 0.25) - adds randomness to prevent synchronized retries */
  jitterFactor: number;
  /** Retry-after header value in seconds (optional) */
  retryAfterSeconds?: number;
}

/**
 * Default backoff configuration
 */
export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 32000,
  multiplier: 2,
  jitterFactor: 0.25,
};

/**
 * Persistent retry mode configuration for unattended sessions
 */
export const PERSISTENT_BACKOFF_OPTIONS: BackoffOptions = {
  baseDelayMs: 1000,
  maxDelayMs: 5 * 60 * 1000, // 5 minutes
  multiplier: 2,
  jitterFactor: 0.1, // Less jitter for predictable timing
};

/**
 * Calculate exponential backoff delay with jitter
 *
 * Formula: min(baseDelay * multiplier^(attempt-1), maxDelay) + randomJitter
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Backoff configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  options: Partial<BackoffOptions> = {}
): number {
  const config = { ...DEFAULT_BACKOFF_OPTIONS, ...options };

  // If server provided retry-after, use it (but cap at maxDelay)
  if (config.retryAfterSeconds !== undefined && config.retryAfterSeconds > 0) {
    const retryAfterMs = config.retryAfterSeconds * 1000;
    return Math.min(retryAfterMs, config.maxDelayMs);
  }

  // Calculate exponential delay
  const exponentialDelay = config.baseDelayMs * Math.pow(config.multiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter to prevent thundering herd
  // Jitter is +/- (jitterFactor * delay) around the base delay
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.floor(cappedDelay + jitter));
}

/**
 * Calculate backoff for persistent/unattended retry mode
 *
 * This mode uses longer delays and is designed for background tasks
 * where the user is not actively waiting.
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Override options
 * @returns Delay in milliseconds
 */
export function calculatePersistentBackoffDelay(
  attempt: number,
  options: Partial<BackoffOptions> = {}
): number {
  const config = { ...PERSISTENT_BACKOFF_OPTIONS, ...options };
  return calculateBackoffDelay(attempt, config);
}

/**
 * Sleep for specified duration with abort signal support
 *
 * @param ms - Milliseconds to sleep
 * @param signal - Optional abort signal
 * @returns Promise that resolves after the delay or rejects if aborted
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Chunk a long sleep into smaller intervals with heartbeat callbacks
 *
 * Useful for persistent retry mode where we want to show progress
 * to the user during long waits.
 *
 * @param totalMs - Total milliseconds to sleep
 * @param chunkMs - Size of each chunk (default: 30000 = 30s)
 * @param onHeartbeat - Callback fired after each chunk
 * @param signal - Optional abort signal
 */
export async function sleepWithHeartbeat(
  totalMs: number,
  chunkMs: number = 30000,
  onHeartbeat?: (remainingMs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let remaining = totalMs;

  while (remaining > 0) {
    if (signal?.aborted) {
      throw new Error('AbortError');
    }

    const chunk = Math.min(remaining, chunkMs);
    await sleep(chunk, signal);

    remaining -= chunk;

    if (onHeartbeat && remaining > 0) {
      onHeartbeat(remaining);
    }
  }
}

/**
 * Backoff strategy presets for different scenarios
 */
export const BackoffPresets = {
  /** Default strategy for general API calls */
  default: DEFAULT_BACKOFF_OPTIONS,

  /** Aggressive retry for quick recovery from transient errors */
  aggressive: {
    baseDelayMs: 250,
    maxDelayMs: 8000,
    multiplier: 2,
    jitterFactor: 0.25,
  } as BackoffOptions,

  /** Conservative retry for rate-limited endpoints */
  conservative: {
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    multiplier: 2,
    jitterFactor: 0.25,
  } as BackoffOptions,

  /** Persistent mode for unattended/background tasks */
  persistent: PERSISTENT_BACKOFF_OPTIONS,

  /** No delay - for testing only */
  none: {
    baseDelayMs: 0,
    maxDelayMs: 0,
    multiplier: 1,
    jitterFactor: 0,
  } as BackoffOptions,
};

/**
 * Get backoff preset by name
 */
export function getBackoffPreset(
  name: keyof typeof BackoffPresets
): BackoffOptions {
  return BackoffPresets[name];
}
