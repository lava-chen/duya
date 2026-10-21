/**
 * stream-retry.ts — Turn-level LLM stream replay policy (Plan 439).
 *
 * Aggregator routes (OpenRouter et al.) drop mid-stream connections far
 * more often than direct endpoints; the transport death surfaces as a
 * plain error (undici `TypeError: terminated`, OpenRouter "Provider
 * returned error", our own finish_reason guard, ...). The transport-layer
 * retry in `@duya/ai withRetry` deliberately refuses to retry once any
 * text/tool_use delta was yielded (anti-duplication), so mid-stream deaths
 * after visible output would otherwise fail the whole turn.
 *
 * The agent layer CAN safely replay: during streaming, deltas only
 * accumulate in local buffers — the assistant message is committed to the
 * durable timeline on the `done` event, and tools execute only after it.
 * A stream death before `done` therefore leaves no durable state behind,
 * and the turn can be replayed from scratch (pi `_prepareRetry` parity).
 */

import { isRetryableError } from '@duya/ai';

/**
 * Maximum number of REPLAYS (additional attempts) after the initial one.
 * pi defaults to 3 retries; matching that keeps worst-case added latency
 * bounded (~1+2+4s of backoff plus attempt time).
 */
export const STREAM_REPLAY_MAX_ATTEMPTS = 3;

export interface StreamReplayContext {
  /** The run/request abort signal already fired — never replay. */
  aborted: boolean;
  /**
   * The current attempt's `done` event was processed: the assistant
   * message (and possibly tool results) are already committed to the
   * timeline, so a replay would duplicate them. Only pre-`done` failures
   * are replayable.
   */
  turnCommitted: boolean;
  /** Replays consumed so far (0 = none). */
  attemptsUsed: number;
}

/**
 * Decide whether a failed LLM stream attempt should be replayed.
 *
 * Reuses `isRetryableError` so the replay policy and the transport-layer
 * retry policy share one classification (including the Plan 439
 * transport-pattern additions in classifyError).
 */
export function shouldReplayStreamAfterError(
  error: unknown,
  ctx: StreamReplayContext,
): boolean {
  if (ctx.aborted) return false;
  if (ctx.turnCommitted) return false;
  if (ctx.attemptsUsed >= STREAM_REPLAY_MAX_ATTEMPTS) return false;
  return isRetryableError(error);
}

/**
 * Backoff between replay attempts: 1s, 2s, 4s — capped at 8s so a
 * long retry ladder cannot stall an interactive turn.
 */
export function streamReplayDelayMs(attempt: number): number {
  const clamped = Math.max(1, attempt);
  return Math.min(1000 * 2 ** (clamped - 1), 8000);
}
