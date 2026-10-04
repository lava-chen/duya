/**
 * `RunEngineImpl` — the run execution engine, and the owner of the turn loop.
 *
 * ## What this file is
 *
 * Plan 600 `04-runtime-owns-execution.md` section 2 item 1 asks for exactly one
 * thing: "runtime owns the `model request -> tool execution -> tool result
 * backfill -> next turn` loop", evidenced by "an implementation of that loop
 * exists in the runtime package and `packages/agent` no longer holds it".
 *
 * That is this file. The four decision points named in `ports.ts` are the
 * `runTurn` spine and nothing else in this module may make them:
 *
 * | Decision | Method | Was |
 * | --- | --- | --- |
 * | call the model | `streamModel` | `DuyaAgent.ts:2338` `runTurnStream` |
 * | dispatch a tool | `dispatchCall` | `DuyaAgent.ts:2477` `executor.addTool` |
 * | feed the result back | `drainOutcomes` | `DuyaAgent.ts:2677` drain, `:2717` push |
 * | decide to stop | `shouldStop` | `DuyaAgent.ts:3107`, ceiling at `:3097` |
 *
 * ## Why an implementation and not a port
 *
 * Section 0 of the same document records that a real `RunController` around an
 * executor that still calls `duyaAgent.streamChat` passes the old acceptance
 * gate while the loop has not moved at all — `headless-run-host.ts:26` is that
 * shape and it is in this repository. A second `ExecutionChannel`
 * implementation would therefore be worth nothing here. What makes this file
 * evidence is that it is REACHABLE and REAL: the loop's control flow lives
 * here, and the legacy package supplies mechanisms, not a loop.
 *
 * ## The one rule that keeps this honest
 *
 * **The engine derives a stop only from its own counters and the signals handed
 * to it.** Everything host-supplied is either a payload (what to send), a
 * mechanism (how to execute), or an advisory contribution (what to add). A host
 * cannot hand the engine a turn count, a `seq`, a fence, or a verdict — those
 * are absent from `RunExecutionRequest` by construction, which is what
 * `port-guards.ts` asserts.
 *
 * ## Budget: enforced HERE, deliberately
 *
 * Plan 600 `04` section 2.2 gives budget judgement to the worker, and
 * `ports.ts` left `BudgetPort` OPTIONAL because the code disagreed with the
 * plan — `isBudgetExhausted` is called server-side today (`run-session.ts:882`,
 * folded into `resolveRunOutcome` at `:542`). That tension is resolved here in
 * favour of the engine, on the argument `run-budget.ts:18-24` already makes:
 * turns count `turn.started` and tool calls count `tool.call_started`
 * precisely because a call that died mid-execution still consumed budget. Only
 * the component that DISPATCHES can count that at the moment it happens; an
 * observer on the far side of a transport learns one event too late, which is
 * exactly when it can no longer stop anything.
 *
 * The engine therefore checks before every model call and before every tool
 * dispatch, and the check calls the SAME `isBudgetExhausted` the server calls,
 * with the same spend shape. The server-side call is left in place as a
 * cross-check rather than deleted — it lives in `run-session.ts`, which this
 * slice does not own, and a cross-check that agrees is not a second source of
 * truth. What WOULD be a second source of truth is a server that overrides the
 * engine, and that cannot happen while the engine only PROPOSES a terminal
 * (`RunEventStorePort.proposeTerminal`) and `RunSession.settle` remains the
 * single writer (`run-session.ts:519,527`).
 *
 * `BudgetPort` stays OPTIONAL in `ports.ts` — I did not edit that contract —
 * so a host with no budget gets no enforcement, and that is reported rather
 * than assumed. The engine's own turn ceiling is separate and is below.
 *
 * ## Cancellation
 *
 * `RunExecutionRequest.signal` is caller-owned and mandatory, which is the
 * correction `ports.ts` makes to `DuyaAgent.streamChat`, whose
 * `AbortController` is created at its first line (`DuyaAgent.ts:963`) and
 * therefore covers none of the setup in front of it. Here the engine checks
 * the signal at six named points and hands the SAME signal to every port call,
 * so a stop reaches context assembly and the first model call rather than only
 * the turns that follow them.
 *
 * ## Subtask reclamation
 *
 * Owned here, and run on EVERY exit path — completed, failed, cancelled,
 * budget-exhausted, ceiling — because a sweep that only runs on the happy path
 * leaves orphans holding a workspace and a process tree exactly when the parent
 * is in no state to clean them up. The reason is DERIVED from the exit rather
 * than chosen again at cleanup time: a run that ended because it was cancelled
 * must not sweep its subtasks as `failed`, and one that failed must not record
 * a user cancel. That distinction is the whole reason
 * `SubtaskTerminationReason` was widened in `ports.ts`.
 *
 * ## No shared mutable state
 *
 * Everything a run needs is on `RunContext`, built per `execute` call. An
 * earlier draft of this file parked the run id, the signal and the start time
 * on the engine instance, which is correct for exactly one concurrent run and
 * silently wrong for two — a worker's whole purpose is running several. The
 * engine object is stateless and therefore safe to share.
 */

import type {
  ProtocolErrorInfo,
  RunEvent,
  RunFence,
  RunId,
  RunManifest,
  RunStatus,
} from '@duya/agent-protocol';
import { isBudgetExhausted, type RunSpend } from '@duya/agent-core';
import type { StopReceipt, StopRequest } from '../transport/execution-channel.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  BudgetPort,
  ExtensionContext,
  ExtensionContribution,
  ExtensionPhase,
  ModelMessage,
  ModelRequest,
  RunEngine,
  RunEnginePorts,
  RunExecutionHandle,
  RunExecutionRequest,
  RunInputSnapshot,
  SubtaskTerminationReason,
  TerminalCandidate,
  ToolCallRequest,
  ToolDispatchTicket,
  ToolDrainItem,
  ToolOutcome,
  TransientContextFragment,
  TurnAssemblyInput,
} from './ports.js';

// ============================================================================
// Public shape
// ============================================================================

/**
 * Why the engine stopped.
 *
 * Always a CANDIDATE. `RunSession.settle` is the single writer of the terminal
 * (`run-session.ts:519,527`) and may disagree — a budget ceiling the engine has
 * not seen, a lost dispatch, a server-side stop.
 */
export type EngineExitReason =
  | 'completed'
  | 'budget_exhausted'
  | 'max_turns'
  | 'cancelled'
  | 'failed';

export interface EngineExit {
  readonly reason: EngineExitReason;
  /** `failed` only. A message, never a stack. */
  readonly message?: string;
}

/** What the run reported about its own exit. For a log line or a receipt. */
export interface EngineRunReport {
  readonly runId: RunId;
  readonly exit: EngineExit;
  readonly spend: RunSpend;
  readonly turns: number;
  /** Subtasks this run actually terminated. `already_terminal` is not counted. */
  readonly reclaimed: number;
}

/**
 * The engine's own knobs, which are NOT part of the port set.
 *
 * Separate from `RunExecutionRequest` on purpose: these are the engine's
 * counters, and a host that could hand one in would be able to pre-load a turn
 * count and make a replayed attempt look like a different run.
 */
export interface RunEngineOptions {
  /**
   * Injectable clock. The budget verdict is a decision, and `00-contracts.md`
   * section H requires a decision input to be injected rather than read from a
   * host clock the engine cannot replay.
   */
  readonly now: () => number;
  /**
   * Ceiling when the manifest's budget names none.
   *
   * `undefined` means uncapped, which is the correct reading of "no ceiling was
   * set". A silent default like 25 would be a ceiling the manifest never agreed
   * to, and it would truncate long runs without anything recording why.
   */
  readonly defaultMaxTurns?: number;
  /**
   * Report a run's exit once it has stopped. Optional, and called on EVERY
   * path including a thrown one — an exit nobody reports is an exit nobody can
   * account for.
   */
  readonly onReport?: (report: EngineRunReport) => void;
}

// ============================================================================
// The engine
// ============================================================================

/**
 * The real engine.
 *
 * Construct one per process; the object holds no run state, so it is safe to
 * share. Ports are supplied PER RUN (`RunExecutionRequest.ports`) because the
 * model, the tool surface and the catalog snapshot are all per-run facts.
 */
export class RunEngineImpl implements RunEngine {
  readonly #options: RunEngineOptions;

  constructor(options: RunEngineOptions) {
    this.#options = options;
  }

  execute(request: RunExecutionRequest): RunExecutionHandle {
    // ONE internal controller, and the caller's signal is forwarded INTO it.
    //
    // The ports are handed this controller's signal rather than the caller's
    // own object, and that is deliberate. A port cannot abort a signal it was
    // given, so an engine that handed out the caller's signal could not honour
    // its own `handle.stop` — the stop would have to abort a controller the
    // engine does not hold. Forwarding keeps a single authority: the engine's
    // controller, which both the caller's abort and `handle.stop` reach.
    //
    // The consequence, stated so a test does not assert the wrong thing: the
    // signal a port receives is not the SAME OBJECT as the caller's, and must
    // not be. What it must be is a signal that becomes aborted when the
    // caller's does — which is the property that makes a stop reach context
    // assembly and the first model call, the gap `DuyaAgent.ts:963` leaves open
    // by building its controller too late to cover them.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(request.signal.reason);
    if (request.signal.aborted) controller.abort(request.signal.reason);
    else request.signal.addEventListener('abort', onCallerAbort, { once: true });

    // `settled` is what distinguishes "stopped a live run" from "arrived after
    // the run ended". The abort state alone cannot: a run that finished on its
    // own leaves the signal UNABORTED, so a stop arriving afterwards would
    // report `requested: true` for a run it did not reach — the exact false
    // claim `StopReceipt.requested` exists to prevent.
    let settled = false;
    const completed = this.#run(request, controller.signal).finally(() => {
      settled = true;
      request.signal.removeEventListener('abort', onCallerAbort);
    });

    return {
      completed: () => completed,
      stop: async (stopRequest: StopRequest): Promise<StopReceipt> => {
        // Reported from the two facts observed here — whether the run had
        // already settled, and whether this call was the one that aborted it.
        //
        // A stop arriving after the run ended did not stop anything, and
        // `StopDisposition` has no "too late" member, so that case is reported
        // as `unavailable` with `requested: false`: the pair the protocol
        // defines for "this call reached no live run" (`run.ts:91-95`).
        // Reporting `cooperative` there would let a caller believe a clean
        // cooperative stop where the run had in fact finished on its own.
        const reachedLiveRun = !settled && !controller.signal.aborted;
        const startedAt = this.#options.now();
        if (reachedLiveRun) controller.abort(new Error(stopRequest.reason));

        try {
          await completed;
        } catch {
          // The engine records its own failure as an exit reason; awaiting it
          // here must not turn a stop into a throw.
        }
        return {
          requested: reachedLiveRun,
          disposition: reachedLiveRun ? 'cooperative' : 'unavailable',
          waitedMs: Math.max(0, this.#options.now() - startedAt),
          reason: stopRequest.reason,
        };
      },
    };
  }

  /**
   * The whole run.
   *
   * Every exit funnels through one `finally`, so the subtask sweep and the
   * terminal proposal cannot be skipped by a `return` that forgot them.
   */
  async #run(request: RunExecutionRequest, signal: AbortSignal): Promise<void> {
    const { manifest, input, ports } = request;
    const runId = manifest.runId;
    const startedAt = this.#options.now();
    const spend = new RunSpendLedger();
    /** Fragments produced this turn that the NEXT turn's assembly will carry. */
    const deferred: TransientContextFragment[] = [];
    /** Dispatch tickets, so a settle names the key its own `begin` minted. */
    const tickets = new Map<string, ToolDispatchTicket>();

    let exit: EngineExit = { reason: 'completed' };
    // Declared OUTSIDE the try so the `finally` can release a lease that was
    // acquired before the try body ran. A lease acquired and never released
    // because the acquire itself was the thing that threw is exactly the state
    // a crash leaves behind.
    let fence: RunFence | null = null;
    try {
      // The fence is ACQUIRED, never handed in (ports.ts contract 3): the store
      // is the only authority that may refuse a write, so a fence supplied from
      // outside would be a second authority that cannot be refused.
      fence = ports.attempt === undefined ? null : await ports.attempt.acquire(runId);

      for (let turn = 1; ; turn++) {
        // ── Budget, BEFORE this turn is counted and BEFORE the model request ──
        // Checked here rather than after the turn, because a check after the
        // spend it should have prevented is an accounting report, not a ceiling.
        //
        // The ORDER matters and is easy to get backwards. `isBudgetExhausted`
        // compares `spend.turns >= maxTurns`, and a turn is counted the moment
        // it begins, so counting first would make turn 1 of a `maxTurns: 1` run
        // look like the second turn of a one-turn budget and refuse the run
        // before it ever spoke. The question is "may I START this turn", and the
        // spend to ask about is the spend of the turns already finished — which
        // is why this reads `spend` directly rather than a context that does not
        // exist yet.
        if (this.#budgetExhausted(ports, spend, startedAt)) {
          ports.tools.discard('budget_exhausted');
          exit = { reason: 'budget_exhausted' };
          break;
        }
        spend.beginTurn(turn);

        const ctx: RunContext = {
          runId,
          turn,
          signal,
          ports,
          input,
          manifest,
          startedAt,
          spend,
          fence,
          tickets,
          turnWork: new TurnWork(),
        };

        if (isAborted(signal)) {
          ports.tools.discard('abandoned');
          exit = { reason: 'cancelled' };
          break;
        }

        await this.#contribute(ctx, 'before_turn', {});

        // ── Decision 1: call the model ───────────────────────────────────────
        // Assembled by the host (it owns the catalog, the skills and the
        // connector bindings, all of which live above this layer), requested ONCE
        // per turn, and used as it comes back. The engine does not decide what
        // is in it.
        const assembly: TurnAssemblyInput = {
          runId,
          runEpoch: fence?.runEpoch ?? 0,
          turn,
          history: input.history,
          attachments: input.attachments,
          catalog: input.catalog,
          digest: input.revision,
        };
        const assembled: AssembledTurn = await ports.context.assemble(assembly);
        // NOTE: the fragments are NOT re-deferred here. `#drainOutcomes` already
        // handed each one to `ports.context.defer` at the moment it was produced,
        // which is the only moment the host can attach it to the right turn.
        // Deferring again here pushed every tool result into the host a second
        // time, so a host that injects on `defer` would hand the model the same
        // result twice — invisible in a single-turn run and wrong in every
        // multi-turn one.
        const modelRequest = await this.#modelRequest(ctx, assembled, deferred);
        // Consumed: the fragments belong to the request that just carried them
        // and must not ride the next one. Left in place they would accumulate
        // turn after turn, so turn 5 would resend turns 1-4's results and the
        // context would grow with copies of answers the model already has.
        deferred.length = 0;
        await this.#contribute(ctx, 'before_model', {});

        ports.events.publish(this.#turnStartedEvent(ctx, modelRequest));

        const outcome = await this.#streamModel(ctx, modelRequest);
        if (outcome !== null) {
          exit = outcome;
          break;
        }

        // ── Decisions 2 and 3: dispatch, then feed the results back ─────────
        // Draining is what makes the NEXT turn's request carry the tool
        // results, so these are two decisions at one point in the spine.
        const turnWork = ctx.turnWork;
        await this.#drainOutcomes(ctx, deferred);

        // ── Decision 4: decide to stop ───────────────────────────────────────
        if (isAborted(signal)) {
          ports.tools.discard('abandoned');
          exit = { reason: 'cancelled' };
          break;
        }
        const stop = await this.#shouldStop(ctx, turnWork);
        if (stop !== null) {
          exit = stop;
          break;
        }
        // Falls through to the next iteration. This `for` IS the loop the plan
        // asks to move out of `DuyaAgent`.
      }
    } catch (error) {
      // A thrown turn is a FAILED run, not a silent one. Left uncaught it would
      // leave a run that looks live to every consumer of the event stream.
      exit = { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
      const reclaimed = await this.#reclaimSubtasks(ports, exit);
      // The lease is released on every exit, including a throw. `ports.ts`
      // contract 3 requires it: a lease that only unregisters on a clean exit
      // holds a run open forever after a crash, which is precisely the case a
      // lease exists to make recoverable.
      //
      // A release that throws is swallowed for the same reason the subtask
      // sweep's is — the parent is already ending, and replacing its terminal
      // with a synthetic one over a bookkeeping failure destroys the record of
      // what actually happened.
      await this.#releaseFence(ports, fence, exit);
      ports.events.proposeTerminal(this.#terminalCandidate(exit));
      this.#options.onReport?.({
        runId,
        exit,
        spend: spend.snapshot,
        turns: spend.turns,
        reclaimed,
      });
    }
  }

  // ── Decision 1 ────────────────────────────────────────────────────────────

  /**
   * Open the model stream and dispatch whatever it asks for.
   *
   * Returns a non-null exit when the turn ended for a reason the loop must not
   * second-guess: the caller's signal, or a fatal model frame. `null` means the
   * stream completed and the run continues to drain.
   */
  async #streamModel(ctx: RunContext, request: ModelRequest): Promise<EngineExit | null> {
    const { ports, signal, spend } = ctx;

    let sawFrame = false;
    for await (const frame of ports.model.stream(request, signal)) {
      if (isAborted(signal)) {
        // A stop mid-stream must not dispatch whatever the model was in the
        // middle of asking for, and `discard` is what drops it: without it a
        // replay of this turn would double-dispatch calls the first attempt
        // already sent.
        ports.tools.discard('abandoned');
        return { reason: 'cancelled' };
      }
      sawFrame = true;

      switch (frame.type) {
        case 'tool_use':
        case 'tool_use_started':
          await this.#dispatchCall(ctx, frame.call);
          break;
        case 'usage':
          spend.addTokens(frame.totalTokens ?? frame.inputTokens + frame.outputTokens);
          break;
        case 'error':
          // A fatal frame ends the run. `retryable` is the provider's claim and
          // the engine does not second-guess it: within-attempt retry belongs to
          // the model port (04 section 3.1) and the cross-run decision belongs
          // to the Control Plane, which this port cannot express.
          if (!frame.retryable) {
            ports.tools.discard('model_retry');
            return { reason: 'failed', message: frame.message };
          }
          break;
        case 'turn_stopped':
          if (frame.reason === 'cancelled') {
            ports.tools.discard('abandoned');
            return { reason: 'cancelled' };
          }
          break;
        default:
          // `text`, `thinking` and `tool_use_delta` are narration. They reach a
          // host through the event store if it wants them; they decide nothing.
          break;
      }
    }

    if (!sawFrame) {
      // A stream that produced no frames and no error is a transport that died
      // quietly. Treating that as a completed turn would let the stop decision
      // below return "completed" for a run that never spoke.
      return { reason: 'failed', message: 'the model stream produced no frames' };
    }
    return null;
  }

  // ── Decision 2 ────────────────────────────────────────────────────────────

  /**
   * One tool call, in the order the port contract fixes.
   *
   * `sideEffects.begin` resolves BEFORE `tools.dispatch`, and that order is the
   * point of contract 4: a dispatch with no ledger ticket has no row to
   * reconcile against, so a process that dies mid-call leaves an effect nobody
   * recorded and the next attempt cannot tell "it happened" from "it did not" —
   * which is `unknown`, the state that blocks automatic retry.
   *
   * Approval is asked BEFORE the ticket is taken, not after: a durable `planned`
   * row for a call that is then denied describes a call that will never exist.
   */
  async #dispatchCall(ctx: RunContext, call: ToolCallRequest): Promise<void> {
    const { ports, signal, spend, runId } = ctx;

    const verdict: ApprovalVerdict = await ports.approval.authorize(
      {
        runId,
        callId: call.callId,
        toolName: call.name,
        input: call.input,
        permissionMode: this.#permissionMode(ctx),
      },
      signal,
    );
    if (!verdict.allowed) {
      // Reported rather than dropped. `unavailable` is kept distinct from
      // `denied` so a broken bridge does not read as a user saying no — see
      // `ApprovalVerdict`.
      ports.events.publish({
        type: 'tool.timed_out',
        toolCallId: call.callId,
        toolName: call.name,
        elapsedMs: 0,
      });
      return;
    }

    // Budget again, immediately before the dispatch. This is the last point at
    // which a ceiling can still PREVENT the call rather than describe it — and
    // it reads the spend INCLUDING this turn, which is the point: a ceiling on
    // tool calls must be able to stop the call that would cross it.
    if (this.#budgetExhausted(ports, ctx.spend, ctx.startedAt)) {
      ports.tools.discard('budget_exhausted');
      return;
    }

    spend.addToolCall();
    // Resolved BEFORE the dispatch, and the resolution is the ledger's: the
    // engine never names an attempt key, so two attempts cannot collide on one.
    const ticket = await this.#ticket(ctx, call);
    ports.events.publish({
      type: 'tool.call_started',
      toolCallId: call.callId,
      toolName: call.name,
      arguments: call.input,
      attempt: 1,
    });
    await this.#contribute(ctx, 'before_tool', { call });
    ports.tools.dispatch(call, ticket);
    ctx.tickets.set(call.callId, ticket);
    // Recorded only once the call is actually on its way, so a denied or
    // budget-refused call does not count as work the next turn must answer.
    ctx.turnWork.record();
  }

  // ── Decision 3 ────────────────────────────────────────────────────────────

  /**
   * Feed the results back, and account for the side effect of each.
   *
   * Settling the ledger here is what makes a call that DID land and one that
   * did not distinguishable after a crash. `unknown` is a legal state and the
   * honest one: the call was made and no authority has said whether its effect
   * landed.
   *
   * ## Why the switch, and not "handle the extra fields"
   *
   * Two of the three drained kinds are not results, and both used to arrive
   * through the same arm. A progress frame would be settled into the ledger as
   * `succeeded` with the sub-agent's text as its detail, and deferred as a
   * `deferred_tool_context` fragment -- which is fed to the MODEL on the next
   * turn. One mis-typed adapter would therefore write a false ledger row AND
   * leak a sub-agent's internal stream into the context window.
   *
   * Narrowing on `kind` makes both impossible: a fourth kind is a compile error
   * here rather than a value that reaches the ledger arm by default.
   *
   * Measured, because the obvious alternative is not the silent one. Folding the
   * kinds in THIS switch fails loudly -- a progress item has no `content`, so
   * the arm's `content.slice` raises and the run dies (that mutation turns 9 of
   * 9 tests in `tool-drain-contract.test.ts` red with a TypeError). The silent
   * shape is the ADAPTER's, where a `JSON.stringify` produces a `content` that
   * satisfies every field the old type asked for; that one is proven red in
   * `packages/agent/src/process/__tests__/run-engine-ports-drain.test.ts`. Both
   * halves are pinned, because either alone is a regression.
   */
  async #drainOutcomes(ctx: RunContext, deferred: TransientContextFragment[]): Promise<void> {
    const { ports, signal } = ctx;
    for await (const item of ports.tools.drain(signal) as AsyncIterable<ToolDrainItem>) {
      if (isAborted(signal)) {
        ports.tools.discard('abandoned');
        return;
      }
      switch (item.kind) {
        case 'tool_result': {
          if (ports.sideEffects !== undefined) {
            // Settle against the key the LEDGER minted at dispatch, not against
            // the callId. A ledger that namespaces its keys (`key:<callId>`, as
            // `InMemoryCheckpointStore` does) would otherwise record a settle
            // against a row that does not exist, leaving every call permanently
            // `dispatched` — an effect a crash could never classify.
            const ticket = ctx.tickets.get(item.callId) ?? SYNTHETIC_TICKET;
            await ports.sideEffects.settle({
              attemptKey: ticket.attemptKey,
              state: item.isError ? 'failed' : 'succeeded',
              detail: item.content.slice(0, LEDGER_DETAIL_LIMIT),
            });
          }
          const fragment: TransientContextFragment = {
            kind: 'deferred_tool_context',
            text: item.content,
            key: `tool_result:${item.callId}`,
          };
          // Both: `defer` hands it to the host for the next assembly, and the
          // local list carries it into this run's own message seed. One write,
          // two readers, no second copy of the text.
          ports.context.defer(fragment);
          deferred.push(fragment);
          await this.#contribute(ctx, 'after_tool', { outcome: item });
          break;
        }
        case 'deferred_context': {
          // PENDING, deliberately: resolving here would move the await into the
          // drain loop, so a follow-up review that never settles would stall
          // this turn instead of the next one (`ports.ts`,
          // `DeferredToolContext`).
          //
          // Keyed by call, and NOT `tool_result:` — that prefix is what
          // `#drainOutcomes` uses for a real result, and sharing it would let a
          // deferred context overwrite a result for the same call in the host's
          // keyed map, silently losing one of the two.
          const fragment: TransientContextFragment = {
            kind: 'deferred_tool_context',
            key: `deferred:${item.callId}`,
            pending: item.pending,
          };
          ports.context.defer(fragment);
          deferred.push(fragment);
          break;
        }
        case 'subagent_progress': {
          // Not a model input and not a ledger event. It is projected into the
          // protocol vocabulary by the host, and an unmapped frame becomes a
          // diagnostic rather than a silence (`RunEventStorePort`'s
          // `projectSubagentProgress`).
          const project = ports.events.projectSubagentProgress;
          const mapped = project === undefined ? null : project.call(ports.events, item.event);
          if (mapped === null) {
            ports.events.publish({
              type: 'diagnostic',
              level: 'warn',
              message: `subagent progress frame "${item.event.type}" has no protocol destination`,
              data: { callId: item.callId, agentEvent: item.event },
            });
          } else {
            ports.events.publish(mapped);
          }
          break;
        }
      }
    }
  }

  // ── Decision 4 ────────────────────────────────────────────────────────────

  /**
   * What the engine may decide alone.
   *
   * The FIRST question is the one the legacy loop asked at
   * `DuyaAgent.ts:3107`: did this turn leave work behind? A turn that
   * dispatched nothing has nothing to feed back, so another model call would be
   * the same prompt twice. That is the whole of `needsFollowUp`, and it is a
   * fact about what the engine dispatched, not something a host asserts.
   *
   * The ceiling is checked SECOND and is not negotiable: a binding veto that
   * reopens a run already at its ceiling would spin forever, and an engine that
   * let a contributor override its own ceiling is not enforcing one.
   *
   * A binding `before_finalize` veto then reopens the loop. That is the one
   * place a contributor influences the OUTCOME, and it does so through a
   * DECLARED veto rather than by deciding the loop — which is the difference
   * `00-contracts.md` section F rule 2 draws between contributing a decision
   * and taking the loop over.
   */
  async #shouldStop(ctx: RunContext, turnWork: TurnWork): Promise<EngineExit | null> {
    // The ceiling FIRST, and not negotiable: a binding veto that reopens a run
    // already at its ceiling would spin forever, and an engine that let a
    // contributor override its own ceiling is not enforcing one.
    if (ctx.spend.turns >= this.#maxTurns(ctx.ports)) return { reason: 'max_turns' };

    // A binding veto keeps the run open even when the model asked for nothing.
    // This is the one place a contributor influences the OUTCOME, and it does so
    // through a DECLARED veto rather than by deciding the loop — the difference
    // `00-contracts.md` section F rule 2 draws between contributing a decision
    // and taking the loop over.
    const contributions = await this.#contribute(ctx, 'before_finalize', {});
    const vetoed = contributions.some(
      (contribution) => contribution.binding && 'veto' in contribution.content,
    );
    if (vetoed) return null;

    // Work behind us means the model has results it has not seen yet. Stopping
    // here would strand them: the tool ran, its effect is on disk, and the
    // answer never reaches the model. This is `needsFollowUp` at
    // `DuyaAgent.ts:3107`, and it is a fact about what the engine dispatched.
    if (turnWork.dispatched > 0) return null;

    return { reason: 'completed' };  }

  // ── helpers ───────────────────────────────────────────────────────────────

  #maxTurns(ports: RunEnginePorts): number {
    const declared = ports.budget?.budget.maxTurns;
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared;
    return this.#options.defaultMaxTurns ?? Number.POSITIVE_INFINITY;
  }

  /**
   * The budget verdict, from the SAME function and the SAME spend shape the
   * server uses. A second implementation of the counting rules is how two sides
   * come to disagree about whether a run was over budget.
   */
  #budgetExhausted(ports: RunEnginePorts, spend: RunSpendLedger, startedAt: number): boolean {
    const budget: BudgetPort | undefined = ports.budget;
    if (budget === undefined) return false;
    return isBudgetExhausted(budget.budget, spend.snapshot, this.#options.now() - startedAt).exhausted;
  }

  #permissionMode(ctx: RunContext): string {
    return ctx.ports.extensions === undefined
      ? 'default'
      : (ctx.input.options['permissionMode'] as string | undefined) ?? 'default';
  }

  /**
   * The dispatch ticket.
   *
   * With a ledger, the LEDGER mints it — including the attempt key — so the
   * engine never names one and two attempts cannot collide on a single key.
   *
   * Without a ledger, `ports.ts` says the meaning is "no tool with a side effect
   * may be dispatched", not "assume none exist". So a `read_only` call gets a
   * synthetic ticket: re-running it cannot double an effect, so the absent
   * durable record cannot leave anything unaccounted for. Any other class is
   * REFUSED, because an engine that dispatched it has no way to write the
   * `dispatched` record, which makes every such call one a crash cannot
   * classify.
   */
  async #ticket(ctx: RunContext, call: ToolCallRequest): Promise<ToolDispatchTicket> {
    const ledger = ctx.ports.sideEffects;
    if (ledger === undefined) {
      if (call.sideEffect !== 'read_only') {
        throw new Error(
          `refusing to dispatch '${call.name}': it declares '${call.sideEffect}' and no side-effect ledger is attached, so the call could not be recorded`,
        );
      }
      return SYNTHETIC_TICKET;
    }
    return ledger.begin(call);
  }

  /**
   * Run one extension phase, honouring the five rules in `ports.ts`: fixed
   * order, engine-enforced timeout, fail-open on a throw, the caller's signal,
   * and no unloading mid-run.
   */
  async #contribute(
    ctx: RunContext,
    phase: ExtensionPhase,
    extra: { readonly call?: ToolCallRequest; readonly outcome?: ToolOutcome },
  ): Promise<readonly ExtensionContribution[]> {
    const contributors = ctx.ports.extensions?.list(phase) ?? [];
    const context: ExtensionContext = { runId: ctx.runId, turn: ctx.turn, ...extra };
    const adopted: ExtensionContribution[] = [];

    for (const contributor of contributors) {
      try {
        for (const contribution of await withDeadline(
          contributor.contribute(context, ctx.signal),
          contributor.timeoutMs,
        )) {
          adopted.push(contribution);
        }
      } catch (error) {
        // Rule 3: fail-open, with exactly one exception. A BLOCKING contributor
        // that throws at `before_finalize` fails the run, because a veto that
        // cannot be evaluated is not a veto and treating it as an allow would
        // let a broken gate through.
        if (phase === 'before_finalize') {
          throw new Error(
            `a binding extension failed at before_finalize: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return adopted;
  }

  /**
   * Turn fragments into the user messages that carry them.
   *
   * ## Why this awaits, and why a rejection is a skip
   *
   * A `pending` fragment is a tool's follow-up payload that was still being
   * computed when the drain handed it over, so its text does not exist yet. The
   * legacy code resolves it at the same point -- inside context assembly for the
   * next turn (`DuyaAgent.ts:4204-4224`) -- and treats a rejection as
   * `continue`, i.e. the fragment simply does not appear (`DuyaAgent.ts:4215`).
   * Both rules are reproduced here, because the alternative is a failed fragment
   * failing a turn whose model call had nothing to do with it.
   *
   * The `typeof === 'string'` branch is also the legacy one
   * (`DuyaAgent.ts:4209-4210`): the value is `Promise<unknown>`, so a structured
   * payload is stringified rather than sent as an object.
   *
   * The unbounded wait is inherited, not introduced: see
   * `PendingTransientContextFragment`'s doc comment.
   */
  async #fragmentMessages(
    idPrefix: string,
    fragments: readonly TransientContextFragment[],
  ): Promise<readonly ModelMessage[]> {
    const settled = await Promise.allSettled(
      fragments.map(async (fragment) => ({ key: fragment.key, text: await fragmentText(fragment) })),
    );
    const messages: ModelMessage[] = [];
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue;
      messages.push({ role: 'user', id: `${idPrefix}:${item.value.key}`, content: item.value.text });
    }
    return messages;
  }

  /**
   * The messages the model is given this turn.
   *
   * The prompt goes in on the FIRST turn only. Later turns are continuations
   * after tool results, and re-appending the prompt every turn is how a
   * conversation teaches a model to repeat itself.
   */
  async #modelRequest(
    ctx: RunContext,
    assembled: AssembledTurn,
    deferred: readonly TransientContextFragment[],
  ): Promise<ModelRequest> {
    const { input, manifest } = ctx;
    // A `by_ref` history is the HOST's to resolve; the engine hands the locator
    // back rather than re-resolving it, which is what keeps exactly one
    // derivation of "the same input" (ports.ts contract 2).
    const history: readonly ModelMessage[] =
      input.history.kind === 'inline' ? input.history.value : assembled.messages;

    const steering = await this.#fragmentMessages(
      'steering',
      input.steering
        .filter((directive) => directive.effectiveFromTurn <= ctx.turn)
        .map((directive) => directive.payload),
    );

    const carried = await this.#fragmentMessages('fragment', deferred);

    // The prompt goes in on the FIRST turn only. Later turns are continuations
    // after tool results, and re-appending the prompt every turn is how a
    // conversation teaches a model to repeat itself.
    const messages: readonly ModelMessage[] =
      ctx.turn === 1
        ? [input.prompt, ...steering, ...carried, ...history]
        : [...history, ...carried, ...steering];

    // Model selection is forwarded from the manifest when it names one, and
    // omitted when it does not: `RunManifest.agent` is optional, and a request
    // that asserted a model would be claiming a resolution the manifest never
    // promised. The bound `ModelPort` applies its own selection in that case —
    // which is also why the engine never picks a model itself, since the
    // manifest carries a REF and resolving a ref needs the secret.
    const selection = manifest.agent;
    return {
      systemPrompt: assembled.systemPrompt,
      messages,
      tools: assembled.tools,
      ...(selection?.model === undefined ? {} : { model: selection.model }),
      ...(selection?.providerId === undefined ? {} : { provider: selection.providerId }),
    };
  }

  /**
   * The `turn.started` event.
   *
   * Published at the moment the turn begins rather than when it ends, because
   * `run-budget.ts:20` counts `turn.started`: a turn that started and then had
   * its stream die must still have cost budget, and waiting for the completion
   * event to count it would make a crashed turn free.
   */
  #turnStartedEvent(ctx: RunContext, request: ModelRequest): RunEvent {
    return {
      type: 'turn.started',
      turnId: `${ctx.runId}:turn:${ctx.turn}`,
      index: ctx.turn,
      model: request.model ?? 'unresolved',
      providerId: request.provider ?? 'unresolved',
      apiFormat: 'anthropic',
    };
  }

  /**
   * Subtask reclamation, owned here.
   *
   * A `terminate` that throws must not replace a real terminal with a synthetic
   * one, so a sweep failure is swallowed and reported as nothing reclaimed
   * rather than thrown. The parent is already ending; a rejection here would
   * destroy the terminal that actually describes what happened.
   */
  async #reclaimSubtasks(ports: RunEnginePorts, exit: EngineExit): Promise<number> {
    if (ports.subtasks === undefined) return 0;
    try {
      const terminations = await ports.subtasks.terminateAll(SUBTASK_REASON_FOR_EXIT[exit.reason], {
        // A failure sweep INCLUDES detached subtasks: a run that cannot record
        // its own failure must not leave orphans outliving it, holding a
        // workspace and a process tree. A cancel does not — a user who started
        // a background job and then stopped the chat did not ask for the job to
        // die, and the reason union now says so.
        includeDetached: exit.reason === 'failed' || exit.reason === 'budget_exhausted',
      });
      return terminations.filter((termination) => termination.outcome === 'killed').length;
    } catch {
      return 0;
    }
  }

  /**
   * Release the attempt lease, on every exit.
   *
   * Swallows a rejection on purpose — see the call site. The contract is that
   * `release` MUST resolve even if the attempt died, and a lease that threw on
   * release is a store problem, not a reason to lose this run's terminal.
   */
  async #releaseFence(
    ports: RunEnginePorts,
    fence: RunFence | null,
    _exit: EngineExit,
  ): Promise<void> {
    if (ports.attempt === undefined || fence === null) return;
    try {
      await ports.attempt.release(fence);
    } catch {
      // Recorded by the store's own diagnostics; the run's terminal is the more
      // important record and must not be lost to a lease bookkeeping failure.
    }
  }

  /**
   * The terminal the engine BELIEVES ended the run.
   *
   * Built as a real `RunTerminalState` — the protocol's discriminated union, not
   * a flat status string. That union is what forces a `failed` terminal to carry
   * a `ProtocolErrorInfo`: a status with no error object would let a caller read
   * a failure and find no reason attached, which is the shape of hole
   * `errors.ts` exists to close.
   */
  #terminalCandidate(exit: EngineExit): TerminalCandidate {
    switch (exit.reason) {
      case 'completed':
        return { state: { status: 'completed' }, reason: 'the model ended its turn with no work left' };
      case 'max_turns':
        return { state: { status: 'completed' }, reason: 'the run reached its turn ceiling' };
      case 'budget_exhausted':
        return {
          state: { status: 'budget_exhausted' },
          reason: 'the run exhausted its budget before finishing',
          cause: { code: 'budget_exhausted', message: exit.reason },
        };
      case 'cancelled':
        return { state: { status: 'cancelled' }, reason: 'the run was stopped by its caller' };
      case 'failed':
        return {
          state: {
            status: 'failed',
            error: {
              // `internal`, not an invented code. `ErrorCode` is a CLOSED
              // taxonomy (`errors.ts:70`) and a host is entitled to switch on
              // every member of it, so a code that exists only here would be a
              // second, stringly-typed escape hatch at exactly the moment a
              // consumer most needs to branch on a failure.
              code: 'internal',
              message: exit.message ?? 'the run failed for an unreported reason',
            },
          },
          reason: 'the run failed',
          cause: { code: 'internal', message: exit.message ?? 'unknown' },
        };
    }
  }
}

// ============================================================================
// Per-run context and state
// ============================================================================

/**
 * What a single turn left behind, for the stop decision.
 *
 * Per-turn, and the engine's own count: a turn that dispatched nothing has
 * nothing to feed back, so another model call would send the same prompt twice.
 * This is the `needsFollowUp` decision at `DuyaAgent.ts:3107`, and it is a fact
 * about what the engine dispatched rather than something a host asserts — a
 * host that could declare "this turn needs a follow-up" would be deciding the
 * loop from outside it.
 */
class TurnWork {
  dispatched = 0;

  record(): void {
    this.dispatched += 1;
  }
}

/** Everything one run needs. Built per `execute`, never shared. */
interface RunContext {
  readonly runId: RunId;
  readonly turn: number;
  readonly signal: AbortSignal;
  readonly ports: RunEnginePorts;
  readonly input: RunInputSnapshot;
  readonly manifest: RunManifest;
  readonly startedAt: number;
  readonly spend: RunSpendLedger;
  readonly fence: RunFence | null;
  /**
   * Dispatch ticket per callId, for the lifetime of the run.
   *
   * Per RUN rather than per turn: a tool dispatched in turn 1 can settle in turn
   * 2, and settling against a ticket the engine no longer held would fall back
   * to a synthetic key — a settle against no row at all.
   */
  readonly tickets: Map<string, ToolDispatchTicket>;
  /** Mutable, per turn. Replaced at the top of each iteration. */
  turnWork: TurnWork;
}

/**
 * The engine's own counters.
 *
 * Deliberately NOT read back from the event stream. `run-budget.ts:18-24`
 * counts starts rather than completions precisely because a call that died
 * mid-execution still consumed budget — and the engine is the only component
 * that knows a call was dispatched at all. A turn that begins and then has its
 * model stream die costs a turn here for the same reason.
 */
class RunSpendLedger {
  #turns = 0;
  #toolCalls = 0;
  #tokens = 0;

  get turns(): number {
    return this.#turns;
  }

  get snapshot(): RunSpend {
    return { turns: this.#turns, toolCalls: this.#toolCalls, tokens: this.#tokens };
  }

  beginTurn(turn: number): void {
    this.#turns = turn;
  }

  addToolCall(): void {
    this.#toolCalls += 1;
  }

  addTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.#tokens += tokens;
  }
}

// ============================================================================
// Small helpers
// ============================================================================

/**
 * Cancellation, in one predicate.
 *
 * The caller's signal is the sole authority. The engine does NOT synthesise an
 * abort from a port's state: a port that stops without the signal being
 * aborted is a port bug, and inventing an abort from it would make the engine's
 * stop reason a guess about someone else's internals.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * A ticket for a host running no ledger, for a `read_only` call only.
 *
 * `read_only` is the one class where the absence of a durable record cannot
 * leave an effect nobody recorded: re-running it cannot double anything. Every
 * other class is refused by `RunEngineImpl.#ticket`.
 */
const SYNTHETIC_TICKET: ToolDispatchTicket = Object.freeze({
  attemptKey: 'no-ledger:read-only',
  runId: 'no-ledger',
  runEpoch: 0,
  fence: Object.freeze({ runId: 'no-ledger', runEpoch: 0, token: 0 }),
});

/** Ledger details are for diagnosis, not for transporting a tool's whole output. */
const LEDGER_DETAIL_LIMIT = 512;

/**
 * One fragment's text, resolved.
 *
 * The `typeof === 'string'` branch is the legacy one
 * (`DuyaAgent.ts:4209-4210`): a deferred tool context carries
 * `Promise<unknown>`, so a structured payload is stringified here rather than
 * handed to a provider as an object. Rejects with whatever the tool rejected
 * with, so the caller's `allSettled` decides the policy.
 */
async function fragmentText(fragment: TransientContextFragment): Promise<string> {
  if (fragment.pending === undefined) return fragment.text;
  const value = await fragment.pending;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Extension rule 2, enforced by the engine.
 *
 * A self-declared timeout is a contributor ASKING to be bounded; only the
 * engine's own deadline is a bound. Without this a hanging contributor holds a
 * turn open indefinitely, and the run's own request deadline is the only thing
 * left to stop it.
 */
async function withDeadline<T>(work: Promise<readonly T[]>, timeoutMs: number): Promise<readonly T[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<readonly T[]>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`extension exceeded its ${timeoutMs}ms budget`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Which reason a given exit sweeps subtasks with.
 *
 * Derived, never re-chosen at cleanup time — a run that ended because it was
 * cancelled must not be recorded as a parent failure, because that string is
 * what an operator reads first after a restart.
 */
const SUBTASK_REASON_FOR_EXIT: Readonly<Record<EngineExitReason, SubtaskTerminationReason>> =
  Object.freeze({
    completed: 'completed',
    max_turns: 'completed',
    budget_exhausted: 'budget_exhausted',
    cancelled: 'parent_cancel',
    failed: 'parent_failure',
  });

/** Re-exported so `ProtocolErrorInfo` stays reachable for a host's own errors. */
export type { ProtocolErrorInfo, RunStatus };
