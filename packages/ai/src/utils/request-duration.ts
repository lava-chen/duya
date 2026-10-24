/**
 * packages/ai/src/utils/request-duration.ts
 *
 * The physical duration of one provider request, and the throughput it makes
 * possible.
 *
 * ## Why the duration is measured HERE and not downstream
 *
 * A throughput number is a ratio: output tokens over elapsed time. The
 * elapsed time has to be the time the PROVIDER spent, because a consumer
 * cannot reconstruct it later. Chunk timestamps are the obvious alternative
 * and the wrong one: a client that buffers chunks (a proxy, a slow consumer,
 * a batched reader) sees timestamps that no longer describe when the provider
 * produced the content, so a throughput derived from them overstates the
 * provider's speed by however long the buffering took.
 *
 * So the clock starts when the request is opened and stops when the provider
 * reports its usage, and the elapsed value is carried AS A NUMBER from there
 * on. A consumer uses the elapsed duration directly.
 *
 * ## What the denominator includes, and what it does not
 *
 * The measured window is the whole request, so it INCLUDES the time to first
 * token. That is deliberate: it is the time the user actually waited. A
 * "generation-only" denominator would need the first content delta's
 * timestamp, which is exactly the buffered quantity this module exists to
 * avoid depending on.
 *
 * It does NOT include the time before the request was opened (context
 * assembly, tool dispatch) or after it closed (rendering). Those are the
 * runtime's costs, not the model's.
 *
 * ## Why this file holds a pure function too
 *
 * `calculateOutputTokensPerSecond` lives beside the measurement because the
 * two answer one question, and because the answer has to be the SAME in
 * every consumer: the CLI TUI and the Desktop renderer both show it, and
 * two implementations would be two numbers for one fact. It is pure — no IO,
 * no clock, no state — so a consumer can call it with whatever pair of
 * numbers it holds.
 */

import type { SSEEvent } from '../types.js';

/**
 * Output tokens per second for one provider call.
 *
 * `null` means "there is no rate to report", which is a different answer
 * from `0`:
 *
 *  - a provider that reported no output tokens, or a call that took no
 *    measurable time, has no rate to divide by;
 *  - a consumer that has no duration at all (an older record, a producer
 *    that did not measure) must not be handed a number that looks measured.
 *
 * So every degenerate input answers `null`, and only a real pair of positive
 * numbers produces a rate.
 */
export function calculateOutputTokensPerSecond(
  outputTokens: number,
  durationMs: number,
): number | null {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1000);
}

/**
 * Stamp the elapsed duration onto the usage a provider reports.
 *
 * Only the `result` event carries usage, so only that event is rewritten.
 * The usage block is COPIED rather than mutated: the provider hands out the
 * same usage object it keeps on its assistant message, and mutating it
 * would put a transport measurement onto the message the runtime persists.
 */
export function stampRequestDuration(event: SSEEvent, durationMs: number): SSEEvent {
  if (event.type !== 'result') return event;
  return {
    type: 'result',
    data: { ...event.data, request_duration_ms: durationMs },
  };
}

/**
 * Forward a provider's event stream, stamping the physical request duration
 * onto the usage event it ends with.
 *
 * The clock starts when this generator's body first runs, which is the
 * moment BEFORE the provider's request is opened: the provider's own
 * generator body has not started yet, because a generator does not run until
 * somebody asks it for its first value. The clock stops when the usage
 * event arrives, which the providers emit as the last thing they do with a
 * response.
 */
export async function* withRequestDuration<T>(
  stream: AsyncGenerator<SSEEvent, T, unknown>,
): AsyncGenerator<SSEEvent, T, unknown> {
  const startedAt = Date.now();
  let next = await stream.next();
  while (!next.done) {
    yield stampRequestDuration(next.value, Date.now() - startedAt);
    next = await stream.next();
  }
  return next.value;
}
