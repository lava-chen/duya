/**
 * SessionFinalizer — Plan 550 step 2e (StreamFinalizer).
 *
 * Owns two of the three exit paths of `DuyaAgent.streamChat`:
 *
 *   1. **Success** — PreFinalize veto check, PostTurn dispatch,
 *      mode exit hooks, SessionEnd hook, yield done
 *      (reason='completed'). A `PreFinalize` veto short-circuits
 *      the natural exit and asks the caller to `continue` the
 *      loop instead of yielding done.
 *   2. **User interrupt** — Stop + SessionEnd hook dispatch,
 *      yield done (reason='aborted').
 *
 * The third path — **stream error / context-length retry / abort
 * mid-flight** — is intentionally NOT extracted in this commit:
 * it is tightly coupled to the per-turn loop body (mutates the
 * working `messages` array, re-projects the system prompt, drives
 * a retry via `continue`) and would require passing the entire
 * loop's mutable state into the finalizer. The follow-up
 * SessionFinalizer 2a-2 commit will land the error path once
 * `TurnLoop` extraction stabilises the loop body.
 *
 * Why extracted (success + interrupt only):
 *   The success-finalize block (~50 lines) and the abort block
 *   (~25 lines) read from the same closure (`loopHooks`,
 *   `dispatchHooks`, `buildHookCtx`, `turnContext`, host helpers)
 *   but execute at very different control-flow positions in
 *   `streamChat`. Pulling them behind a class centralises the
 *   hook-dispatch ordering in one place so the contract is
 *   unit-testable in isolation — the inline form made it easy to
 *   drift the ordering between the success and abort paths over
 *   time (e.g. forgetting to dispatch SessionEnd in one of them).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { LoopHookBus, LoopHookDispatchContext } from '../hooks/loop.js';
import type { ResolvedMode, ModeModifierContext } from '../modes/types.js';
import { runExitHooks } from '../modes/apply-modes.js';
import { applyLoopHookEffect } from '../hooks/loop.js';
import { logger } from '../utils/logger.js';
import type { Message, MessageContent, SSEEvent } from '../types.js';
import { APIErrorType, createLLMAPIError, extractProviderErrorMessage } from '@duya/ai';

import type { DeadLoopTracker } from './TurnLoopTracker.js';
import type { TurnContext } from './TurnContext.js';
import type { ToolExecutionPipeline } from '../tool/ToolExecutionPipeline.js';

/**
 * Hook dispatcher closure — yields any `agent_progress` events the
 * underlying `ConfigHooksRunner` emitted during the dispatch.
 * Mirrors the local `dispatchHooks` closure that lives at the top
 * of `streamChat` so the helper ships unchanged across the
 * extraction boundary.
 *
 * Typed loosely as `(event: string, input: ...)` so the agent's
 * existing `dispatchHooks` closure (which constrains `event` to the
 * `HookEvent` string-literal union) is assignable without a cast.
 */
export type HookDispatcher = (
  event: string,
  input: Record<string, unknown>,
) => AsyncGenerator<SSEEvent, unknown, unknown>;

/**
 * Loop-hook context builder closure — captures the per-turn
 * `messages` / `sessionId` / `workingDirectory` / `turnCount` /
 * `seqIndex` so loop hooks see the right envelope. Typed to
 * `LoopHookDispatchContext` (the `event` field is supplied by the
 * caller at dispatch time) so the closure cannot drift from the
 * contract the loop bus expects.
 */
export type HookCtxBuilder = () => Omit<LoopHookDispatchContext, 'event'>;

/**
 * Back-reference interface — the subset of `DuyaAgent` that the
 * finalizer actually needs. Defined here so the agent can be
 * type-checked without coupling `SessionFinalizer.ts` to the full
 * `DuyaAgent` declaration (which would create a circular import
 * the moment a test wants to stub either side).
 *
 * `_commitMessages` is private on `DuyaAgent`; the agent satisfies
 * this interface via a `as unknown as FinalizerHost` cast at the
 * wire site. The cast is the contractually-typed escape hatch —
 * the finalizer is the only collaborator that needs access to the
 * private counter refresh.
 */
export interface FinalizerHost {
  _commitMessages(): void;
  _pushDurable(messages: Message[], message: Message): void;
  setMessages(messages: Message[]): void;
}

/**
 * Result of `finalizeStreamError`. When `kind === 'retry'`, the
 * caller should `continue` the loop with the projected messages;
 * when `kind === 'yield'`, the caller should forward the SSE event
 * to the wire. Mirrors the inline retry / yield split in the
 * legacy catch handler.
 */
export type StreamErrorOutcome =
  | { kind: 'yield'; event: SSEEvent }
  | { kind: 'done'; reason: 'aborted' | 'error' };

/**
 * Finalizer dependencies. The host back-reference is the only
 * field that crosses the agent↔finalizer boundary — every other
 * field is plain per-turn state.
 */
export interface SessionFinalizerDeps {
  /** Mutable working array the loop has been appending to. */
  messages: Message[];
  /** Per-turn counter used by loop-hook context. */
  turnCount: number;
  /** Current seq_index for loop-hook effect injection. */
  seqIndex: number;
  /** Per-turn value type assembled at the top of streamChat. */
  turnContext: TurnContext;
  /** Dead-loop engine invariant — present in deps for symmetry with future error-path extraction. */
  deadLoopTracker: DeadLoopTracker;
  /**
   * Tool executor — `discard()` is invoked from `finalizeStreamError`.
   * Optional because the success + abort paths do not touch the
   * executor; the caller only sets this when wiring the error
   * path through the finalizer.
   */
  executor?: Pick<ToolExecutionPipeline, 'discard'>;
  /** Loop-hook bus for PostTurn / PreFinalize dispatch. */
  loopHooks: LoopHookBus;
  /** Hook dispatcher closure (UserPromptSubmit / SessionStart / Stop / SessionEnd). */
  dispatchHooks: HookDispatcher;
  /** Loop-hook context builder (captures messages / sessionId / cwd). */
  buildHookCtx: HookCtxBuilder;
  /** Resolved modifier-paradigm modes (set when any are active). */
  resolvedModes?: ResolvedMode;
  /** Mode context (companion to `resolvedModes`). */
  modeCtx?: ModeModifierContext;
  /** Back-reference for private helpers (only `_commitMessages` is needed today). */
  host: FinalizerHost;
  /**
   * Optional LLM stop reason for the just-finished turn. PreFinalize
   * hooks (dead-loop nudges, todo gate, premature-stop guard) read
   * this to decide whether to veto the natural exit. Mirrors the
   * inline `{...buildHookCtx(), stopReason: turnStopReason}` block
   * the legacy body used for PreFinalize only.
   */
  stopReason?: string;
}

/**
 * Session-exit finalizer for `streamChat`. See file header for the
 * full contract. All methods are async generators so the caller
 * can `yield*` the SSE events directly without buffering.
 */
export class SessionFinalizer {
  constructor(private readonly deps: SessionFinalizerDeps) {}

  /**
   * Successful-completion path. Fires PreFinalize veto check,
   * PostTurn dispatch, mode exit hooks, then SessionEnd, then
   * yields a single `done` event with reason `'completed'`. If
   * PreFinalize returns a veto, the loop continues (the caller
   * detects this via the boolean return and skips yielding done).
   *
   * @returns `true` if the run should yield `done` and return;
   *          `false` if PreFinalize vetoed and the caller should
   *          `continue` the loop instead.
   */
  async *finalizeSuccess(): AsyncGenerator<SSEEvent, boolean, unknown> {
    const {
      loopHooks,
      dispatchHooks,
      buildHookCtx,
      resolvedModes,
      modeCtx,
      messages,
      seqIndex,
    } = this.deps;

    // PreFinalize: a `block_finalize` veto from any loop hook aborts
    // the natural exit and asks the agent to continue the loop
    // (e.g. dead-loop nudges, todo gate, premature-stop guard).
    // Mirrors the inline `finalizeVeto` block in the legacy body.
    // `stopReason` is only threaded into PreFinalize (PostTurn
    // hooks never read it; the legacy body added it inline for
    // PreFinalize only).
    const preFinalizeCtx = {
      ...buildHookCtx(),
      ...(this.deps.stopReason ? { stopReason: this.deps.stopReason } : {}),
    };
    const finalizeVeto = (
      await loopHooks.dispatch('PreFinalize', preFinalizeCtx)
    ).find((effect) => effect.type === 'block_finalize');
    if (finalizeVeto) {
      applyLoopHookEffect(messages, finalizeVeto, seqIndex);
      return false;
    }

    // PostTurn: run-boundary observation point before the final
    // answer is committed. Plan 426 follow-up.
    for (const effect of await loopHooks.dispatch('PostTurn', buildHookCtx())) {
      applyLoopHookEffect(messages, effect, seqIndex);
    }

    // Mode lifecycle: run onExit hooks for kind:'message' modes at
    // the run boundary. Fail-open; a failing exit hook never blocks
    // the final answer.
    if (resolvedModes && modeCtx) {
      try {
        await runExitHooks(resolvedModes, modeCtx);
      } catch (err) {
        logger.warn(
          `[Agent] runExitHooks failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Refresh sessionInfo counters BEFORE yielding done event so
    // API route can retrieve the final state.
    this.deps.host._commitMessages();

    // SessionEnd: fired on the natural run completion boundary.
    yield* dispatchHooks('SessionEnd', {
      session_id: this.deps.turnContext.sessionId ?? '',
      cwd: this.deps.turnContext.workingDirectory ?? '',
      hook_event_name: 'SessionEnd',
      reason: 'user_exit',
    });

    yield { type: 'done', reason: 'completed' };
    return true;
  }

  /**
   * User-interrupt path. Yielded when the outer loop body's
   * abort signal fires without a stream error (e.g. the user
   * clicked Stop). Refreshes counters, dispatches Stop +
   * SessionEnd hooks, then yields done (reason='aborted').
   */
  async *finalizeAbort(): AsyncGenerator<SSEEvent, void, unknown> {
    const { dispatchHooks, turnContext } = this.deps;
    this.deps.host._commitMessages();
    yield* dispatchHooks('Stop', {
      session_id: turnContext.sessionId ?? '',
      cwd: turnContext.workingDirectory ?? '',
      hook_event_name: 'Stop',
      reason: 'user_request',
    });
    yield* dispatchHooks('SessionEnd', {
      session_id: turnContext.sessionId ?? '',
      cwd: turnContext.workingDirectory ?? '',
      hook_event_name: 'SessionEnd',
      reason: 'user_exit',
    });
    yield { type: 'done', reason: 'aborted' };
  }

  /**
   * Stream-error path. The caller has already attempted emergency
   * compaction (mutating `messages` + `systemPromptContent` in its
   * own scope); this method handles the cleanup + final SSE
   * emission so the catch block in `streamChat` can stay focused
   * on the retry orchestration.
   *
   * Steps:
   *   1. Log the error.
   *   2. `executor.discard()` — drop any buffered tool_use the
   *      failed stream left behind.
   *   3. Remove the trailing incomplete `tool_use` assistant
   *      message so the next turn does not start with an unmatched
   *      tool call.
   *   4. Persist the cleaned array via `host.setMessages` +
   *      `persistableMessages` so the timeline projection drops the
   *      partial assistant.
   *   5. Refresh sessionInfo counters.
   *   6. If the error is an AbortError, inject synthetic
   *      `tool_result` user-messages for any unmatched tool_use
   *      blocks (so the next turn does not trigger the provider's
   *      strict-validation error) and yield done(reason='aborted').
   *   7. Otherwise, wrap the error via Plan 462's machine-coded
   *      mapping and yield error + done(reason='error').
   *
   * Returns void — the generator yields `SSEEvent`s directly.
   */
  async *finalizeStreamError(
    error: unknown,
  ): AsyncGenerator<SSEEvent, void, unknown> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { turnCount, executor, messages } = this.deps;

    logger.error(
      `[Agent] Turn ${turnCount}: Error in LLM stream`,
      error instanceof Error ? error : new Error(errorMessage),
    );

    if (executor) executor.discard();
    this.cleanupIncompleteToolUse(messages);
    this.deps.host.setMessages(persistableMessages(messages));
    this.deps.host._commitMessages();

    if (error instanceof Error && error.name === 'AbortError') {
      yield* this.injectSyntheticToolResults(messages);
      yield { type: 'done', reason: 'aborted' };
      return;
    }

    // Plan 462: surface the provider's own wording with a machine
    // `code`, instead of the raw SDK string that ends up in the
    // banner.
    const llmError = createLLMAPIError(error);
    const providerMessage = extractProviderErrorMessage(llmError) ?? llmError.message;
    yield {
      type: 'error',
      data: providerMessage,
      code:
        llmError.type === APIErrorType.RATE_LIMIT
          ? 'rate_limit_error'
          : llmError.type === APIErrorType.INSUFFICIENT_BALANCE
            ? 'insufficient_balance'
            : llmError.type === APIErrorType.USAGE_LIMIT
              ? 'usage_limit_exceeded'
              : undefined,
    };
    yield { type: 'done', reason: 'error' };
  }

  /**
   * Remove the trailing assistant message if it carries an
   * unmatched `tool_use` block. Prevents "tool call result does
   * not follow tool call" errors when the next session turn
   * resumes from the timeline. Mirrors the inline `lastAssistantIdx`
   * block in the legacy catch handler.
   */
  private cleanupIncompleteToolUse(messages: Message[]): void {
    const lastAssistantIdx = messages
      .map((m, i) => (m.role === 'assistant' ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    if (lastAssistantIdx === undefined || lastAssistantIdx < 0) return;
    const lastAssistant = messages[lastAssistantIdx];
    if (!Array.isArray(lastAssistant.content)) return;
    const hasUnmatchedToolUse = lastAssistant.content.some(
      (block) => block.type === 'tool_use' && 'id' in block,
    );
    if (hasUnmatchedToolUse) {
      messages.splice(lastAssistantIdx, 1);
    }
  }

  /**
   * Generate synthetic `tool_result` user-messages for any pending
   * `tool_use` blocks on the trailing assistant message. Required
   * when a run is interrupted mid-flight, so the next turn does
   * not start with an unmatched `tool_use` and trigger the
   * provider's strict-validation error.
   */
  private async *injectSyntheticToolResults(
    messages: Message[],
  ): AsyncGenerator<SSEEvent, void, unknown> {
    const lastAssistantMsg = messages.at(-1);
    if (!lastAssistantMsg || lastAssistantMsg.role !== 'assistant' || !Array.isArray(lastAssistantMsg.content)) {
      return;
    }
    for (const block of lastAssistantMsg.content) {
      if (block.type !== 'tool_use' || !('id' in block) || typeof block.id !== 'string') continue;
      const toolId = block.id;
      const hasResult = messages.some(
        (m) =>
          (m.role === 'tool' && m.tool_call_id === toolId) ||
          (Array.isArray(m.content) &&
            m.content.some(
              (c: MessageContent) =>
                c.type === 'tool_result' &&
                'tool_use_id' in c &&
                (c as { tool_use_id: string }).tool_use_id === toolId,
            )),
      );
      if (!hasResult) {
        this.deps.host._pushDurable(messages, {
          id: crypto.randomUUID(),
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: 'Interrupted by user',
              is_error: true,
            },
          ],
          timestamp: Date.now(),
        });
      }
    }
    // The synthetic tool_results are persisted via _pushDurable
    // (which also writes the journal row); the SSE surface only
    // needs the done event, which the caller yields next.
  }
}

// Local mirror of `persistableMessages` from DuyaAgent helpers.
// The full helper lives in agent-helpers.ts and is imported in
// DuyaAgent; pulling it in here would create a circular import
// (`agent-helpers.ts` references `DuyaAgent` types). The local
// version is intentionally minimal — it strips journal messages
// and runtime-context envelopes that should never reach the DB.
function persistableMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') {
      return false;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      // Strip runtime-context envelopes from the durable projection.
      // The hook system injects these as `user` messages with a
      // single `tool_result` content; the legacy inline cleanup
      // did not project these either, so we keep parity.
      const firstBlock = m.content[0];
      if (firstBlock && firstBlock.type === 'tool_result') return true;
    }
    return true;
  });
}

// The `HookDispatcher` and `HookCtxBuilder` types are already
// exported at the top of this file; no re-export needed.