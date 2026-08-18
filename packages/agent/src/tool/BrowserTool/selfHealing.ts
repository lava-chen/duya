/**
 * selfHealing - Recoverable browser session self-healing.
 *
 * A browser session handle (the tab/session the daemon tracks) can be
 * invalidated out from under us when the underlying browser restarts or the
 * user/daemon switches to a different session. Commands issued against a stale
 * handle surface errors like `Tab N does not belong to session "S"`. Rather
 * than surfacing every one of those to the model, we detect the signal, rebuild
 * the browser connection once, and replay only the failing action.
 *
 * This module keeps the two concerns separate and unit-testable:
 *   - detection: `isRecoverableSessionInvalidation`
 *   - recovery strategy: `retryOnceAfterSessionInvalidation` (bounded to a
 *     single rebuild + single retry; it never loops on general failures).
 */

/** Messages that indicate the session/tab handle is stale but recoverable by rebuilding the connection. */
const SESSION_INVALIDATION_SIGNALS = [
  'does not belong to session',
  'not attached',
  'failed to attach tab',
  'no active tab',
  'detached',
];

/**
 * Return true when `error` indicates a recoverable session-handle invalidation
 * rather than an ordinary business failure (element not found, blocked URL, etc.).
 * Accepts an `Error`, a bare message string, or any thrown value. Matching is
 * deliberately narrow so we only retry genuine connection-loss cases.
 */
export function isRecoverableSessionInvalidation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return false;
  const m = message.toLowerCase();
  return SESSION_INVALIDATION_SIGNALS.some(signal => m.includes(signal));
}

/**
 * Guidance appended to failures that occur during or after session self-healing,
 * so the model knows the stale-handle recovery path was exhausted and can decide
 * how to proceed (e.g. re-navigate or check the browser/extension state).
 */
export const SESSION_SELF_HEAL_FAILED_MSG =
  'Browser session invalidation detected and session rebuilt, but the operation ' +
  'still failed. Please verify the built-in browser / browser bridge extension ' +
  'state (restart it if needed) and retry the operation, or re-navigate to the ' +
  'target URL to establish a fresh session.';

interface RecoveryOptions {
  /** Classifies an error as a recoverable session invalidation. */
  isRecoverable(error: unknown): boolean;
  /** Rebuild the browser connection/session. Called at most once. */
  rebuild(): Promise<void>;
  /**
   * True when the recovery path (rebuild or retry) failed in a way we cannot
   * hide behind a generic message. When false, the retry error is re-thrown
   * as-is so its detail reaches the model.
   */
  alwaysSurfaceFailureMessage?: boolean;
}

/**
 * Run `attempt`, and if it throws a recoverable session-invalidation error,
 * rebuild the session once and replay `attempt`. The operation is bounded: at
 * most one rebuild and one retry. General failures are re-thrown unchanged;
 * recovery failures surface a clear, guidance-filled error.
 */
export async function retryOnceAfterSessionInvalidation<T>(
  attempt: () => Promise<T>,
  options: RecoveryOptions
): Promise<T> {
  let originalError: unknown;
  try {
    return await attempt();
  } catch (error) {
    if (!options.isRecoverable(error)) throw error;
    originalError = error;
  }

  try {
    await options.rebuild();
  } catch (rebuildError) {
    throw buildSelfHealFailure(originalError, rebuildError);
  }

  try {
    return await attempt();
  } catch (retryError) {
    if (options.alwaysSurfaceFailureMessage) {
      throw buildSelfHealFailure(originalError, retryError);
    }
    // The retry can legitimately fail for business reasons now that the session
    // is fresh (e.g. the element is gone). Pass the retry error through so the
    // model gets accurate detail instead of a misleading "recovery failed".
    throw retryError;
  }
}

function buildSelfHealFailure(original: unknown, during: unknown): Error {
  const originalMsg = original instanceof Error ? original.message : String(original ?? '');
  const detailMsg = during instanceof Error ? during.message : String(during ?? '');
  const error = new Error(
    `${SESSION_SELF_HEAL_FAILED_MSG} (original: ${originalMsg}; recovery: ${detailMsg})`
  );
  // Preserve the causal chain for log-based debugging.
  error.cause = during;
  return error;
}