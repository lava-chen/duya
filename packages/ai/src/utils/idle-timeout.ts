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
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `Stream idle timeout: no data received for ${timeoutMs}ms`,
        );
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([iterator.next(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (result.done) {
        return;
      }
      yield result.value;
    } catch (err) {
      if (timer) clearTimeout(timer);
      // Ensure the source iterator is cleaned up on timeout/error
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return(undefined as never);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw err;
    }
  }
}
