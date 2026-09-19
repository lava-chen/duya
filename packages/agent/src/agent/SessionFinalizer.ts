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
import type { Message, SSEEvent } from '../types.js';

import type { DeadLoopTracker } from './TurnLoopTracker.js';
import type { TurnContext } from './TurnContext.js';

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
}

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
}

// The `HookDispatcher` and `HookCtxBuilder` types are already
// exported at the top of this file; no re-export needed.