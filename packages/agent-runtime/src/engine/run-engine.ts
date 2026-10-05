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
  MessageContent as EventContent,
  ProtocolErrorInfo,
  RunEvent,
  RunFence,
  RunId,
  RunManifest,
  RunStatus,
  StopReason,
  TokenUsage,
} from '@duya/agent-protocol';
import { isBudgetExhausted, type RunSpend } from '@duya/agent-core';
import type { StopReceipt, StopRequest } from '../transport/execution-channel.js';
import type {
  ApprovalVerdict,
  AssistantContentBlock,
  AssistantMessageRecord,
  AssembledTurn,
  BudgetPort,
  ExtensionContext,
  ExtensionContribution,
  ExtensionPhase,
  ModelFrame,
  ModelMessage,
  ModelRequest,
  ModelStopReason,
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
import { openRequestScope } from './request-scope.js';

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
    /** Dispatched tool names, so a landing result can name the call behind it. */
    const toolNames = new Map<string, string>();
    /**
     * The run-scoped message id every assistant event of this run carries.
     *
     * RUN-scoped, and deliberately so: it is the identity
     * `buildTranscriptSnapshot` keys its block map and its finalized map by
     * (`replay/transcript-snapshot.ts:175-200`), and a per-turn id would leave
     * the blocks of a message the finalized event does not name, so the
     * supersession would never join. The inbound path mints one per run for the
     * same reason (`translate/chat-event-translator.ts:639-647`), and a
     * component that minted a new one per block would make every block look like
     * a separate message to anything that groups by id.
     *
     * DERIVED from the run id rather than random, so a replayed attempt produces
     * the same identity and two attempts at one run cannot be mistaken for two
     * messages -- the same reasoning as `turnId` at `#turnStartedEvent`.
     */
    const messageId = `${runId}:message`;
    /**
     * Which turn the run stopped on, for the one `assistant.message_finalized`
     * this run emits.
     *
     * A CELL rather than a field copied forward, and the lifetime is the point:
     * `RunContext` is rebuilt every iteration, so a per-turn field would forget
     * the previous turn the moment the next one started. Declared here, beside
     * `tickets` and `toolNames`, because that is where this module already keeps
     * the state that outlives one turn -- not on the engine, which is shared.
     */
    const lastMessage: RunScoped<{ current: TurnMessage | null }> = { current: null };
    /**
     * The next block index per KIND, for the whole run.
     *
     * Run-scoped for the same reason the message id is: the blocks of every turn
     * share ONE id, and a consumer keys them by (id, index)
     * (`replay/transcript-snapshot.ts:175-193`). A per-turn counter restarts at 0,
     * so turn 2's first text block would land on turn 1's index and OVERWRITE it
     * in that map -- which is the silent loss the shared id is supposed to make
     * impossible. A counter per kind, because the two are indexed independently.
     */
    const blockIndex: RunScoped<BlockIndex> = { text: 0, thinking: 0 };

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
          // The conditional spread, not a plain assignment, because this package
          // compiles with `exactOptionalPropertyTypes`: naming the field with an
          // `undefined` value is not the same as omitting it, and a request that
          // named no cap must omit it. Same idiom as the model selection below.
          ...(request.modelRequestTimeoutMs === undefined
            ? {}
            : { modelRequestTimeoutMs: request.modelRequestTimeoutMs }),
          ports,
          input,
          manifest,
          startedAt,
          spend,
          fence,
          tickets,
          toolNames,
          turnWork: new TurnWork(),
          messageId,
          lastMessage,
          blockIndex,
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
      // AHEAD of the terminal proposal, on the legacy frame's own reasoning: the
      // message stops changing strictly before the run ends
      // (`agent-process-entry.ts:3482-3488`). A run that failed before any
      // stream completed has no message, and `#finalizeLastMessage` returns
      // without publishing -- absence, not an empty finalized message.
      this.#finalizeLastMessage(ports, lastMessage);
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
   * Open the model stream and dispatch whatever it asks for, assembling the
   * turn's assistant message as the frames arrive.
   *
   * Returns a non-null exit when the turn ended for a reason the loop must not
   * second-guess: the caller's signal, or a fatal model frame. `null` means the
   * stream completed and the run continues to drain.
   *
   * ## The frames that "decide nothing" are still the answer
   *
   * `text`, `thinking` and `tool_use_delta` fell through this switch as
   * narration for a long time, and that was correct for DECISION purposes and
   * fatal for the transcript: they are the only place the model's actual answer
   * exists. The legacy loop accumulated all three into
   * `finalAssistantContent` and pushed it durable at the `done` boundary
   * (`DuyaAgent.ts:2645-2678`), so a turn loop migrated onto this engine
   * without the assembly below would keep every decision and lose every
   * message. The frames are still decision-free here; they are no longer
   * discarded.
   *
   * ## The deltas are published from INSIDE this loop, and the blocks are not
   *
   * `#publishBlocks` runs after the `for await`, so an engine that published its
   * text there alone made a turn's answer appear all at once when the stream
   * closed. The projector has arms for `assistant.text_delta`,
   * `assistant.thinking_delta` and `tool.arguments_delta`
   * (`project/legacy-sse-projector.ts:65-88`) and this engine emitted none of
   * them, so a projector could not be written against events that were never
   * published. The three `#publish*Delta` calls below sit in the frame switch for
   * that reason, and the block events are untouched: the consumer treats the
   * finalized entry as superseding the blocks for that message
   * (`replay/transcript-snapshot.ts:28-31`), which is only checkable if both
   * families carry one `messageId`. Delta plus block, not delta instead of block.
   *
   * ## The deltas are EPHEMERAL, and the choice of TYPE is the whole of it
   *
   * There is no durability flag to pass: `RunEventEmitter.#mint` reads it off
   * the registry by event type (`events/event-emitter.ts:553`), which marks
   * `assistant.text_delta` ephemeral and `assistant.text_block` durable
   * (`events/registry.ts:198-202`). Publishing the fragments as blocks would write
   * every delta of every answer into `run_events`, which is the storage blow-up
   * the ephemeral bucket exists to prevent -- the same reason the inbound
   * translator keeps its two arms apart
   * (`translate/chat-event-translator.ts:230-234`).
   *
   * ## A delta's index is the index of the block that supersedes it
   *
   * `DeltaCursor` starts at the same base `#publishBlocks` reads and advances on
   * the same boundary `TurnMessage.addText` opens a block on, so a consumer can
   * accumulate a fragment under `(messageId, index)` and then find the completed
   * block already sitting under that key. One divergence is deliberate and is not
   * a numbering bug: a text block that follows a tool call is stored with a
   * leading newline (`DuyaAgent.ts:2610-2620`) while the published fragment is the
   * raw frame, so a block's deltas concatenate to its text minus that separator.
   * The block is the authority; the deltas are for progressive display.
   *
   * ## Why the message is handed over HERE and not at the end of the turn
   *
   * The order is the legacy one and it is a provider requirement, not a taste:
   * the assistant message must reach the host BEFORE any tool result, because
   * OpenAI requires `assistant (tool_calls) -> tool (result)`
   * (`DuyaAgent.ts:2641-2642`). `#drainOutcomes` cannot run before this method
   * returns, so placing the hand-off at the end of the stream makes the ordering
   * structural -- there is no code path that reaches a tool result first.
   */
  async #streamModel(ctx: RunContext, request: ModelRequest): Promise<EngineExit | null> {
    const { ports, signal, spend } = ctx;

    // The per-request cap, opened here because THIS is the request, and released
    // in the `finally` below rather than at each exit.
    //
    // The split is the load-bearing part, so it is stated where a reader will
    // hit it first: `signal` remains the RUN signal for every `isAborted` check
    // in this method, and ONLY the port call receives the scope's signal. A
    // timeout then ends the request and nothing else, so the run keeps the
    // authority it needs to stop itself and to arm the next request. Reading
    // the scope's signal in the `isAborted` checks would report a slow request
    // as a cancelled run.
    const scope = openRequestScope(signal, ctx.modelRequestTimeoutMs);
    try {
      const message = new TurnMessage(ctx.messageId, ctx.turn);
      // Numbering for the fragments published from INSIDE this loop. Opened here
      // rather than lazily on the first text frame so a stream that opens with a
      // tool call numbers its later text block from the same base
      // `#publishBlocks` will read after the loop.
      const cursor = new DeltaCursor(ctx.blockIndex);
      let sawFrame = false;
      for await (const frame of ports.model.stream(request, scope.signal)) {
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
            message.addToolUse(frame.call);
            // AFTER `addToolUse`, because that is the frame that closes the text
            // run: the next `addText` cannot merge into a `tool_use` block, so
            // the next fragment must open a new index. Closing it on the
            // `tool_use_delta` frames instead would split the numbering in half
            // for every call whose arguments arrive as fragments, and the
            // completed block would land one index below the fragments that
            // belong to it.
            cursor.endText();
            await this.#dispatchCall(ctx, frame.call);
            break;
          case 'tool_use_started':
            // Announces a call, is not one. Legacy pushes the block on `tool_use`
            // (`DuyaAgent.ts:2576`), so a `tool_use_started` that never completed
            // must not put a block in the message.
            await this.#dispatchCall(ctx, frame.call);
            break;
          case 'text':
            // BEFORE `addText`, and inside the loop: a frame that arrives at t is
            // published at t, which is the entire point of the delta family.
            this.#publishTextDelta(ctx, cursor, frame.text);
            message.addText(frame.text);
            break;
          case 'thinking':
            this.#publishThinkingDelta(ctx, cursor, frame.text);
            message.addThinking(frame);
            break;
          case 'tool_use_delta':
            // Argument fragments, and the complete `tool_use` frame carries the
            // whole input. Legacy ignores them for the MESSAGE too (there is no
            // `tool_use_delta` arm in its `done` handler), so accumulating them
            // into the block would DOUBLE the arguments on every call. Publishing
            // them is the other half of that: the host can watch a call being
            // written, and the durable record still comes from the `tool_use`
            // frame alone.
            this.#publishArgumentDelta(ctx, frame);
            break;
          case 'usage':
            spend.addTokens(frame.totalTokens ?? frame.inputTokens + frame.outputTokens);
            message.addUsage(frame);
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
            message.stop(frame.reason);
            break;
        }
      }

      if (!sawFrame) {
        // A stream that produced no frames and no error is a transport that died
        // quietly. Treating that as a completed turn would let the stop decision
        // below return "completed" for a run that never spoke.
        return { reason: 'failed', message: 'the model stream produced no frames' };
      }

      // AFTER the `sawFrame` check and not before: a dead transport produced no
      // answer, and a message assembled from nothing is not one.
      this.#publishBlocks(ctx, message);
      await this.#handOffMessage(ctx, message, request);
      // Held for `#finalizeLastMessage`, which publishes the
      // `assistant.message_finalized` event. Set on every turn, so the run's
      // authoritative message is the one the loop actually stopped on rather than
      // whichever turn happened to be first.
      ctx.lastMessage.current = message;
      return null;
    } finally {
      // Both the completing path and the throwing one, which is the legacy's
      // shape (`try` at `DuyaAgent.ts:2268`, `finally` calling
      // `disposeRequestController` at `:3398-3403`). A `finally` rather than a
      // call at each `return` because there are five exits here and a sixth
      // would be the one that leaks: a pending timer holds the process open, and
      // the parent's `abort` listener keeps this request reachable for the life
      // of the run.
      scope.dispose();
    }
  }

  /**
   * One streamed text fragment, published where it arrives.
   *
   * The index is taken BEFORE the empty check, which looks like a wasted
   * iteration and is not: the index belongs to the BLOCK, and an empty frame
   * still opens one (`TurnMessage.addText` pushes it), so skipping the publish
   * must not skip the numbering or the two schemes drift apart.
   */
  #publishTextDelta(ctx: RunContext, cursor: DeltaCursor, text: string): void {
    const index = cursor.text();
    if (text === '') return;
    ctx.ports.events.publish({
      type: 'assistant.text_delta',
      messageId: ctx.messageId,
      index,
      delta: text,
    });
  }

  /**
   * One streamed reasoning fragment, published where it arrives.
   *
   * The index needs no bookkeeping: a message assembles AT MOST ONE thinking
   * block however many frames produced it (`TurnMessage.eachBlock`), so every
   * fragment of a turn shares the one index `#publishBlocks` will hand the
   * completed block.
   */
  #publishThinkingDelta(ctx: RunContext, cursor: DeltaCursor, text: string): void {
    if (text === '') return;
    ctx.ports.events.publish({
      type: 'assistant.thinking_delta',
      messageId: ctx.messageId,
      index: cursor.thinking(),
      delta: text,
    });
  }

  /**
   * One fragment of a tool call's arguments, published where it arrives.
   *
   * `toolCallId` and nothing else, because `ToolArgumentsDeltaPayload` holds
   * exactly those two fields (`events/payloads.ts:457-460`) -- a partial call
   * has no name and no parsed arguments yet, and inventing either would put a
   * value in the event that the provider never sent.
   */
  #publishArgumentDelta(
    ctx: RunContext,
    frame: Extract<ModelFrame, { readonly type: 'tool_use_delta' }>,
  ): void {
    if (frame.delta === '') return;
    ctx.ports.events.publish({
      type: 'tool.arguments_delta',
      toolCallId: frame.callId,
      delta: frame.delta,
    });
  }

  /**
   * The per-block durable events for this turn's message.
   *
   * ## Why the engine emits these at all
   *
   * Because `assistant.message_finalized` is DEFINED as superseding them
   * (`replay/transcript-snapshot.ts:28-31`), an event whose identity cannot be
   * checked against them is an identity claim with nothing to check it against.
   * The consumer keys both maps by `payload.messageId`, so the two families have
   * to carry the same one -- and the only way to know they do is for the same
   * component to emit both.
   *
   * The index is per KIND, and continuous across the run's turns, so a second
   * turn's text does not overwrite the first's under a shared run-scoped id.
   * The inbound path cannot do that -- it maps every block to `index: 0`
   * (`translate/chat-event-translator.ts:226`) because it only ever sees a
   * delta at a time -- so this is strictly more information, not a different
   * convention.
   */
  #publishBlocks(ctx: RunContext, message: TurnMessage): void {
    const { ports } = ctx;
    message.eachBlock((block) => {
      if (block.kind === 'text') {
        ports.events.publish({
          type: 'assistant.text_block',
          messageId: message.messageId,
          index: ctx.blockIndex.text,
          text: block.text,
        });
        ctx.blockIndex.text += 1;
        return;
      }
      ports.events.publish({
        type: 'assistant.thinking_block',
        messageId: message.messageId,
        index: ctx.blockIndex.thinking,
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        // `encrypted` is a BOOLEAN here: the event vocabulary cannot hold the
        // payload, only the fact that one exists
        // (`events/payloads.ts:118`). The payload itself reaches the host
        // through `recordAssistantMessage`, in the transcript vocabulary where
        // it is a string.
        ...(block.encrypted === undefined ? {} : { encrypted: true }),
      });
      ctx.blockIndex.thinking += 1;
    });
  }

  /**
   * Hand the assembled message to the host, and remember it for the run's
   * finalized event.
   *
   * Absent binding: the engine still emits the events (they go through the
   * REQUIRED `events` port) and only the host's durable row is skipped, which
   * is the same absence `TurnOutputPort` states for a tool result.
   */
  async #handOffMessage(ctx: RunContext, message: TurnMessage, request: ModelRequest): Promise<void> {
    const turnOutput = ctx.ports.turnOutput;
    if (turnOutput === undefined) return;
    const record = message.toRecord({
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.provider === undefined ? {} : { providerId: request.provider }),
    });
    await turnOutput.recordAssistantMessage(record);
  }

  /**
   * `assistant.message_finalized`, once per run, for the turn the loop stopped
   * on.
   *
   * ## Once per RUN, and not once per turn
   *
   * Two reasons, and the second is the binding one.
   *
   *  - It is the existing wire's shape. The worker's frame is built from
   *    `lastAssistant` and sent ONCE at the `chat:done` boundary
   *    (`agent-process-entry.ts:3489`), so a per-turn emission would be a second
   *    cadence for an event the product already emits once.
   *  - The consumer cannot represent more. `buildTranscriptSnapshot` keeps
   *    finalized messages in a map keyed by `messageId`
   *    (`replay/transcript-snapshot.ts:197`), and this run's `messageId` is
   *    run-scoped, so a second finalized event with the same id would REPLACE
   *    the first rather than sit beside it. Emitting per turn would silently
   *    drop every turn but the last from the rebuild.
   *
   * Nothing is lost to that: every turn's blocks went out as durable block
   * events above, and the host's own row is per turn via
   * `recordAssistantMessage`.
   *
   * ## A stop reason the event union cannot state is a refusal
   *
   * `stopReason` is REQUIRED (`events/required.ts:94`). `ModelStopReason` has a
   * member the protocol's six-value `StopReason` does not -- `tool_use` means
   * "the loop is going round again", and `completed` would claim a normal
   * finish that did not happen. So the event is not emitted, and a `diagnostic`
   * says which turn lost it: the same counted-diagnostic-instead-of-a-silence
   * rule the unmapped sub-agent progress frame follows. The turn's message is
   * NOT lost -- `recordAssistantMessage` already handed it to the host, and the
   * block events are durable.
   *
   * Published BEFORE `proposeTerminal` for the same reason the legacy frame is
   * sent ahead of `chat:done` (`agent-process-entry.ts:3482-3488`): the message
   * stops changing strictly before the run ends, so the ledger has to record
   * them in that order.
   */
  #finalizeLastMessage(ports: RunEnginePorts, lastMessage: RunScoped<{ current: TurnMessage | null }>): void {
    const message = lastMessage.current;
    if (message === null) return;
    if (!message.hasContent) return;
    const stopReason = message.eventStopReason;
    if (stopReason === null) {
      ports.events.publish({
        type: 'diagnostic',
        level: 'warn',
        message: `turn ${message.turn} ended with a stop reason the event union cannot state (${
          message.rawStopReason ?? 'none reported'
        }); no assistant.message_finalized for it`,
        data: { turn: message.turn, messageId: message.messageId, stopReason: message.rawStopReason ?? null },
      });
      return;
    }
    ports.events.publish({
      type: 'assistant.message_finalized',
      messageId: message.messageId,
      content: message.toEventContent(),
      stopReason,
      ...(message.usage === undefined ? {} : { usage: message.usage }),
    });
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
    // The name only, and only for a call that is actually on its way: the
    // landing result needs it to name the tool it belongs to
    // (`TurnOutputPort.recordToolResult`), and a denied or budget-refused call
    // has no result to name.
    ctx.toolNames.set(call.callId, call.name);
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
   *
   * ## The ORDER inside the `tool_result` arm, and why it is this one
   *
   * Four steps, and each one is placed against the rule that the DURABLE record
   * of an effect is written before the effect is visible anywhere:
   *
   * 1. `sideEffects.settle` -- the crash-accountability row (contract 4).
   * 2. `context.defer` + the local list -- the model's next input. Ahead of the
   *    host projection because it is the one effect the engine itself owns and
   *    a host that fails to store a result must not also cost the model its
   *    answer.
   * 3. `turnOutput.recordToolResult` -- the six host effects the legacy loop
   *    performed inline (`DuyaAgent.ts:2721-2823`). After the ledger, never
   *    before: a host appending to its transcript must not be able to record a
   *    result whose ledger row does not exist yet.
   * 4. `#contribute('after_tool')` -- extension contributions. Last, because the
   *    legacy analogue (`PostToolUse`, `:2866`) ran after every result in the
   *    turn was committed, not after the first one.
   */
  async #drainOutcomes(ctx: RunContext, deferred: TransientContextFragment[]): Promise<void> {
    const { ports, signal } = ctx;
    // RESULTS that landed, counted here and NOT read off `TurnWork`.
    //
    // The legacy gate is `toolResultMessageCount` (`DuyaAgent.ts:2722`), and a
    // dispatch is not an answer: two calls can come back with one. `finally`
    // rather than a tail statement, because the abort path returns from the
    // middle of the loop and the legacy ran its `toolResultMessageCount > 0`
    // work after that loop too (`:2858`).
    let results = 0;
    try {
      for await (const item of ports.tools.drain(signal) as AsyncIterable<ToolDrainItem>) {
        if (isAborted(signal)) {
          ports.tools.discard('abandoned');
          return;
        }
        switch (item.kind) {
          case 'tool_result': {
            // Counted at the TOP of the arm, where the legacy counted it
            // (`:2722`) -- before any of the effects, so a host effect that
            // throws does not retroactively un-count a result that landed.
            results += 1;
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
            const turnOutput = ports.turnOutput;
            if (turnOutput !== undefined) {
              await turnOutput.recordToolResult({
                turn: ctx.turn,
                // BY IDENTITY, so what the host is handed is exactly what the
                // model will see next turn -- see `ToolResultRecord`.
                outcome: item,
                // `''` when this run never dispatched the call, which is the
                // legacy fallback verbatim (`DuyaAgent.ts:2771`).
                toolName: ctx.toolNames.get(item.callId) ?? '',
              });
            }
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
            //
            // Deliberately NOT also routed through `turnOutput`: this frame
            // already has exactly one projection path, and a second one would be
            // two mechanisms for one symptom -- which is how a frame ends up
            // emitted twice instead of emitted once.
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
    } finally {
      const turnOutput = ports.turnOutput;
      if (turnOutput !== undefined) {
        await turnOutput.finishTurn({
          turn: ctx.turn,
          results,
          // Carried so the two numbers can be seen diverging at the call site;
          // see `TurnOutputSummary`.
          dispatched: ctx.turnWork.dispatched,
        });
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
  /**
   * The run's per-REQUEST cap, forwarded from `RunExecutionRequest`.
   *
   * Copied onto the context rather than re-read from the request because
   * `#streamModel` receives only the context, and a field re-read from two
   * places is a field that can disagree with itself. `undefined` means no cap,
   * and that is every run's state today.
   */
  readonly modelRequestTimeoutMs?: number;
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
  /**
   * Dispatched tool NAME per callId, for the lifetime of the run.
   *
   * Recorded for the same reason `tickets` is, and with the same lifetime: a
   * result can land in a later turn than the call that produced it, and a
   * lookup that had already forgotten would report "no tool name" for a call
   * this engine made.
   *
   * The NAME only, not the whole `ToolCallRequest`. A `Write` call's input is
   * the file's contents, so retaining whole calls for the length of a run would
   * hold every argument payload a session ever passed -- and nothing needs it:
   * the legacy hook payload sent `tool_input: {}` (`DuyaAgent.ts:2780`) and
   * asked only which tool failed (`:2771`).
   */
  readonly toolNames: Map<string, string>;
  /** Mutable, per turn. Replaced at the top of each iteration. */
  turnWork: TurnWork;
  /**
   * The run-scoped message id, derived in `#run` and shared by every assistant
   * event of the run so the finalized message joins the blocks it supersedes.
   */
  readonly messageId: string;
  /**
   * Which turn the run stopped on. A CELL, because it outlives the per-turn
   * `RunContext` it is reached through -- see its declaration in `#run`.
   */
  readonly lastMessage: RunScoped<{ current: TurnMessage | null }>;
  /**
   * The next block index per kind, for the whole run. A CELL, because the
   * `messageId` the indexes sit under is run-scoped too -- see its declaration
   * in `#run`.
   */
  readonly blockIndex: RunScoped<BlockIndex>;
}

/**
 * The next `assistant.*_block` index per kind.
 *
 * Separate counters because the consumer keys a block by
 * `(messageId, kind, index)` (`replay/transcript-snapshot.ts:256`), so a shared
 * counter would make a message's first text block and its first thinking block
 * collide.
 */
type BlockIndex = { text: number; thinking: number };

/**
 * Where this turn's STREAMED fragments are numbered.
 *
 * ## Why the engine needs a second numbering of the same blocks
 *
 * `ctx.blockIndex` is the run-scoped counter `#publishBlocks` consumes after the
 * stream, and a delta cannot wait that long: the whole point of publishing from
 * inside the loop is that the fragment reaches the host while the loop is still
 * open. So this opens on the same base and walks forward on the same boundary
 * `TurnMessage.addText` opens a body block on, which is what makes the two
 * numbering schemes agree index for index.
 *
 * ## It does not advance `ctx.blockIndex`
 *
 * One writer per counter. If this mutated the run-scoped cell, the completed
 * block would be published one index too high for every turn after the first,
 * and the supersession that `replay/transcript-snapshot.ts:28-31` describes would
 * quietly stop joining. `#publishBlocks` remains the only writer, and the
 * agreement is a property of the two starting at the same value, not of shared
 * state.
 */
class DeltaCursor {
  /** The index the next text block will be published under. */
  #nextText: number;
  /** The index of the text block currently streaming; `null` between blocks. */
  #openText: number | null = null;
  /** The one thinking index this turn's fragments share. */
  readonly #thinking: number;

  constructor(base: BlockIndex) {
    this.#nextText = base.text;
    this.#thinking = base.thinking;
  }

  /** The index a streamed text fragment belongs under, opening a block if needed. */
  text(): number {
    if (this.#openText === null) {
      this.#openText = this.#nextText;
      this.#nextText += 1;
    }
    return this.#openText;
  }

  /**
   * Close the open text block, so the next fragment opens a new one.
   *
   * Called on the `tool_use` frame, because `TurnMessage.addToolUse` pushes a
   * block and the next `addText` therefore cannot merge into the last body entry.
   * `tool_use_started` does NOT close it: that frame announces a call without
   * putting one in the message, so the merge rule it sees is unchanged.
   */
  endText(): void {
    this.#openText = null;
  }

  thinking(): number {
    return this.#thinking;
  }
}

/**
 * A value whose lifetime is one `#run` rather than one iteration of its loop.
 *
 * Named because "this object is shared and mutable" is exactly the property a
 * reader has to be told about: `tickets` and `toolNames` are per run for the
 * same reason, and the engine object itself is deliberately NOT one of these
 * (see this file's header, "No shared mutable state").
 */
type RunScoped<T> = T;

/**
 * One turn's assembled assistant message.
 *
 * ## The ORDER is the legacy order, and it is a provider requirement
 *
 * `DuyaAgent.ts:2645-2668` builds the content in this sequence and the sequence
 * is load-bearing at both ends:
 *
 *  1. **the redacted block first.** Anthropic's thinking-mode validation wants
 *     the encrypted payload to LEAD the assistant turn, and the block is
 *     `{ thinking: '', redacted: true, encrypted }` -- empty text, because the
 *     provider will not give the reasoning back.
 *  2. **then thinking, with its signature.** The signature is what lets
 *     `transformMessages` replay the block natively on the next request instead
 *     of downgrading it to text, so dropping it degrades EVERY later turn
 *     silently.
 *  3. **then text and `tool_use` in stream order**, with consecutive text
 *     merged and a newline prefix on a text block that follows a tool call
 *     (`:2606-2620`) so block-level markdown is not swallowed.
 *
 * ## The two vocabularies it is read in
 *
 * `toRecord` speaks the TRANSCRIPT one, because the host stores and replays
 * that row and replay needs the encrypted payload as a string. `toEventContent`
 * speaks the EVENT one, because `events/payloads.ts` cannot hold it. The
 * projection between them is the same narrowing the inbound translator performs
 * (`translate/chat-event-translator.ts:567`); it is duplicated rather than
 * shared because that function reads a loose wire frame's `Record<string,
 * unknown>` and this one reads blocks it built itself.
 */
class TurnMessage {
  readonly messageId: string;
  readonly turn: number;
  /** Stream-ordered text and `tool_use` blocks; thinking is held separately. */
  readonly #body: AssistantContentBlock[] = [];
  #thinking = '';
  #thinkingSignature: string | undefined;
  #redactedPayload: string | undefined;
  #usage: TokenUsage | undefined;
  #rawStopReason: ModelStopReason | undefined;

  constructor(messageId: string, turn: number) {
    this.messageId = messageId;
    this.turn = turn;
  }

  get hasContent(): boolean {
    return this.#body.length > 0 || this.#thinking !== '' || this.#redactedPayload !== undefined;
  }

  /** What the provider said, or `undefined` when it said nothing. */
  get rawStopReason(): ModelStopReason | undefined {
    return this.#rawStopReason;
  }

  /** The one the event union can state, or `null` when it cannot state this one. */
  get eventStopReason(): StopReason | null {
    return this.#rawStopReason === undefined ? null : STOP_REASON_TO_EVENT[this.#rawStopReason];
  }

  get usage(): TokenUsage | undefined {
    return this.#usage;
  }

  stop(reason: ModelStopReason): void {
    this.#rawStopReason = reason;
  }

  addText(text: string): void {
    // Merge into the previous block when it is also text, which is the legacy
    // rule (`DuyaAgent.ts:2606-2608`) and not a tidiness: one streamed answer
    // arrives as many frames, and a row per frame is markdown split down the
    // middle.
    const last = this.#body[this.#body.length - 1];
    if (last !== undefined && last.type === 'text') {
      this.#body[this.#body.length - 1] = { type: 'text', text: last.text + text };
      return;
    }
    // A text block after a tool call or a piece of thinking needs a leading
    // newline, or `...text\n### heading` spanning that boundary renders as one
    // inline paragraph (`:2610-2620`).
    const prefix = this.#body.length > 0 ? '\n' : '';
    this.#body.push({ type: 'text', text: prefix + text });
  }

  addToolUse(call: ToolCallRequest): void {
    this.#body.push({ type: 'tool_use', id: call.callId, name: call.name, input: { ...call.input } });
  }

  addThinking(frame: Extract<ModelFrame, { readonly type: 'thinking' }>): void {
    // The redacted payload is taken ONLY when it is a real payload, which is the
    // legacy condition verbatim (`DuyaAgent.ts:3094`): a `redacted: true` frame
    // with nothing encrypted behind it is a provider that redacted without
    // giving the blob back, and the block cannot be replayed without it.
    if (frame.redacted === true && typeof frame.encrypted === 'string' && frame.encrypted !== '') {
      this.#redactedPayload = frame.encrypted;
    }
    if (frame.text === '') return;
    this.#thinking += frame.text;
    if (frame.signature !== undefined) this.#thinkingSignature = frame.signature;
  }

  /**
   * The LAST usage frame of the turn wins, never the sum.
   *
   * A provider reports usage more than once per request (`message_start` and
   * `message_delta` both carry it), and the last report is the turn's total
   * while the earlier ones are prefixes of it. Summing them would inflate
   * `usage` by the prompt, and plan 546 makes `usage` the single-call anchor
   * every context estimator scans -- so an inflated anchor is a context window
   * that fills early. The legacy held the last report too (`roundResultUsage`).
   */
  addUsage(frame: Extract<ModelFrame, { readonly type: 'usage' }>): void {
    const inputTokens = frame.inputTokens;
    const outputTokens = frame.outputTokens;
    this.#usage = {
      inputTokens,
      outputTokens,
      totalTokens: frame.totalTokens ?? inputTokens + outputTokens,
    };
  }

  /** The message as the host is handed it. Transcript vocabulary throughout. */
  toRecord(extra: { readonly model?: string; readonly providerId?: string }): AssistantMessageRecord {
    return {
      turn: this.turn,
      messageId: this.messageId,
      content: this.#transcriptContent(),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      ...(extra.model === undefined ? {} : { model: extra.model }),
      ...(extra.providerId === undefined ? {} : { providerId: extra.providerId }),
    };
  }

  /**
   * The message in the EVENT vocabulary, in the assembled order.
   *
   * Redacted first, then thinking, then the body -- the same order
   * `#transcriptContent` uses, because the two must not disagree about which
   * block leads.
   */
  toEventContent(): readonly EventContent[] {
    return this.#transcriptContent().map(toEventBlock);
  }

  /**
   * Every block, for the per-block events.
   *
   * NO INDEX: the index is run-scoped rather than per-message, because the
   * message id is run-scoped too and a consumer keys a block by
   * `(messageId, kind, index)` (`replay/transcript-snapshot.ts:256`). Handing the
   * index out from here would make it a per-turn counter that restarts and
   * overwrites the previous turn's block, so `#publishBlocks` owns it.
   *
   * A redacted block is reported as a thinking block with empty text, because
   * that is what it is: a reasoning block whose text the provider withheld.
   * Thinking is reported ONCE however many frames produced it, so the durable
   * block is the assembled block rather than a frame.
   */
  eachBlock(visit: (block: TurnMessageBlock) => void): void {
    if (this.#redactedPayload !== undefined || this.#thinking !== '') {
      visit({
        kind: 'thinking',
        thinking: this.#thinking,
        ...(this.#thinkingSignature === undefined ? {} : { thinkingSignature: this.#thinkingSignature }),
        ...(this.#redactedPayload === undefined ? {} : { encrypted: this.#redactedPayload }),
      });
    }
    for (const block of this.#body) {
      if (block.type !== 'text') continue;
      visit({ kind: 'text', text: block.text });
    }
  }

  #transcriptContent(): AssistantContentBlock[] {
    const content: AssistantContentBlock[] = [];
    if (this.#redactedPayload !== undefined) {
      content.push({ type: 'thinking', thinking: '', redacted: true, encrypted: this.#redactedPayload });
    }
    if (this.#thinking !== '') {
      content.push({
        type: 'thinking',
        thinking: this.#thinking,
        ...(this.#thinkingSignature === undefined ? {} : { thinkingSignature: this.#thinkingSignature }),
      });
    }
    content.push(...this.#body);
    return content;
  }
}

/** One durable block, as `#publishBlocks` reads it back. */
type TurnMessageBlock =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'thinking';
      readonly thinking: string;
      readonly thinkingSignature?: string;
      readonly encrypted?: string;
    };

/**
 * The transcript block -> the event block.
 *
 * `null` is impossible by construction: `AssistantContentBlock` is the three
 * arms the event `MessageContent` also has, and a fourth (`tool_result`) can
 * only be produced by a drain rather than a model stream. The throw is here so
 * that claim fails loudly if the union ever widens -- a block the event
 * vocabulary cannot state has to be preserved under
 * `providerMeta.untranslatedBlocks` like the inbound path does, not dropped.
 */
function toEventBlock(block: AssistantContentBlock): EventContent {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        // A STRING here, a boolean in the event: the payload has no home in
        // `events/payloads.ts` and the flag is the whole of what it can hold
        // (`translate/chat-event-translator.ts:586-590`).
        ...(block.encrypted === undefined ? {} : { encrypted: true }),
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
}

/**
 * The engine's stop reason -> the event vocabulary's `StopReason`.
 *
 * ## `tool_use` is ABSENT, and that is the load-bearing row
 *
 * It means "the loop is going round again", and none of the six protocol values
 * says that: `completed` would claim a normal finish that did not happen and
 * `length` is specifically a token or context ceiling. Coercing it would put a
 * word in a durable record that means something else, so `tool_use` is absent
 * and `eventStopReason` returns `null` -- the caller refuses to publish rather
 * than inventing. This is the same refusal the inbound path makes
 * (`translate/chat-event-translator.ts:526-533`) and for the same reason.
 *
 * The table is duplicated rather than imported because that one is keyed on
 * arbitrary PRODUCER strings read off the wire, while this one is keyed on the
 * runtime's own closed `ModelStopReason` union. Merging them would mean
 * accepting an untrusted string to answer a question about a trusted one.
 */
const STOP_REASON_TO_EVENT: Readonly<Record<ModelStopReason, StopReason | null>> = Object.freeze({
  end_turn: 'end_turn',
  max_tokens: 'length',
  stop_sequence: 'stop_sequence',
  cancelled: 'aborted',
  error: 'error',
  tool_use: null,
});

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
