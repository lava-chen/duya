/**
 * packages/ai/src/utils/idle-timeout.ts
 *
 * Idle timeout for streaming LLM responses. If no data is received for
 * `timeoutMs` milliseconds, the source iterator is cleaned up and a
 * TimeoutError is thrown. The timer resets after each successfully
 * received event.
 *
 * Migrated from packages/agent/src/llm/anthropic-client.ts (withIdleTimeout).
 * The agent-layer retry wrapper classifies the TimeoutError as
 * APIErrorType.TIMEOUT_ERROR (retryable), so a stalled stream triggers
 * the standard backoff-retry path instead of hanging forever.
 */

const STREAM_IDLE_TIMEOUT_MS = 120_000;

export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();

  const abortError = (): Error => {
    const reason = signal?.reason;
    const err = new Error(
      reason instanceof Error
        ? reason.message
        : `Stream aborted${reason ? ` (${String(reason)})` : ''}`,
    );
    err.name = 'AbortError';
    return err;
  };

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let pendingNext: Promise<IteratorResult<T>> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `Stream idle timeout: no data received for ${timeoutMs}ms`,
        );
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);

      // Also abort when the caller's signal fires. MiniMax-style providers
      // keep emitting thinking_delta so the stream never goes idle, and the
      // underlying fetch abort does not reliably terminate the async
      // iterator — without this, a hung request burns the whole run budget
      // even though a per-request wall-clock timeout already fired.
      if (signal) {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      const nextPromise = iterator.next();
      pendingNext = nextPromise;
      const result = await Promise.race([nextPromise, timeoutPromise]);
      pendingNext = null;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (result.done) {
        return;
      }
      yield result.value;
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      // Swallow the eventual rejection of the abandoned next() so a stuck
      // provider stream cannot surface an unhandled rejection later.
      pendingNext?.catch(() => {});
      // Fire-and-forget cleanup. We MUST NOT await iterator.return() here:
      // a provider stream that never converges (MiniMax thinking_delta)
      // keeps iterator.return() pending forever, which would swallow this
      // error and re-hang the caller instead of failing fast.
      if (typeof iterator.return === 'function') {
        try {
          Promise.resolve()
            .then(() => iterator.return?.(undefined as never))
            .catch(() => {});
        } catch {
          // Ignore cleanup errors
        }
      }
      throw err;
    }
  }
}
