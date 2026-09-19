/**
 * TurnStreamRunner — Plan 550 step 2e (TurnLoop, first slice).
 *
 * Owns the per-turn LLM stream subscription + retry-with-backoff
 * wrapper. Extracted from the inline `openLLMStream` +
 * `streamGenerator` IIFE that previously lived at the top of
 * `DuyaAgent.streamChat`. The wrapper:
 *
 *   1. Refreshes the declared-tools snapshot before every attempt
 *      (so Plan 480 P2.4's per-request visibility guard sees the
 *      latest toolset — including any discovered tools promoted by
 *      a mid-stream compaction).
 *   2. Calls `llmClient.streamChat` and yields its events directly.
 *   3. On `streamError`, asks the caller (via `shouldReplay`) whether
 *      to retry; if yes, emits a `chat:retry` chip (Plan 462) so the
 *      renderer can show *why* it is reconnecting, awaits the
 *      backoff delay, and loops. On no, rethrows.
 *   4. Before each retry, calls the caller's `onRetryReset` so the
 *      per-attempt accumulators (`assistantContent`,
 *      `thinkingContent`, `needsFollowUp`, `modeSwitchToolIds`,
 *      `turnToolCalls`, ...) drop to empty — a replay must not
 *      inherit state from the previous attempt.
 *
 * Why extracted:
 *   The retry contract is the most subtle part of the per-turn loop:
 *   it has to coordinate the LLM client's abort signal, the
 *   transport-layer `shouldReplayStreamAfterError` policy, the
 *   visible-retry chip, the per-attempt reset, and the sleep
 *   cancellation. Putting it in a generator that yields the retry
 *   event directly makes it testable in isolation (Plan 550
 *   targets the same shape as `finalizeStreamError`:
 *   inline → unit-tested async generator).
 *
 *   The next session's step (`TurnEventDispatcher`) peels off the
 *   per-event dispatch handlers (`tool_use`, `text`, `done`,
 *   ...). This commit only handles the stream-subscription +
 *   retry envelope, leaving the per-event dispatch unchanged so
 *   the diff stays reviewable.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { logger } from '../utils/logger.js';
import { createRetryEvent, extractProviderErrorMessage, sleep } from '@duya/ai';
import type { AIClient, Message, SSEEvent } from '@duya/ai';
import {
  shouldReplayStreamAfterError,
  streamReplayDelayMs,
  STREAM_REPLAY_MAX_ATTEMPTS,
} from './stream-retry.js';
import type { Tool } from '../types.js';

/**
 * Caller's per-attempt reset hook. Invoked before each replay
 * attempt (not before the first) so partial-attempt state
 * (`assistantContent`, `thinkingContent`, `deadLoopTracker`,
 * executor buffer, ...) drops to empty. The hook is also a
 * natural place for the caller to flip any `turnCommitted`-style
 * flags if it tracks them across attempts.
 */
export type RetryResetHook = () => void;

/**
 * Caller's per-attempt declared-tools refresh. Returns the
 * `Set<string>` of tool names the visibility guard should treat as
 * exposed for this attempt. The caller typically derives the set
 * from the current `tools` array (which changes across rounds as
 * discovered tools join).
 */
export type RefreshDeclaredToolsHook = () => Set<string>;

export interface TurnStreamRunnerDeps {
  /** The LLM client to subscribe to (provides `streamChat`). */
  llmClient: AIClient;
  /** Current provider-bound messages snapshot (mutable reference; passed to the LLM client). */
  llmMessages: Message[];
  /** Current system prompt content (read-only). */
  systemPromptContent: string;
  /** Current tool list (read-only). */
  tools: readonly Tool[];
  /** Stream options from `ChatOptions`. */
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  /** Optional cap for maxOutputTokens — sourced from runtime config. */
  maxOutputTokens?: number;
  /** Abort signal for the per-turn request. */
  signal: AbortSignal;
  /** Per-turn counter used in the `chat:retry` chip payload. */
  turnCount: number;
  /** True iff the agent has already committed an assistant message in this turn. */
  turnCommitted: boolean;
  /** Per-attempt refresh for the declared-tools snapshot. */
  refreshDeclaredTools: RefreshDeclaredToolsHook;
  /** Per-retry reset for the caller's per-attempt accumulators. */
  onRetryReset: RetryResetHook;
}

export interface TurnStreamRetryAttempt {
  /** Zero-based retry attempt (0 = first attempt). */
  attempt: number;
  /** Maximum attempts the policy permits. */
  maxAttempts: number;
  /** Backoff delay in ms before the next attempt. */
  delayMs: number;
  /** Provider wording for the `chat:retry` chip. */
  providerMessage?: string;
}

/**
 * Wrap `llmClient.streamChat` with the Plan 462 retry envelope.
 * Yields the LLM events directly. On a retryable stream error,
 * yields a `chat:retry` chip event and awaits the backoff delay
 * before the next attempt. The first `n-1` retries invoke
 * `onRetryReset` so the caller can clear per-attempt accumulators;
 * the final successful (or un-retryable) attempt's events are
 * forwarded untouched.
 *
 * Returns when the LLM stream completes normally (or rethrows on
 * a non-retryable error). The caller drives the loop body
 * (`for await (const event of runTurnStream(deps))`) and is
 * responsible for the per-event dispatch — that is `TurnEventDispatcher`,
 * the next TurnLoop slice.
 */
export async function* runTurnStream(
  deps: TurnStreamRunnerDeps,
): AsyncGenerator<SSEEvent, void, unknown> {
  let attempt = 0;
  while (true) {
    try {
      // Refresh the declared-tools snapshot for *this* attempt so the
      // visibility guard inside the executor reads the latest set
      // (Plan 480 P2.4: the tool array changes across rounds as
      // discovered tools join).
      const declaredToolsForRequest = deps.refreshDeclaredTools();

      const streamOptions = {
        systemPrompt: deps.systemPromptContent,
        tools: deps.tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
        maxTokens: deps.maxTokens,
        temperature: deps.temperature,
        signal: deps.signal,
        effort: deps.effort,
        maxOutputTokens: deps.maxOutputTokens,
      };

      // `_declaredToolsForRequest` is the per-attempt bound the
      // visibility guard reads; we capture it in a closure-only
      // shape so the legacy field stays consistent with the inline
      // implementation. The caller no longer needs the variable.
      void declaredToolsForRequest;

      yield* deps.llmClient.streamChat(deps.llmMessages, streamOptions);
      return;
    } catch (streamError) {
      if (
        !shouldReplayStreamAfterError(streamError, {
          aborted: deps.signal.aborted,
          turnCommitted: deps.turnCommitted,
          attemptsUsed: attempt,
        })
      ) {
        throw streamError;
      }

      attempt++;
      const replayDelayMs = streamReplayDelayMs(attempt);
      const detail =
        streamError instanceof Error ? streamError.message : String(streamError);
      logger.warn(
        `[Agent] Turn ${deps.turnCount}: LLM stream died mid-flight (${detail}); replaying ` +
          `${attempt}/${STREAM_REPLAY_MAX_ATTEMPTS} in ${replayDelayMs}ms`,
      );

      // Discard the partial attempt: tool_use events arrive before
      // `done` so the executor may already hold buffered calls, and
      // every per-attempt accumulator must start empty for the replay.
      // The caller owns `executor.discard()` + dead-loop reset + the
      // per-attempt closures (`assistantContent`, `thinkingContent`,
      // ...) via `onRetryReset`.
      deps.onRetryReset();

      // Surface the replay through the same channel as the
      // transport-layer retry (`system` + metadata.retryAttempt →
      // worker boundary emits a chat:retry chip). Plan 462: carry
      // the provider wording so the chip says *why* it is
      // reconnecting.
      yield createRetryEvent(
        attempt,
        STREAM_REPLAY_MAX_ATTEMPTS,
        replayDelayMs,
        extractProviderErrorMessage(streamError) ??
          (streamError instanceof Error ? streamError.message : undefined),
      );
      await sleep(replayDelayMs, deps.signal);
    }
  }
}

/**
 * Stand-alone type guard helper for tests. Returns the `RetryResetHook`
 * shape for a given callback so callers can wire the retry envelope
 * without a `new` allocation when they only need a one-shot wrapper.
 */
export function asRetryResetHook(fn: () => void): RetryResetHook {
  return fn;
}

/**
 * Same idea for the declared-tools refresh: explicit type guard so
 * the call site reads naturally.
 */
export function asRefreshDeclaredToolsHook(
  fn: () => Set<string>,
): RefreshDeclaredToolsHook {
  return fn;
}