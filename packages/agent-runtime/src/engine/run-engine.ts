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
 * Compaction is NOT a fifth decision and is deliberately not in that table: it
 * never decides whether the run continues. It replaces an INPUT for the turn
 * that is already going to happen, which is why it hangs off `#compact` at the
 * three points the legacy cycle owns them (`:2155`, `:3018`/`:3022`, `:3330`/
 * `:3360`) rather than off the stop. See "Compaction" below.
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
 * ## Compaction: three call sites, and the one that is not a turn
 *
 * `CompactionPort` (`ports.ts`) was declared before anything called it, and
 * `compaction.ts` could produce a replacement that no loop consumed. The three
 * sites below are the legacy's three, at the same points in the spine, and the
 * differences between them are the legacy's rather than this file's:
 *
 * | site | trigger | a failure means | retries the turn |
 * | --- | --- | --- | --- |
 * | between assembly and the request | `auto` | the RUN fails | no |
 * | after the drain | `preflight_overflow` | nothing; the turn continues | no |
 * | on a failed model stream | `emergency` | nothing; the original error stands | YES |
 *
 * The third is the only one that is not a plain call, and the reason is in the
 * legacy: `turnCount--` then `continue` (`DuyaAgent.ts:3369-3370`) re-runs the
 * same turn against the compacted transcript, which is the entire point of an
 * emergency compaction -- the request that failed is retried once it can fit.
 * It is free with respect to the ceiling, because the turn INDEX is reused and
 * `RunSpendLedger.beginTurn` assigns rather than increments (`:1994-1996`), so
 * `spend.turns` does not move. That reuse is why `turn.started` can be
 * published twice with one `turnId`, and it is the legacy's behaviour rather
 * than a duplication bug.
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
  ToolCallOutcome,
} from '@duya/agent-protocol';
import { isBudgetExhausted, type RunSpend } from '@duya/agent-core';
import type { StopReceipt, StopRequest } from '../transport/execution-channel.js';
import type {
  ApprovalVerdict,
  AssistantContentBlock,
  AssistantMessageRecord,
  AssembledTurn,
  BudgetPort,
  EngineExit,
  EngineExitReason,
  ExtensionContext,
  ExtensionContribution,
  ExtensionPhase,
  InterTurnSweepResult,
  ModelFrame,
  ModelMessage,
  ModelRequest,
  ModelStopReason,
  RepeatedCallStopPolicy,
  RepeatedToolCallStreak,
  RunEngine,
  RunCommandOutcome,
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
import { runCompactionPass, type CompactionPassResult } from './compaction.js';

// ============================================================================
// Public shape
// ============================================================================

/**
 * Why the engine stopped, and what it reported about that.
 *
 * `EngineExitReason` / `EngineExit` now LIVE in `ports.ts`, because
 * `ExtensionContext.exit` has to name them for a contributor reading the
 * `after_finalize` phase -- and a port file that re-declared a second copy of
 * the exit union would let the two disagree. They are re-exported here, so
 * every existing import of `./engine/run-engine.js` (and `index.ts`) is
 * unchanged; the same move the file already makes for `ProtocolErrorInfo` at
 * the bottom.
 */
export type { EngineExit, EngineExitReason } from './ports.js';

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
/**
     * Fragments produced this turn that the NEXT turn's assembly will carry.
     *
     * A CELL rather than a local, for the same reason `injected` and `compacted`
     * are: S4b-3 adoption has to reach it from `#streamModel`, `#dispatchCall`
     * and `#shouldStop`, all of which sit one or two call frames below this
     * loop. A local threaded through five signatures is a second account waiting
     * to go stale -- the exact defect `RunScoped` exists to prevent, and the
     * reason this was ever a local is that nothing below the loop consumed it
     * before now.
     */
    const deferred: RunScoped<{ current: TransientContextFragment[] }> = { current: [] };
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
     *
     * ## `m-`, not `:`, and why the separator is not a stylistic choice
     *
     * This id is a COMPONENT of a merge key, not just a correlation label.
     * `coalesceKeyId` joins `runId`, `eventType` and the scope with `:` and
     * REFUSES any component that already contains one (`events/coalesce.ts:181`),
     * because a `messageId` holding the separator is indistinguishable from a
     * different id plus a different block index - the doc comment's `ma12`
     * collision. That refusal is load-bearing and is not relaxed here.
     *
     * So the separator is kept OUT of the id instead, which is also what the two
     * sibling hosts already mint for the same value:
     * `run-orchestrator.ts:924` and `headless-run-host.ts:474` both use
     * `` `m-${runId}` ``. This id was the lone outlier, and it is the reason a
     * run streaming a `text_delta` into a real `BoundedEventQueue` used to die
     * `failed` on its first delta with "a merge key cannot be built". One
     * spelling for one value is the point: three producers of the same
     * run-scoped identity that agree.
     *
     * (`turnId` above keeps its colons. It is not a key component, so it is out
     * of this constraint, and changing it would move an id that other things
     * already read for no gain.)
     */
    const messageId = `m-${runId}`;
    /**
     * How many times the finalize-boundary poll has kept this run open.
     *
     * A CELL rather than a `let` for the reason `lastMessage`, `blockIndex` and
     * `injected` are cells: `#shouldStop` is a method, and run-scoped state a
     * method writes is what `RunScoped` is for. The engine object must stay
     * stateless, and a `let` in `#run` would not be reachable from `#shouldStop`
     * at all.
     *
     * The bound is the legacy's own, `FINAL_POLL_MAX_ABSORBS = 3`
     * (`DuyaAgent.ts:1819`). It exists because an absorbing answer LOOPS BACK
     * for another turn, so a host that always has something queued would
     * otherwise hold the run open indefinitely -- each iteration costing a full
     * model call.
     */
    const finalPollAbsorbs: RunScoped<{ current: number }> = { current: 0 };
    /**
     * The consecutive-identical-tool-call streak, for the whole run.
     *
     * A CELL for the same reason `finalPollAbsorbs` above is one: `#dispatchCall`
     * writes it and `#shouldStop` reads it, neither of which is the method that
     * would otherwise hold a `let`, and the engine object must stay stateless.
     *
     * RUN-scoped and not per-turn, and that is load-bearing rather than tidiness:
     * the streak is consecutive ACROSS turns -- a model that asks for the same
     * call every turn never repeats it within one turn -- and `RunContext` is
     * rebuilt every iteration. A per-turn counter would reset to 1 on each
     * iteration and the invariant could never fire at any threshold above 1, which
     * is the legacy behaviour this replaces reading `shouldHardStop()` off one
     * tracker for the whole `streamChat` (`DuyaAgent.ts:2847`, `:4271`).
     */
    const repeatedCalls: RunScoped<RepeatedCallStreak> = new RepeatedCallStreak();
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
    /**
     * The transcript a compaction REPLACED, and null until one has.
     *
     * This is the cell that makes a compaction mean anything, and it is here
     * rather than in the port because `CompactionOutcome.replacement` is a
     * transcript the engine has to USE (`ports.ts`, "The transcript the NEXT
     * request must be built from. Never null."). `#modelRequest` prefers it over
     * both `input.history` and `assembled.messages`, which is the whole
     * mechanism: without this cell the five frames publish perfectly and the
     * provider is sent the original history on the next turn, which is the
     * exact failure `COMPACTION_REPLACEMENT_IS_REQUIRED` in `port-guards.ts`
     * exists to make visible.
     *
     * Pinned for the rest of the run once set, because compaction rewrites the
     * lineage rather than editing a turn: the next request is the replacement
     * plus whatever `deferred` carries, which is how the legacy's own
     * `messages = reProjected.messages` behaves (`DuyaAgent.ts:3041-3042`).
     */
    const compacted: RunScoped<{ current: readonly ModelMessage[] | null }> = { current: null };
    /**
     * The context generation, bumped by every compaction that replaced the
     * transcript.
     *
     * A local rather than a cell, because it is only ever read at two points and
     * both are inside this method's call tree: `#streamModel` needs the value
     * the request was BUILT at, and `#compact` is what advances it. Wrapping it
     * in a cell would make a counter nobody can reassign look like run-scoped
     * state that outlives a turn.
     *
     * Separate from `RunExecutionRequest`'s run epoch on purpose: that one is
     * attempt recovery, this one is how many times the conversation has been
     * rewritten. The legacy keeps the same distinction -- `getContextEpoch` is
     * the manager's generation counter, bumped by compaction at
     * `CompactionManager.ts:918-921` and read at `DuyaAgent.ts:2380` BEFORE the
     * stream so usage can be filed against the generation the request was built
     * in. Conflating the two would let a recovery attempt rewind a compaction
     * boundary, which is not what either counter means.
     *
     * A cell rather than a `let` for the reason `lastMessage` and `blockIndex`
     * are cells: `#compact` is a method, and run-scoped state a method writes
     * is what `RunScoped` is for. The engine object still holds no state.
     */
    const contextEpoch: RunScoped<{ current: number }> = { current: 0 };

    /**
     * Messages the host injected between turns, for the rest of the run.
     *
     * A cell rather than a per-turn local, and the reason is the same one
     * `compacted` gives: an injection is an edit to the TRANSCRIPT, not to one
     * request. The legacy pushes into the `messages` array that every later turn
     * is built from (`DuyaAgent.ts:3709`, `:3720`), so on turn 4 the model still
     * sees a turn-2 notification. Held per-turn it would be forgotten the moment
     * the next turn started, and the correction the user sent while the agent
     * was working would apply to exactly one request and then evaporate.
     *
     * APPENDED, never replaced: `#modelRequest` concatenates this after the
     * history, which is the same position the legacy's `messages.push` occupies.
     */
    const injected: RunScoped<{ current: readonly ModelMessage[] }> = { current: [] };

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

      // ── The control-command gate: once per RUN, before turn 1 ─────────────
      // BEFORE the `on_start` phase and before the loop, for two reasons that
      // point the same way. First, an `on_start` contributor cannot express
      // this: the only outcome a contribution carries is a binding veto, and
      // `#shouldStop` reads a veto as "keep the loop open" -- the opposite of a
      // command that has already answered the user. Second, this decides whether
      // there IS a turn, so it belongs outside the turn loop; a check inside
      // `before_turn` would be re-evaluated on turn 2 for a prompt consumed on
      // turn 1.
      //
      // A recognised command ends the run HERE, and `command !== null` then
      // short-circuits the `on_start` phase and the loop below to zero
      // iterations. That reproduces the legacy's position rather than inventing
      // a difference: it returns from `streamChat` before its turn loop AND
      // before the ConfigHooksRunner is built (`DuyaAgent.ts:2411-2438` against
      // `:2447`), so `UserPromptSubmit` / `SessionStart` never fire for a
      // control command there either.
      //
      // The `?.` is the honest absence -- no port means no command surface,
      // which is every host's state before this member existed -- and a `null`
      // from the port means "not a command", so the run reaches the model
      // exactly as before. That is what keeps an unregistered `/`-prefixed
      // prompt behaving as the legacy behaves.
      const command = ports.command === undefined
        ? null
        : await ports.command.resolve({ runId, prompt: input.prompt });
      if (command !== null) {
        await this.#answerCommand(ports, command, messageId, lastMessage);
        exit = { reason: 'completed' };
      }

      // ── The `on_start` phase: once per RUN, before turn 1 ────────────────
      // AFTER the fence, because a contributor that runs before its attempt is
      // leased has produced work that no epoch attributes -- the same reason
      // the fence is acquired at all (`ports.ts` contract 3).
      //
      // And BEFORE the loop rather than as a first-iteration `before_turn`,
      // because these are not the same phase and conflating them would make
      // "once per run" unrepresentable: a run that exhausts its budget at the
      // top of turn 1 never reaches a first iteration's body, and the legacy
      // fires `SessionStart` before it can do that too (`DuyaAgent.ts:2144`).
      //
      // `turn: 0` is the "no turn has begun" answer documented on
      // `ExtensionContext.turn`, not a bug in the call site.
      // A phase with NO contributors must not add a scheduling point, and that
      // is not an optimisation -- it is the difference between this change
      // being observable and not. `#run`'s FIRST `await` is a scheduling
      // point, and `handle.stop()` aborts synchronously from the caller's next
      // statement; so moving that first await from `before_turn` (inside the
      // turn loop, after its abort check) out here ahead of the loop means a
      // stop that arrives immediately is caught by the loop's `isAborted`
      // instead of reaching the provider. Measured, not assumed:
      // `run-engine-model-frames.test.ts` "a stop during the turn aborts the
      // PROVIDER" fails on exactly that and passes again once the await is
      // conditional.
      //
      // A host that configures no hooks therefore gets byte-for-byte the
      // scheduling it had before S4a, and a host that DOES configure hooks is
      // the one that asked for work before its first turn.
      //
      // `command === null` is the other half of the gate above: a run already
      // answered by the product never reaches a model, and the legacy never
      // dispatched `SessionStart` for one either.
      if (command === null && (ports.extensions?.list('on_start') ?? []).length > 0) {
        // Adopted: `deferred` is still empty here, so these ride turn 1's
        // request, and on turn 1 `#modelRequest` places `carried` before the
        // history -- a session-start context is context the model must have read
        // BEFORE the transcript, which is the legacy's position too
        // (`DuyaAgent.ts:2155` routes it through the first-turn context rail).
        // `repeatedCalls` is the run-scoped cell, not a fresh value: it is the
        // same object `#dispatchCall` records into and `#shouldStop` reads, and
        // `on_start` contributes before this run has dispatched anything, so its
        // `stats()` is the legacy's `undefined` -- an absent field, not a zero.
        this.#adopt(ports, await this.#contribute({ runId, turn: 0, signal, ports, repeatedCalls }, 'on_start', {}), deferred.current);
      }

      // ZERO iterations when the run was answered by a control command, which is
      // the whole point: `#modelRequest` and `ports.model.stream` live inside
      // this loop, so a handled command cannot reach a provider. Written as the
      // loop's CONDITION rather than an early `break` so the "no turn ran" fact
      // is the same one fact the budget-exhausted arm above already expresses by
      // `break`ing before `spend.beginTurn`.
      for (let turn = 1; command === null; turn++) {
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
          ...(request.repeatedCallStop === undefined
            ? {}
            : { repeatedCallStop: request.repeatedCallStop }),
          ports,
          input,
          manifest,
          startedAt,
          spend,
          fence,
          tickets,
          toolNames,
          deferred,
          turnWork: new TurnWork(),
          messageId,
          lastMessage,
          blockIndex,
          compacted,
          contextEpoch,
          injected,
          finalPollAbsorbs,
          repeatedCalls,
        };

        if (isAborted(signal)) {
          ports.tools.discard('abandoned');
          exit = { reason: 'cancelled' };
          break;
        }

        // Adopted into THIS turn's request: the phase fires before
        // `#modelRequest` below, so the fragments it defers are read by the very
        // call the phase is named for.
        this.#adopt(ctx.ports, await this.#contribute(ctx, 'before_turn', {}), ctx.deferred.current);

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

        // ── Compaction site 1 of 3: the proactive pass, before the request ──
        // HERE and not at the top of the turn, which is where the legacy pumps it
        // (`DuyaAgent.ts:2155`). Two reasons, and the first is the load-bearing
        // one: `assemble` is the only point in the spine where the engine HOLDS
        // a real transcript, and `CompactionDecisionInput.transcript` is
        // "the messages travel, and the port measures them"
        // (`ports.ts`, "Why the request carries the transcript rather than a
        // token count"). At the top of the turn the engine has `input.history`,
        // which is a `ResolvedPart` and a `by_ref` one is the HOST's to resolve
        // (`:1401-1405`) -- so a probe asked up there would measure nothing and
        // decline for the wrong reason.
        //
        // The second is the legacy's own order: it pumps at `:2155` and builds
        // the request at `:2338`, so the replacement feeds the request that
        // follows. Same sequence, expressed the only way an injected assembly
        // allows.
        const proactive = await this.#compact(ctx, {
          trigger: 'auto',
          transcript: this.#transcriptFor(ctx, assembled),
        });
        // A proactive compaction that FAILS takes the run down, and that is the
        // legacy's asymmetry rather than a choice: the pump at `:2181` throws
        // outside the stream's own try (which opens at `:2268`), so a pre-turn
        // compaction error propagates out of the cycle, while the preflight
        // (`:3044`) and emergency (`:3372`) ones are caught and swallowed. The
        // three sites keep that split, because a run that silently kept the
        // transcript it could not shrink is the failure mode `ports.ts` states
        // at length: the context grows until the provider rejects it.
        if (proactive.kind === 'failed') {
          exit = { reason: 'failed', message: proactive.message };
          break;
        }

        // ── Inter-turn injection site 1 of 3: before the model call ──────────
        // HERE and not at the top of the turn, because that is where the legacy
        // puts it: the sweep runs after the proactive pass has settled the
        // transcript (`DuyaAgent.ts:2155`) and after it has re-projected
        // (`:2191-2192`), and before the request is built (`:2338`). A sweep at
        // the loop head would inject into a transcript the compaction pass was
        // about to replace, and the injected text would be dropped along with
        // the messages it was appended to.
        const inbound = await ports.interTurn.sweep({
          runId,
          checkpoint: 'before_model_turn',
        });
        this.#absorbInjection(ctx, inbound);
        // `soft_stop` ends the run with the host's own text. The legacy pushes
        // it durable, yields it as `text`, and returns `completed` (`:2217-2231`),
        // so the user sees an answer rather than a run that stopped unexplained.
        if (inbound.decision.action === 'soft_stop') {
          await this.#softStop(ctx, inbound.decision.summary);
          exit = { reason: 'completed' };
          break;
        }
        // `hard_replace` is NOT a stop and NOT a special case here: the
        // replacement arrived in `inbound.injected` and `#absorbInjection` has
        // already put it in the transcript this request is about to be built
        // from. Falling through is the whole behaviour, which is what the legacy
        // means at `:2232-2234` ("fall through to the LLM call with it in the
        // message history").

        const modelRequest = await this.#modelRequest(ctx, assembled);
        // Consumed: the fragments belong to the request that just carried them
        // and must not ride the next one. Left in place they would accumulate
        // turn after turn, so turn 5 would resend turns 1-4's results and the
        // context would grow with copies of answers the model already has.
        ctx.deferred.current.length = 0;
        // Adopted, and it lands on the NEXT turn's request -- NOT this one. The
        // phase fires after `#modelRequest` has already been built and after
        // `deferred.length = 0` consumed the list, so nothing it defers can reach
        // the call it is named for. That is the engine's existing ordering
        // rather than a choice made here, and it is the legacy's behaviour too:
        // `PreFinalize` injects reach the model on the following turn because
        // the turn it vetoes is over.
        this.#adopt(ctx.ports, await this.#contribute(ctx, 'before_model', {}), ctx.deferred.current);

        ports.events.publish(this.#turnStartedEvent(ctx, modelRequest));

        // Read AFTER the proactive pass and BEFORE the stream opens, which is
        // the legacy's ordering at `DuyaAgent.ts:2380` and the whole reason the
        // value is an argument rather than a lookup: the request is filed
        // against the generation it was BUILT in, and a compaction that opens
        // during the stream must not inherit the anchor of the request that
        // happened to still be running.
        const requestEpoch = ctx.contextEpoch.current;

        const outcome = await this.#streamModel(ctx, modelRequest, requestEpoch);
        if (outcome !== null) {
          // ── Compaction site 3 of 3: the emergency pass, and the only RETRY ──
          // Gated on `failed` and not merely on "the turn ended badly", which is
          // the one thing here that is NOT a transliteration. A `cancelled` exit
          // arrives here too -- a stop mid-stream, or a `turn_stopped` that says
          // cancelled -- and compacting on it would start a summarizer that takes
          // MINUTES (`ports.ts`, "The summarizer takes MINUTES") on a run the
          // user just asked to stop, with nothing to show for it. The legacy does
          // not have this hazard because its emergency path lives in a `catch`
          // (`DuyaAgent.ts:3306`) and an abort is not a throw; an injected
          // `signal` reaches the exit as a value, so the gate has to be explicit.
          //
          // A stop is not a provider error, and saying so is all this gate does.
          // Whether the error is a CONTEXT-LENGTH one is the port's call, on the
          // text this hands it.
          if (outcome.reason !== 'failed') {
            exit = outcome;
            break;
          }

          // The one site that is not a plain call, because the legacy retries
          // the turn: `turnCount--` then `continue` (`DuyaAgent.ts:3369-3370`)
          // re-runs the SAME turn against the compacted transcript. That is the
          // entire point of an emergency compaction -- the request that just
          // failed is the one that gets another chance, and retrying the NEXT
          // turn instead would resend the same oversized request once more
          // before shrinking.
          //
          // The reuse is free against the ceiling, and deliberately so:
          // `beginTurn` assigns rather than increments, so `spend.turns` does
          // not move and `#shouldStop`'s `>= maxTurns` test is unchanged. It
          // does mean `turn.started` is published twice under one `turnId`,
          // which is what the legacy does too (it yields `turn_start` at
          // `:2136` on the re-entry).
          const emergency = await this.#compact(ctx, {
            trigger: 'emergency',
            // Composed rather than taken from `assembled`: the results this turn
            // drained are in `deferred` and are exactly the payload that
            // overflowed, so a probe that could not see them would decline
            // against a transcript the provider had already rejected.
            transcript: this.#transcriptFor(ctx, assembled, ctx.deferred.current),
            // The provider's own words, forwarded verbatim. The engine does not
            // classify them: the dual-evidence gate is a property of how each
            // provider phrases the error and those providers are the host's
            // (`ports.ts`, `CompactionObservation.providerError`).
            ...(outcome.message === undefined ? {} : { providerError: outcome.message }),
          });
          if (emergency.kind === 'replaced') {
            // Only a REPLACEMENT earns the retry. A decline, a failure and a
            // cancel all leave the transcript as it was, and re-running an
            // unchanged request would burn a turn to fail identically -- the
            // legacy's `if (compactEntry)` at `:3361` is the same test.
            //
            // `model_retry`, and not a new reason: this IS a model-stream retry
            // -- the same turn is about to be re-issued -- and `ToolDiscardReason`
            // is a closed union whose `model_retry` member is documented as
            // exactly this case (`ports.ts`: "The engine calls this on a
            // model-stream retry"). Widening it for a synonym would make a
            // consumer switch on a value it had no reason to expect.
            //
            // Redundant on the `error` frame path, where `#streamModel` already
            // discarded, and kept anyway because the other `failed` exit does not:
            // a stream that produced no frames returns at `:720-725` without ever
            // reaching the error arm. The port's own reason for the call is the
            // one that does not depend on which exit fired -- "a replayed model
            // call would double-dispatch calls the first attempt already sent" --
            // and it is a ONE-WAY latch, so closing it late is closing it never
            // (`StreamingToolExecutor.ts:479`, never cleared at `:729-732`). That
            // is also why the pipeline lifetime stays per-turn.
            ports.tools.discard('model_retry');
            turn -= 1;
            continue;
          }
          // Everything else falls through to the original failure, which is the
          // legacy's asymmetry again: `:3372` catches a compaction error and
          // still runs `finalizeStreamError` on the ORIGINAL error (`:3396`).
          exit = outcome;
          break;
        }

        // ── Decisions 2 and 3: dispatch, then feed the results back ─────────
        // Draining is what makes the NEXT turn's request carry the tool
        // results, so these are two decisions at one point in the spine.
        const turnWork = ctx.turnWork;
        await this.#drainOutcomes(ctx);

        // ── Compaction site 2 of 3: the preflight overflow check ────────────
        // After the drain and BEFORE the stop decision, which is the legacy's
        // position (`:3009` sits inside the `done` handler, ahead of
        // `if (!needsFollowUp)` at `:3107`). The reason to be here rather than
        // at the top of the next turn is in the legacy's own comment: a single
        // tool call can blow past the 78% threshold by itself, and waiting for
        // the next turn's check "risks a `context_length_exceeded` round-trip"
        // (`:3001-3008`). Compacting here is cheaper than retrying the turn.
        //
        // Gated on the drain having produced something, exactly as `:3009`
        // gates on `toolResultMessageCount > 0` -- with nothing new the
        // transcript is the one the proactive pass already measured this turn,
        // and asking again would re-run the same decision against the same
        // input.
        if (turnWork.drained > 0) {
          // Best-effort by construction: a failure here is swallowed rather
          // than raised, matching `:3044-3056`, and the turn proceeds on the
          // transcript it already has. The `await` is inside the call so the
          // compaction cannot be left unawaited, and the RESULT is dropped on
          // purpose -- that asymmetry is the point of the table in the header.
          await this.#compact(ctx, {
            trigger: 'preflight_overflow',
            transcript: this.#transcriptFor(ctx, assembled, ctx.deferred.current),
          });
        }

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
      // ── The `after_finalize` phase: once per RUN, at the end ─────────────
      // In the `finally`, so a FAILED and a CANCELLED run reach it too. The
      // legacy's `SessionEnd` fires on the same three paths
      // (`SessionFinalizer.ts:248`, `:274`, plus `Stop` at `:268`), and a hook
      // that only sees successful runs is a hook that never sees the run a user
      // actually needs to know about.
      //
      // AFTER `#finalizeLastMessage` and not before: the message stops changing
      // strictly before the run ends, so a contributor that reads the finalized
      // message here is reading the same bytes every consumer will.
      //
      // CANNOT THROW, deliberately. Rule 3's one exception is scoped to
      // `before_finalize`, so a throwing contributor at this phase is swallowed
      // by `#contribute` -- which is what makes it safe to await inside a
      // `finally` without a try, where a throw would replace the real exit with
      // the exit of a bookkeeping failure.
      //
      // `spend.turns` is the last turn that BEGAN (`RunSpendLedger.beginTurn`
      // assigns rather than increments), and is `0` when the run stopped at the
      // budget check above turn 1. That is the honest value and the same one
      // the run's own spend report carries.
      //
      // `exit` is handed over, and it is the reason this phase exists: the
      // legacy fires `SessionEnd` on the success and abort paths and fires
      // NOTHING on the stream-error path (`SessionFinalizer.ts:248`, `:274`,
      // `:310-350`), which no phase-only signal can reproduce.
      // Same rule as `on_start` above, for the same measured reason: a run with
      // no hook source must not gain a scheduling point in its `finally`.
      if ((ports.extensions?.list('after_finalize') ?? []).length > 0) {
        // NOT ADOPTED, and this is the one phase of seven whose contributions
        // cannot reach the model. It runs here -- after the turn loop has broken
        // and after `assistant.message_finalized` -- so there is no later
        // `#modelRequest` to carry them. Deferring anyway would write to the
        // host and to `deferred` for a list nothing will ever read, which is a
        // side effect claiming delivery that did not happen.
        //
        // It is the legacy's position too: `Stop` and `SessionEnd` contexts are
        // dispatched after the final answer is committed (`SessionFinalizer.ts:226`,
        // `:248`), so a hook that wanted the model to see them had to say so
        // through the transcript, not through `additionalContext`.
        //
        // The phase is still worth running: a `SessionEnd` hook's real work is
        // its side effects (cleanup, notifications, the `hook_invoked` event the
        // runner emits), and those still happen.
        // `repeatedCalls` again, and this phase is where it is most informative:
        // a run that ended as `repeated_tool_calls` reached this contributor
        // having just been stopped by the very count it is being handed, so the
        // two cannot be different numbers.
        await this.#contribute({ runId, turn: spend.turns, signal, ports, repeatedCalls }, 'after_finalize', { exit });
      }
      // The engine PROPOSES and does not publish `run.completed` / `run.failed`.
      //
      // ## The ordering hazard that used to block this is GONE
      //
      // This site previously said publishing here was "WRONG today" because
      // `RunSession.#settleOnce` closed dangling tools FIRST and stated the
      // invariant "`observe` throws only if a terminal event already exists" --
      // true only because the engine published no terminal. Publish here and a
      // run with an unanswered tool call wrote its synthesised
      // `tool.call_completed` AFTER the run's own terminal, the ledger refused
      // it as `event_after_terminal`, the throw escaped `settle`, and the held
      // terminal was never released.
      //
      // That is fixed, and not by this file. `RunSession.observe` now closes
      // dangling tools the moment it is about to mint a terminal
      // (`run-session.ts:478-480`), so the close lands BELOW the terminal in
      // the ledger and `settle` runs to the barrier instead of throwing out of
      // it. Measured by `engine-publication.test.ts` and
      // `terminal-ordering.test.ts`, which now drive the terminal-FIRST
      // ordering and assert it completes.
      //
      // ## The reason this site still does not publish is OWNERSHIP
      //
      // The deadlock was never the real constraint. Contract 1e makes
      // `proposeTerminal` report a CANDIDATE and names `RunSession.settle` the
      // single writer of the terminal (`ports.ts:50-52,914-937`), and
      // `port-guards.ts:447-451` makes a settle-capable port surface a BUILD
      // FAILURE so this cannot quietly change. The engine already computes the
      // terminal state it would publish (`#terminalCandidate`), so nothing here
      // is missing to implement it -- moving the publication is a contract
      // change, and contracts are the cutover's to make, not this loop's.
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
  async #streamModel(ctx: RunContext, request: ModelRequest, epoch: number): Promise<EngineExit | null> {
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
            //
            // The announcement is still a real producer fact and the protocol has
            // a durable home for it: `ToolCallPreviewPayload` is the "something
            // is coming" case -- a tool named, arguments still streaming,
            // `provisional: true` always (`events/payloads.ts:408-418`). That is
            // EXACTLY this frame, and it was the one step of the model's tool-call
            // lifecycle the engine dropped: the stream is
            // `tool_use_started` -> `tool_use_delta`* -> `tool_use`, and only the
            // last two were ever published, so a host watching a call being
            // written saw raw argument fragments with no event saying a call was
            // coming.
            //
            // Published BEFORE `#dispatchCall`, so the "coming" signal strictly
            // precedes the authoritative `tool.call_started` intent record the
            // dispatch writes. One preview per announcement: a provider that
            // sends only the complete `tool_use` produces none, which is the
            // honest count -- there was no provisional window to see.
            ctx.ports.events.publish({
              type: 'tool.call_preview',
              toolCallId: frame.call.callId,
              toolName: frame.call.name,
              // The announcement's own best-effort input, verbatim. This is a
              // partial view of a call still being generated; the authoritative
              // arguments arrive on the later `tool_use` frame.
              arguments: frame.call.input,
              provisional: true,
            });
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
            // The compaction anchor, from the provider's own numbers. Fed HERE,
            // on the frame, rather than accumulated and reported once at the end
            // of the stream: the legacy feeds it per `result` event
            // (`DuyaAgent.ts:3166-3172`) and the round-max defence belongs to the
            // port, which is the only side that knows about epochs
            // (`CompactionManager.ts:502`). A guard, not a call the engine may
            // skip when it feels like it -- `spend` above is the same kind of
            // fact and is never optional.
            this.#anchorUsage(ctx, epoch, frame.inputTokens, frame.outputTokens);
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
    this.#publishBlocksFor(ctx.ports, ctx.blockIndex, message);
  }

  /**
   * `#publishBlocks`, narrowed to the two things it reads off the context.
   *
   * A context-shaped parameter would force the command path to fabricate a
   * `RunContext` -- a dozen fields it does not have and would have to invent --
   * which is the "second authority" shape `ports.ts` refuses elsewhere: a
   * literal that can disagree with the real one. `ports` and the block index
   * are the whole dependency, so they are the parameters, and the per-turn
   * caller passes `ctx.ports` / `ctx.blockIndex` unchanged. There is ONE
   * implementation of this publication; the command path and the model path
   * differ only in where their block counter starts, which is why a control
   * command's answer cannot drift from a model's answer on the wire.
   */
  #publishBlocksFor(
    ports: RunEnginePorts,
    blockIndex: { text: number; thinking: number },
    message: TurnMessage,
  ): void {
    message.eachBlock((block) => {
      if (block.kind === 'text') {
        ports.events.publish({
          type: 'assistant.text_block',
          messageId: message.messageId,
          index: blockIndex.text,
          text: block.text,
        });
        blockIndex.text += 1;
        return;
      }
      ports.events.publish({
        type: 'assistant.thinking_block',
        messageId: message.messageId,
        index: blockIndex.thinking,
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        // `encrypted` is a BOOLEAN here: the event vocabulary cannot hold the
        // payload, only the fact that one exists (`events/payloads.ts:118`).
        // The payload itself reaches the host through `recordAssistantMessage`,
        // in the transcript vocabulary where it is a string.
        ...(block.encrypted === undefined ? {} : { encrypted: true }),
      });
      blockIndex.thinking += 1;
    });
  }

  /** `#handOffMessage`, narrowed the same way: no request, no context. */
  async #handOffMessageFor(ports: RunEnginePorts, message: TurnMessage): Promise<void> {
    const turnOutput = ports.turnOutput;
    if (turnOutput === undefined) return;
    // No `model` / `providerId`: no model ran, and attributing this message to
    // one would record a resolution the run never performed.
    await turnOutput.recordAssistantMessage(message.toRecord({}));
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
   * Publish a control command's reply as this run's assistant message.
   *
   * ## Why the command's text goes through the SAME steps a model's does
   *
   * Because a consumer cannot tell them apart, and that is the point. The
   * engine's contract is that a run which answered produces an assistant
   * message: `assistant.text_block`, then once per run
   * `assistant.message_finalized`, plus the durable row through
   * `TurnOutputPort`. A command answer published by some other route -- a
   * bespoke event, a host-side stream push -- would leave every transcript
   * rebuilt from `assistant.message_finalized` with a hole exactly where the
   * user typed a command, which is the silent class of regression this plan
   * exists to prevent.
   *
   * So this REUSES `TurnMessage` and the run's own `messageId` rather than
   * minting an identity, and reuses `#publishBlocksFor` / `#handOffMessageFor`
   * -- the same two calls `#streamModel` makes. One publication path, two
   * producers, and they cannot drift.
   *
   * ## Why the stop reason is `end_turn`, and why that is honest
   *
   * `TurnMessage.eventStopReason` reads `null` for an unset reason and the
   * finalize step then publishes a `diagnostic` and NO finalized message. So a
   * command message needs a reason, and `end_turn` is the truthful one: the
   * answer is complete and nothing further is coming. It is also what the
   * legacy's `{ type: 'done', reason: 'completed' }` becomes on this wire --
   * `completed` is the run's exit, `end_turn` is the message's stop, and the
   * two are different vocabularies for different facts.
   *
   * ## `turn` is 1, not 0
   *
   * `TurnMessage.turn` reaches the host through
   * `TurnOutputPort.recordAssistantMessage`, and 1 is the honest value: this run
   * DID produce an answer, it simply did not ask a model for one. Zero is
   * reserved for "no turn began" and is what `spend.turns` reports, which is
   * the accounting, not the message.
   */
  async #answerCommand(
    ports: RunEnginePorts,
    outcome: RunCommandOutcome,
    messageId: string,
    lastMessage: RunScoped<{ current: TurnMessage | null }>,
  ): Promise<void> {
    const message = new TurnMessage(messageId, 1);
    message.addText(outcome.reply);
    message.stop('end_turn');
    // A fresh zero counter rather than the run's own `blockIndex`: a run that
    // never entered the loop has published nothing, so its counter is already
    // zero, and `#publishBlocksFor` increments what it is handed.
    this.#publishBlocksFor(ports, { text: 0, thinking: 0 }, message);
    await this.#handOffMessageFor(ports, message);
    // THE run's own `lastMessage` cell, handed in rather than re-minted: the
    // `finally`'s `#finalizeLastMessage` reads that exact object, so this is
    // what makes it publish `assistant.message_finalized` for the command's
    // answer. Without it the run proposes a terminal having published no
    // finalized message at all, and a consumer rebuilding the transcript
    // silently loses what the user typed. A cell stored on the ENGINE instead
    // would be shared state across concurrent runs, which this file's header
    // forbids outright.
    lastMessage.current = message;
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
    // ONCE PER TURN, and AHEAD of the stop-reason branch below, so a turn whose
    // stop reason the union cannot state still reports what it spent.
    //
    // Per FRAME would be the obvious mistake and it is wrong twice over:
    // `addUsage` is last-wins-never-summed (`run-engine.ts` `addUsage`), so the
    // value here is the run's final total, and a per-frame publication would
    // emit every PREFIX of it and then double count the sum on the host that
    // adds them up. The withholding question is separate and is NOT answered
    // here: `assistant.usage` is gated on the `usage_accounting` capability
    // (`registry.ts:203`), `RunExecutionRequest` carries no capability set, and
    // the emit path consults no gate (`structural-dispatch.ts:262` checks
    // METHODS, not events). Deciding that is the caller's job, and this engine
    // cannot make the decision in either direction.
    if (message.usage !== undefined) {
      ports.events.publish({ type: 'assistant.usage', usage: message.usage });
    }
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
    // Adopted onto the run's rail, so it reaches the NEXT model request. The one
    // in flight was built before this phase, which is the legacy's position:
    // `PreToolUse` injects go onto the working `messages` array
    // (`DuyaAgent.ts:3375`) and the next request is built from it.
    this.#adopt(ctx.ports, await this.#contribute(ctx, 'before_tool', { call }), ctx.deferred.current);
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
    // The anti-dead-loop streak, recorded at the SAME point and for the same
    // reason: a call that was refused never happened, and counting it would let
    // a model be hard-stopped for calls it never made. `#shouldStop` reads this
    // at the end of the turn.
    ctx.repeatedCalls.record(call.name, call.input);
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
  async #drainOutcomes(ctx: RunContext): Promise<void> {
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
                // The LEDGER's question is binary -- did this attempt fail? -- and
                // that is why the widened `isError` is resolved HERE, by the one
                // consumer that needs two values, rather than narrowed in the
                // adapter. `=== true` rather than truthiness: a call whose
                // producer said nothing is not evidence of a failure, and the
                // ledger's `succeeded` is a claim about the EFFECT landing, not
                // about the tool having reported a status.
                state: item.isError === true ? 'failed' : 'succeeded',
                detail: item.content.slice(0, LEDGER_DETAIL_LIMIT),
              });
            }
            // The result as an EVENT, in the slot the four-step order fixes:
            // AFTER the ledger settle and BEFORE `context.defer`, so the durable
            // record of the effect exists before the effect is visible anywhere.
            //
            // `durationMs` and `metadata` are the PRODUCER's, carried verbatim
            // from the same drain item (`ports.ts` `ToolOutcome`) rather than
            // measured here: the engine did not time the call and must not claim
            // to. The outcome is projected, never defaulted -- see
            // `toolOutcomeOf`.
            ports.events.publish({
              type: 'tool.call_completed',
              toolCallId: item.callId,
              content: item.content,
              outcome: toolOutcomeOf(item),
              durationMs: item.durationMs,
              ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
            });
            const fragment: TransientContextFragment = {
              kind: 'deferred_tool_context',
              text: item.content,
              key: `tool_result:${item.callId}`,
            };
            // Both: `defer` hands it to the host for the next assembly, and the
            // local list carries it into this run's own message seed. One write,
            // two readers, no second copy of the text.
            ports.context.defer(fragment);
            ctx.deferred.current.push(fragment);
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
            // Adopted, and it reaches the NEXT model request -- the current one
            // is already built. Same position as `before_tool` above and the same
            // reason; the legacy's `PostToolUse` (loop bus) injects land the same
            // way, after the turn's results are committed and before the next
            // request is assembled.
            this.#adopt(
              ctx.ports,
              await this.#contribute(ctx, 'after_tool', { outcome: item }),
              ctx.deferred.current,
            );
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
            ctx.deferred.current.push(fragment);
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
      // Published even when the drain returned early on an abort, because
      // `results` is what actually landed and the preflight gate asks about
      // landed results rather than about whether the loop ran to the end.
      ctx.turnWork.drained = results;
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

    // ── The anti-dead-loop HARD STOP, second and also non-negotiable ─────────
    // A model that asks for the same call over and over is not converging, and
    // each round costs a full model call plus every side effect the call has.
    // So the loop ends rather than spending the rest of the run budget proving
    // it.
    //
    // HERE, beside the turn ceiling and BEFORE the `before_finalize` phase,
    // for two reasons. First, it is a CEILING in the same sense `max_turns` is,
    // and the comment above says a contributor may not reopen one -- a binding
    // veto that kept a diverging run alive would be the engine choosing not to
    // enforce its own invariant. Second, stopping before the phase means a run
    // that is not converging pays no extension round-trip to learn that.
    //
    // ORDER: after `max_turns`, so a run that simply used up its turns keeps
    // reporting `max_turns` and no existing consumer sees a new reason for a
    // case that already had one. Only a run that no ceiling would have stopped
    // reaches this, which is precisely the run it exists for.
    //
    // The threshold is the HOST's, read from `RunExecutionRequest` and never
    // from config, env or TOML. Absent policy = the guard is not armed, and no
    // default is invented here; see `RepeatedCallStopPolicy` for why a silent
    // default would be a ceiling nobody agreed to.
    const stopPolicy = ctx.repeatedCallStop;
    if (stopPolicy !== undefined && stopPolicy.enabled && ctx.repeatedCalls.repeats(stopPolicy.hardStopAt)) {
      return { reason: 'repeated_tool_calls' };
    }

    // A binding veto keeps the run open even when the model asked for nothing.
    // This is the one place a contributor influences the OUTCOME, and it does so
    // through a DECLARED veto rather than by deciding the loop — the difference
    // `00-contracts.md` section F rule 2 draws between contributing a decision
    // and taking the loop over.
    const contributions = await this.#contribute(ctx, 'before_finalize', {});
    // Adopted BEFORE the veto test, and deliberately so: a veto is the run being
    // told to CONTINUE, so anything the same phase said is for the continuation.
    // A run that finalizes instead carries the fragments on `deferred` and ends
    // with them unread.
    //
    // PARITY, and it was disputed in this plan, so it is stated with the
    // mechanism rather than with a resemblance. The legacy's `LoopHookBus`
    // declares the effect types each event honours, and `PreFinalize` honours
    // exactly one -- `block_finalize` -- so a handler returning an `inject`
    // there is discarded BY THE BUS before `SessionFinalizer.finalizeSuccess`
    // reads the list. `finalizeSuccess` itself then keeps only a veto and drops
    // the rest. So the legacy cannot deliver a non-vetoing `PreFinalize`
    // inject to the model on any path, and "unread on a finalizing run" is the
    // same outcome on both sides rather than a gap in this one.
    //
    // The engine is in fact MORE generous: it has no per-event effect filter,
    // so it accepts an `inject` the legacy's bus would drop. That extra
    // permissiveness changes no observable outcome, because a non-vetoing
    // contribution on a finalizing run is read by nobody on either path -- and
    // widening the legacy's bus to match would be a product behaviour change
    // nobody asked for. Measured on both paths by
    // `engine-before-finalize-parity.test.ts`.
    this.#adopt(ctx.ports, contributions, ctx.deferred.current);
    const vetoed = contributions.some(
      (contribution) => contribution.binding && 'veto' in contribution.content,
    );
    if (vetoed) return null;

    // Work behind us means the model has results it has not seen yet. Stopping
    // here would strand them: the tool ran, its effect is on disk, and the
    // answer never reaches the model. This is `needsFollowUp` at
    // `DuyaAgent.ts:3107`, and it is a fact about what the engine dispatched.
    if (turnWork.dispatched > 0) return null;

    // ── Inter-turn injection sites 2 and 3 of 3: around the final answer ─────
    // Both sit here, after the `dispatched` test and before the run is allowed
    // to end, because that is the only window in which the model has finished
    // its work AND the engine is still willing to give it another turn. A
    // message that lands during the model call is therefore seen by the model
    // on the NEXT request, and a message that lands after this point waits for
    // the run to end -- which is the legacy's position at `:3194-3197` and the
    // reason its comment says in-run guidance is "not limited to tool-heavy
    // flows".
    //
    // Site 2 is the legacy's `:3198`. A `hard_replace` loops back for a fresh
    // turn, and so does an absorbing `continue` (`:3206-3213`); the two differ
    // only in what the host already put in the transcript, which
    // `#absorbInjection` has handled identically.
    const finalInbound = await ctx.ports.interTurn.sweep({
      runId: ctx.runId,
      checkpoint: 'before_final_answer',
    });
    this.#absorbInjection(ctx, finalInbound);
    if (finalInbound.decision.action === 'soft_stop') {
      await this.#softStop(ctx, finalInbound.decision.summary);
      return { reason: 'completed' };
    }
    if (finalInbound.decision.action === 'hard_replace') return null;
    if (finalInbound.decision.action === 'continue' && finalInbound.decision.absorbed) return null;

    // Site 3 is the legacy's finalize-boundary poll (`:3261-3279`), and it is a
    // SECOND sweep at the same checkpoint rather than a continuation of site 2.
    // The legacy asks twice because its first ask happens before the mode
    // coordinator's PreFinalize hooks run (`:3222-3247`) and a hook is
    // long-running enough for a notification to land in between; asking again
    // afterwards keeps that notification inside this run instead of leaking it
    // to the renderer's resume path.
    //
    // BOUNDED, and the bound is the legacy's own: `FINAL_POLL_MAX_ABSORBS = 3`
    // (`DuyaAgent.ts:1819`). An absorbing answer loops back, which would
    // otherwise be an unbounded cycle between a host that always has something
    // to say and a model that always answers. The counter is run-scoped, and its
    // lifetime is the run's rather than this turn's: the loop-back re-enters the
    // top of the `for`, where `RunContext` is rebuilt, so a per-turn value would
    // reset to zero on every pass and the cap would never be reached.
    if (finalInbound.decision.action === 'continue' && !finalInbound.decision.absorbed) {
      const polled = await ctx.ports.interTurn.sweep({
        runId: ctx.runId,
        checkpoint: 'before_final_answer',
      });
      this.#absorbInjection(ctx, polled);
      if (
        polled.decision.action === 'continue' &&
        polled.decision.absorbed &&
        ctx.finalPollAbsorbs.current < FINAL_POLL_MAX_ABSORBS
      ) {
        ctx.finalPollAbsorbs.current += 1;
        return null;
      }
    }

    // ── The `before_commit` phase: the legacy's `PostTurn` slot ─────────────
    // Here, and not in the `finally` beside `after_finalize`, because position
    // is the whole of the legacy's semantics. `SessionFinalizer.finalize` runs
    // `pollFinalMailbox` -> `PreFinalize` -> `PostTurn` -> `runExitHooks` ->
    // `_commitMessages` -> `SessionEnd`, and `PostTurn` is the one step that both
    // (a) sits INSIDE the run, before the commit, and (b) is reached only on the
    // success path. `after_finalize` satisfies neither: it fires in the
    // `finally`, so a FAILED and a CANCELLED run reach it too, and by then the
    // loop has broken and nothing is committed afterwards.
    //
    // This is the LAST thing before the run is allowed to end, which is the
    // faithful position: the model has finished its work, the polls have run, and
    // the engine is still inside the decision that ends the run.
    //
    // GATED, and the gate is the requirement rather than an optimisation: a run
    // with no contributor registered must gain NO scheduling point here, because
    // an unconditional `await` at the end of a run is a microtask that every
    // other run used to skip -- which is exactly the regression that moved a
    // scheduling point and broke a stop-aborts-the-provider test in this plan.
    // Same rule and same shape as `on_start` and `after_finalize`.
    //
    // Plan 610 D5: a mode's `onExit` runs BETWEEN the `before_commit`
    // contribution and its commit, so the `else` branch below exists and the
    // call is NOT after the gate. The gate covers only the two phase awaits,
    // which is what keeps the no-contributor run free of a scheduling point;
    // the mode exit was already unconditional before this slice and stays
    // unconditional. Measured by `engine-mode-exit-order.test.ts`, which is an
    // ORDERED observation rather than a pair of existence checks -- an
    // implementation that ran the teardown after `#commitContributions`
    // satisfied "the contributor ran" and "the mode exited" while doing the
    // opposite of what this comment claims, which is the defect that shape
    // cannot see.
    if ((ctx.ports.extensions?.list('before_commit') ?? []).length > 0) {
      const committed = await this.#contribute(ctx, 'before_commit', {});
      await this.#runModeExits(ctx);
      await this.#commitContributions(ctx, committed);
    } else {
      // No contributor, so there is nothing to observe and nothing to commit,
      // but the teardown still belongs to every successful run. See the block
      // below for why this is not `after_finalize`.
      await this.#runModeExits(ctx);
    }

    return { reason: 'completed' };
  }

  // ── A mode's run-boundary teardown ────────────────────────────────────────

  /**
   * Run every `kind: 'message'` mode's `onExit` hook, once, for THIS run.
   *
   * ## BETWEEN the `before_commit` contribution and its commit, which is the
   * legacy's own order and not an arbitrary one
   *
   * `SessionFinalizer.finalizeSuccess` runs `PostTurn` -> `runExitHooks` ->
   * `_commitMessages` -- the loop-bus `PostTurn` dispatch, then `runExitHooks`,
   * then the `host._commitMessages()` that persists the working array. So a
   * mode's teardown OBSERVES the `PostTurn` effects and PRECEDES the durable
   * write of them. Folding it in after the commit would let a mode read a
   * timeline the run has already persisted; folding it in before the
   * contribution would invert both.
   *
   * Measured rather than restated: `engine-mode-exit-order.test.ts` drives a
   * real `RunEngineImpl` over real composed ports and asserts the ORDER of the
   * three finalize-boundary effects. The comment above it once described a
   * position the code did not have.
   *
   * ## NOT a phase, and the reason is measured rather than stylistic
   *
   * A mode's `onExit` returns `void` and its real work is a host side effect
   * (`computer-use-mode.ts` clears a per-session trigger and disables the OS
   * bridge). There is no `ExtensionContribution` that means "nothing, but I
   * ran" -- expressing it as one would be a contribution whose value is
   * discarded, which is the `ExtensionPort` doc's own failure. See
   * `ModeExitPort` for the full enumeration of why `after_finalize` is not
   * this channel despite a comment in `DuyaAgent.ts` claiming it is.
   *
   * ## SUCCESS PATH ONLY, and that is what makes it not `after_finalize`
   *
   * `runExitHooks` is reached from `finalizeSuccess` alone; `finalizeAbort`
   * and `finalizeStreamError` never call it. A mode that disables an OS bridge
   * on exit must not do so for a run that failed before finishing a turn. The
   * engine inherits that by CALLING this only from the success position, so
   * the property does not depend on a caller remembering.
   *
   * ## FAIL-OPEN, reproducing `SessionFinalizer.finalizeSuccess` rather than
   * delegating the policy
   *
   * A mode whose teardown throws must not replace a `completed` terminal the
   * run has already earned. The engine owns the outcome, so the engine
   * swallows this -- the same rule 3 applies to every extension phase, and the
   * same reason `#commitContributions` is the single documented exception
   * (there the phase's output IS the record).
   */
  async #runModeExits(ctx: RunContext): Promise<void> {
    if (ctx.ports.modeExit === undefined) return;
    try {
      await ctx.ports.modeExit.onRunExit();
    } catch {
      // Deliberately silent. The legacy logs this at WARN through
      // `electron/logging/logger.ts`, which `@duya/agent-runtime` may not
      // import (G1), and the engine has no logger of its own. The throw is
      // swallowed rather than surfaced because the run's answer is already
      // produced: a mode's teardown failing is not the run failing.
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  // ── Inter-turn input ─────────────────────────────────────────────────────

  /**
   * Put whatever the host injected into the transcript for the rest of the run.
   *
   * A method rather than a line at each call site because the APPEND is the
   * contract: the legacy's `messages.push` mutates one array that every later
   * turn reads, so an injection is visible to the model on this request AND on
   * every request after it. Assigning `ctx.injected.current = result.injected`
   * instead would make the newest injection overwrite the previous one, and a
   * run that absorbed three notifications over its lifetime would show the
   * model only the third.
   *
   * The `ModelMessage[]` is the host's already-projected text -- the port
   * returns additions in the runtime's own vocabulary precisely so this is a
   * concatenation rather than a re-projection the engine would have to own.
   */
  #absorbInjection(ctx: RunContext, result: InterTurnSweepResult): void {
    if (result.injected.length === 0) return;
    ctx.injected.current = [...ctx.injected.current, ...result.injected];
  }

  /**
   * End the run with the host's own text, as the model's answer.
   *
   * The legacy's `soft_stop` arm pushes an assistant message carrying the
   * summary, commits it, yields it as `text`, and returns `completed`
   * (`DuyaAgent.ts:2217-2231`). The push and the `text` yield are the HOST's
   * durable-transcript business -- `TurnOutputPort`, which is still unbound
   * because the legacy drain loop performs those writes today -- so what the
   * engine can honestly do here is narrower: it records the text as this run's
   * assistant message so the frames a consumer sees are coherent, and lets the
   * normal `finally` propose `completed`.
   *
   * It does NOT invent a `TurnMessage` for a turn that never streamed. If the
   * sweep lands before the model call there is no message to finalize, and
   * `#finalizeLastMessage` returns without publishing -- absence, not a
   * fabricated empty answer. Stating that here because the alternative (minting
   * a message so the summary is never lost) is a durable-write decision, and
   * that belongs to `TurnOutputPort` at the cutover rather than to this slice.
   */
  async #softStop(ctx: RunContext, summary: string): Promise<void> {
    const text = summary.trim() === '' ? 'Stopped as requested.' : summary;
    // The legacy's own fallback for an empty summary (`DuyaAgent.ts:2218`).
    ctx.ports.events.publish({
      type: 'diagnostic',
      level: 'info',
      message: `run stopped by the host at turn ${ctx.turn}: ${text}`,
      data: { runId: ctx.runId, turn: ctx.turn, checkpoint: 'soft_stop' },
    });
  }

  // ── Compaction ─────────────────────────────────────────────────────────────

  /**
   * Run one compaction pass, and adopt its replacement if it produced one.
   *
   * Delegated to `runCompactionPass`, which owns the frame ordering and the
   * `unbound` case; this method owns the two things the loop is for -- applying
   * the replacement, and advancing the generation.
   *
   * ## Applying the replacement is the entire point
   *
   * A pass that publishes `compaction.completed` and is then ignored leaves the
   * provider sending the original history forever, so the two assignments below
   * are the load-bearing lines rather than bookkeeping:
   *
   *  - `compacted.current` is what `#modelRequest` builds the next request from.
   *  - `contextEpoch += 1` retires the generation the just-finished request
   *    belonged to, so a later `noteUsage` cannot anchor the new one to a size it
   *    never had. The legacy bumps on the same event (`CompactionManager.ts:918`).
   *
   * ## Why the failure policy is NOT here
   *
   * The three sites apply three different ones -- the legacy's, not this
   * method's: a proactive failure ends the run, a preflight and an emergency
   * failure are swallowed. Collapsing that into one policy would either fail runs
   * over a best-effort check or hide a compaction that could not shrink a
   * transcript it was asked to shrink. So the pass reports and the site decides.
   */
  async #compact(
    ctx: RunContext,
    input: {
      readonly trigger: 'auto' | 'preflight_overflow' | 'emergency';
      readonly transcript: readonly ModelMessage[];
      readonly providerError?: string;
    },
  ): Promise<CompactionPassResult> {
    const result = await runCompactionPass({
      port: ctx.ports.compaction,
      events: ctx.ports.events,
      decision: {
        turn: ctx.turn,
        transcript: input.transcript,
        trigger: input.trigger,
        // Spread, and not a named `observation: undefined`: the decision input
        // compiles with `exactOptionalPropertyTypes`, so naming the field with
        // no value is not the same as omitting it. The proactive site has no
        // observation at all and `ports.ts` says so explicitly -- it is a guess,
        // and forcing one would be the "announced success for work that did not
        // happen" shape.
        ...(input.providerError === undefined
          ? {}
          : { observation: { providerError: input.providerError } }),
      },
      signal: ctx.signal,
    });

    if (result.kind === 'replaced') {
      ctx.compacted.current = result.transcript;
      // The generation is retired by the compaction that replaced the lineage,
      // and nowhere else. A cell rather than a local for the reason `lastMessage`
      // and `blockIndex` are cells: this method has to write run-scoped state,
      // and the engine object must stay stateless.
      ctx.contextEpoch.current += 1;
    }
    return result;
  }

  /**
   * The transcript to hand the port at a decision point.
   *
   * Three inputs, in precedence order, and the order is the whole argument:
   *
   * 1. a compaction's replacement, when one exists. It is not optional: the
   *    legacy re-projects after every compaction precisely so the next
   *    iteration "sees the compacted projection" (`DuyaAgent.ts:3034-3036`).
   * 2. the fragments drained this turn whose text already exists. They are the
   *    payload a preflight probe exists to catch, and they are not yet in the
   *    assembly.
   * 3. the assembled messages, which is the last point the engine holds a real
   *    transcript rather than a `ResolvedPart` the host still has to resolve.
   *
   * ## Why this is NOT `#fragmentMessages`, and why it is not async
   *
   * `#fragmentMessages` AWAITS a `pending` fragment, correctly, because the
   * next turn's request genuinely has to carry it and the port's own doc scopes
   * that wait: "A `pending` that never settles stalls the turn that resolves it"
   * is a recorded property of the deferred-review design, tied to
   * `#modelRequest` (`ports.ts`, `PendingTransientContextFragment`).
   *
   * A compaction probe is not that turn. It runs after the drain and, on the
   * emergency path, after a stream has already FAILED -- so awaiting there would
   * park a recovery on a promise the host may not settle until the very request
   * that is being recovered from. It is also the wrong FACT: a pending fragment
   * has not been written anywhere yet, so the host's own projection would not
   * contain it either. Including it would claim a transcript larger than the real
   * one, and a probe that over-reports its input compacts early.
   *
   * So a pending fragment is left out rather than awaited, and the method stays
   * synchronous. Pinned by `run-engine-compaction.test.ts`, "probes without
   * waiting on a deferred context that never settles" -- the promise in that
   * fixture never resolves, so an awaiting implementation can only reach the
   * suite timeout.
   *
   * ## This is a composition, not a re-projection
   *
   * The legacy calls `projectInputMessages` at both post-request sites (`:3011`,
   * `:3331`) and that method is the HOST's -- it reads the durable timeline,
   * which lives above this layer. So the port measures this candidate, and a
   * host whose timeline disagrees with it is disagreeing about a fact the engine
   * cannot see. Stated here because a compaction that fires against the wrong
   * transcript is the one failure mode worse than not firing.
   */
  #transcriptFor(
    ctx: RunContext,
    assembled: AssembledTurn,
    drained?: readonly TransientContextFragment[],
  ): readonly ModelMessage[] {
    const base = ctx.compacted.current ?? assembled.messages;
    if (drained === undefined) return base;
    // Narrowed on the presence of `pending`, which is what makes "the text is
    // `string | undefined`" unrepresentable (`ports.ts`, the fragment union).
    const settled = drained.filter((fragment) => fragment.pending === undefined);
    if (settled.length === 0) return base;
    return [
      ...base,
      ...settled.map((fragment) => ({
        role: 'user' as const,
        id: `fragment:${fragment.key}`,
        content: fragment.text,
      })),
    ];
  }

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
   *
   * ## Why the scope is `ExtensionScope` and not `RunContext`
   *
   * Because the two run-scoped phases run OUTSIDE any turn. `RunContext` is
   * rebuilt every iteration and carries the turn's assembly, spend and work
   * counters, none of which exist before turn 1 or after the loop has broken --
   * so a `RunContext` parameter would force the two run-scoped call sites to
   * mint a context that is a fiction, and every field a future contributor
   * reads off it would be a plausible-looking zero.
   *
   * `ExtensionScope` is exactly the four things `#contribute` reads, and
   * `RunContext` satisfies it structurally, so the five per-turn call sites are
   * unchanged by this narrowing. The type is the whole argument: it is what
   * makes "this phase has no turn context" a compile-time fact rather than a
   * comment.
   */
  async #contribute(
    scope: ExtensionScope,
    phase: ExtensionPhase,
    extra: {
      readonly call?: ToolCallRequest;
      readonly outcome?: ToolOutcome;
      readonly exit?: EngineExit;
    },
  ): Promise<readonly ExtensionContribution[]> {
    const contributors = scope.ports.extensions?.list(phase) ?? [];
    // The streak, off the SAME object `#shouldStop` reads, so a hook is given the
    // count the engine's own stop decision would use rather than a second,
    // independently-maintained number. `ExtensionScope` is what makes it
    // reachable from the two run-scoped call sites as well as the five per-turn
    // ones: it carries the run-scoped cell, and `RunContext` satisfies it
    // structurally.
    //
    // The conditional spread rather than an assignment: `ExtensionContext` is
    // `readonly` per field, and an `undefined`-valued member would also be a
    // DIFFERENT state from an absent one. `undefined` before the run has
    // dispatched anything is the legacy's own answer
    // (`DeadLoopTracker.stats`), and the package compiles with
    // `exactOptionalPropertyTypes`, so "no streak yet" has to be expressed by
    // omitting the key.
    const streak = scope.repeatedCalls.stats();
    const context: ExtensionContext = {
      runId: scope.runId,
      turn: scope.turn,
      ...(streak === undefined ? {} : { repeatedToolCalls: streak }),
      ...extra,
    };
    const adopted: ExtensionContribution[] = [];

    for (const contributor of contributors) {
      try {
        for (const contribution of await withDeadline(
          contributor.contribute(context, scope.signal),
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
   * Put a phase's TEXT contributions on the run's deferred-fragment rail.
   *
   * ## Why this is a method and not a line at each call site
   *
   * Because before this, `#contribute`'s return value was read at exactly ONE of
   * its seven call sites -- `before_finalize`, and only to ask whether a
   * contribution was a VETO. Every text contribution at every phase, including
   * the veto phase's own non-veto siblings, was computed and dropped. A hook
   * that returned `additionalContext` was executed and its output discarded, and
   * the run still completed cleanly, so nothing in a frame said so.
   *
   * The rail is the one the tool leg already uses (`#drainOutcomes`:
   * `ports.context.defer(fragment)` plus the same object pushed onto `deferred`),
   * because there is no second one: `#modelRequest` turns `deferred` into
   * messages through `#fragmentMessages`, and a fragment that skipped the local
   * list would reach only the host, never the model.
   *
   * ## A veto is NOT text, and is skipped
   *
   * `ExtensionContribution.content` is a fragment OR `{ veto: true, reason }`. The
   * veto is a decision the engine honours by refusing to finalize; there is no
   * prompt to render it as. Pushing it would hand `#fragmentMessages` an object
   * with neither `text` nor `pending`, which `fragmentText` resolves to
   * `undefined` -- a `user` message whose content is the string "undefined".
   */
  #adopt(
    ports: RunEnginePorts,
    contributions: readonly ExtensionContribution[],
    deferred: TransientContextFragment[],
  ): void {
    for (const contribution of contributions) {
      // Narrows to `TransientContextFragment`; the `binding` flag is NOT the
      // discriminator, because a contributor may return advisory text that
      // happens to be marked binding and a veto that is not.
      if ('veto' in contribution.content) continue;
      deferred.push(contribution.content);
      ports.context.defer(contribution.content);
    }
  }

  /**
   * COMMIT a `before_commit` phase's text contributions to the durable record.
   *
   * ## Why this exists at all, and what it is NOT
   *
   * The gap it closes is measurable. A contributor had exactly one way to put
   * work in the transcript, and neither existing path could reach the durable
   * record at end of turn:
   *
   *  - `before_finalize` can only VETO. `#shouldStop` reads a binding veto as
   *    "run again", and its text contributions go through `#adopt` onto the
   *    deferred rail, so they reach the model only if ANOTHER turn happens. A
   *    run that finalizes ends with them unread -- which is the legacy's own
   *    position too: its `LoopHookBus` honours only `block_finalize` at
   *    `PreFinalize`, so the legacy cannot carry such an inject to the model
   *    either. Measured on both paths by
   *    `engine-before-finalize-parity.test.ts`.
   *  - `after_finalize` runs in the run's `finally`, after the loop has broken,
   *    and its contributions are deliberately NOT adopted (see its call site).
   *    That behaviour is documented and was reviewed; this method does not
   *    change it and does not adopt anything on its behalf.
   *
   * The legacy had a third thing, and this is it: `PostTurn` applies its effects
   * to the working `messages` array and `_commitMessages` persists the array
   * immediately afterwards (`SessionFinalizer.ts:226`, then `:245`). So a
   * `PostTurn` contribution reaches the timeline, the durable record, and a
   * later turn -- all three -- and that is the capability that had no engine
   * phase.
   *
   * ## Why it does not go through `#adopt`
   *
   * Because `#adopt` defers, and a run that finalizes has no next request. A
   * fragment handed to `ports.context.defer` and pushed onto `ctx.deferred` here
   * would be written to the host for a list nothing will ever read, which is a
   * side effect claiming a delivery that did not happen -- the precise
   * objection `after_finalize`'s call site raises about itself.
   *
   * ## A veto here is IGNORED, deliberately
   *
   * There is no loop left to keep open: this runs after every veto test and
   * after the polls, and the run is about to return `completed`. Honouring a
   * veto would mean this method decides the run's outcome, which is the line
   * `00-contracts.md` section F rule 2 draws between contributing a decision and
   * taking the loop over. A contributor that wants to keep the run alive
   * registers for `before_finalize`, which is the phase whose veto means exactly
   * that. Said here because a silently-ignored veto is indistinguishable from a
   * dropped one in a frame.
   *
   * ## WHY A THROWING HOST IS FATAL HERE, and it is the one exception to rule 3
   *
   * Because this is the commit. Every other extension phase is fail-open by
   * contract, and a skipped phase loses a hook's SIDE EFFECT -- `after_finalize`
   * says outright that the phase is still worth running when all it does is
   * cleanup. Here the phase's entire output IS the record, so swallowing a
   * rejected `recordInjectedMessage` would end the run having published a
   * success and lost the row: a claim of durability with nothing behind it. The
   * run fails loudly instead. The contributor's own throw is still swallowed
   * upstream by `#contribute`, which is rule 3's own boundary -- this catch is
   * about the HOST's store, not the contributor.
   */
  async #commitContributions(
    ctx: RunContext,
    contributions: readonly ExtensionContribution[],
  ): Promise<void> {
    if (contributions.length === 0) return;
    // `undefined` means the host bound no `turnOutput`, which is the live
    // worker's state today. It is the same absence that loses the run's own
    // assistant row, so it is NOT reported as a failure here: inventing a
    // diagnostic would claim the engine is broken when the obligation is the
    // cutover's, and the obligation is already written down in `TurnOutputPort`.
    const turnOutput = ctx.ports.turnOutput;
    if (turnOutput === undefined) return;

    // Text only, and the same discriminator `#adopt` uses: `binding` is not the
    // discriminator, because a contributor may return advisory text marked
    // binding and a veto that is not.
    const text = contributions.filter((contribution) => !('veto' in contribution.content));
    // A `pending` fragment is a payload still being computed. Resolved with the
    // engine's own `fragmentText` -- the same function `#modelRequest` uses -- so
    // a committed row and a row the model would have seen are the same string
    // rather than two implementations agreeing. A rejection is a SKIP, which is
    // `#fragmentMessages`' own `allSettled` policy, applied for the same reason:
    // one contributor's dead payload must not fail the commit of the rest.
    const resolved = await Promise.allSettled(
      text.map(async (contribution) => ({
        key: contribution.key,
        text: await fragmentText(contribution.content as TransientContextFragment),
      })),
    );
    for (const outcome of resolved) {
      if (outcome.status === 'rejected') continue;
      // An empty contribution commits nothing. Recording it would put a row with
      // no content in the durable transcript, and a transcript rebuilt from rows
      // would then show a message the user never received.
      if (outcome.value.text.trim() === '') continue;
      await turnOutput.recordInjectedMessage({
        runId: ctx.runId,
        turn: ctx.turn,
        key: outcome.value.key,
        text: outcome.value.text,
      });
    }
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
  ): Promise<ModelRequest> {
    const { input, manifest } = ctx;
    // A `by_ref` history is the HOST's to resolve; the engine hands the locator
    // back rather than re-resolving it, which is what keeps exactly one
    // derivation of "the same input" (ports.ts contract 2).
    //
    // A compaction's replacement OUTRANKS both, and that precedence is the whole
    // mechanism by which a compaction does anything. `CompactionOutcome.replacement`
    // is documented as "the transcript the NEXT request must be built from"
    // (`ports.ts`), and the two sources below cannot honour that on their own:
    // an `inline` history is frozen at run start, so it would resend the
    // pre-compaction messages on every later turn, and `assembled.messages`
    // reflects the host's timeline rather than a transcript the port has
    // already rewritten. This is the same limitation `RunInputSnapshot.steering`
    // has and for the same reason -- the snapshot is fixed at run start, so
    // nothing that changes mid-run can ride it.
    const history: readonly ModelMessage[] =
      ctx.compacted.current ??
      (input.history.kind === 'inline' ? input.history.value : assembled.messages);

    const steering = await this.#fragmentMessages(
      'steering',
      input.steering
        .filter((directive) => directive.effectiveFromTurn <= ctx.turn)
        .map((directive) => directive.payload),
    );

    const carried = await this.#fragmentMessages('fragment', ctx.deferred.current);

    // Host-injected text rides EVERY request from the sweep onward, not just
    // the one that followed it. Concatenated after the history, which is the
    // position the legacy's `messages.push` occupies: the injected message is
    // the most recent thing in the conversation, so it must not be reordered
    // behind a history the model has already read.
    const inbound = ctx.injected.current;

    // The prompt goes in on the FIRST turn only. Later turns are continuations
    // after tool results, and re-appending the prompt every turn is how a
    // conversation teaches a model to repeat itself.
    const messages: readonly ModelMessage[] =
      ctx.turn === 1
        ? [input.prompt, ...steering, ...carried, ...history, ...inbound]
        : [...history, ...carried, ...steering, ...inbound];

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
   * Hand the provider's real token count to the compaction port.
   *
   * Two gates, and both are load-bearing rather than defensive:
   *
   *  - **no port, no anchor.** There is nothing to hand it to, and inventing a
   *    local estimator next to the port's own would be the second token counter
   *    `ports.ts` refuses.
   *  - **zero input tokens are not an observation.** The legacy guards the same
   *    way at `:3166` (`if (observedInput > 0)`), and the reason is that many
   *    providers report a `usage` frame with an input count of 0 for a request
   *    that was pure cache read. Filing that as "the prompt was empty" would
   *    collapse the anchor to zero and make the next decision fire immediately.
   *    A port that WANTS the zero has the transcript to measure.
   */
  #anchorUsage(ctx: RunContext, epoch: number, inputTokens: number, outputTokens: number): void {
    const port = ctx.ports.compaction;
    if (port === undefined) return;
    if (inputTokens <= 0) return;
    port.noteUsage?.({ turn: ctx.turn, inputTokens, outputTokens, epoch });
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
      case 'repeated_tool_calls':
        // `completed`, and NOT `failed`: the run ended the way it was told it
        // could end, with every call before it dispatched, recorded and settled.
        // A status of `failed` would put an error object in the durable record
        // for a guardrail that did its job -- the same distinction
        // `max_turns` draws a line above, and the reason the legacy's `done`
        // event carries this reason rather than an error.
        return {
          state: { status: 'completed' },
          reason: 'the run stopped because the model repeated the same tool call',
        };
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
  /**
   * Tool RESULTS that landed this turn, as opposed to calls dispatched.
   *
   * The two are different quantities and the preflight compaction site needs
   * the second: its gate is the legacy's `toolResultMessageCount > 0`
   * (`DuyaAgent.ts:3009`), and a dispatch is not an answer -- two calls can come
   * back with one result, and a `discard` can leave a dispatched call with none.
   * Counted in the same place the legacy counted it (the top of the
   * `tool_result` arm, `:2722`) so a host effect that throws cannot un-count a
   * result that did land.
   */
  drained = 0;

  record(): void {
    this.dispatched += 1;
  }
}

/**
 * The consecutive-identical-tool-call streak. The anti-dead-loop HARD STOP's
 * whole input, and run-scoped because a streak that reset every turn could never
 * reach a threshold.
 *
 * ## The signature is the legacy's, deliberately
 *
 * `name` + U+0001 + `JSON.stringify(input)` is exactly what
 * `packages/agent/src/agent/TurnLoopTracker.ts` composes (`toolCallSignature`),
 * and it is re-derived here rather than imported. It CANNOT be imported: this
 * package depends only on `@duya/agent-core` and `@duya/agent-protocol`, and
 * `@duya/agent` depends on THIS package, so an import would be a cycle. Lifting
 * the helper into `@duya/agent-protocol` -- the one lower package both sides
 * already depend on -- would make the two implementations provably the same, and
 * that is a package-boundary decision this change does not make on its own.
 *
 * So the duplication is stated here rather than hidden, and the contract is the
 * part that matters: identical name AND identical serialised input, with the
 * separator U+0001 because it cannot occur in either part. Two runs that count
 * the same streak therefore agree on when it fires.
 *
 * `JSON.stringify` is the legacy's own serialiser and it THROWS on a circular
 * structure. That is kept rather than defended against: `ToolCallRequest.input`
 * is `Readonly<Record<string, unknown>>` decoded from the provider's JSON, and
 * the legacy has the identical exposure on the identical path
 * (`DuyaAgent.ts:3586`). A guard here would make this tracker count differently
 * from the one it replaces.
 */
class RepeatedCallStreak {
  #lastSignature: string | null = null;
  #count = 0;
  #currentName: string | null = null;

  /** One dispatched call. A different signature starts a new streak at 1. */
  record(name: string, input: Readonly<Record<string, unknown>>): void {
    const signature = `${name}\u0001${JSON.stringify(input)}`;
    if (signature === this.#lastSignature) this.#count += 1;
    else {
      this.#lastSignature = signature;
      this.#count = 1;
    }
    // The streak's NAME, kept separately from the signature so `stats()` can
    // report it without splitting a string it built for comparison. Recorded on
    // EVERY call rather than only on a new streak, which is the legacy's own
    // ordering (`DeadLoopTracker.record` sets `currentName` outside the
    // branch): within a streak the name cannot change, and across a reset the
    // branch above has already written the new signature.
    this.#currentName = name;
  }

  /**
   * The streak as a contributor reads it, or `undefined` before the run has
   * dispatched anything.
   *
   * ## Why this is a method and not the two private fields
   *
   * Because `#contribute` needs the fact for EVERY phase, and reaching into two
   * private fields from outside the class would make "was the streak reset or
   * merely continued" a question each caller has to re-answer. `undefined` is
   * the legacy's own answer for "nothing recorded yet"
   * (`DeadLoopTracker.stats`), kept so a hook can short-circuit before any
   * threshold comparison rather than reading a count of 0.
   *
   * ## The same object the hard stop reads
   *
   * `repeats` and this method are two views of `#count` on ONE instance, so the
   * number a nudge hook is given and the number the hard stop fires on cannot
   * drift. A second counter would be a second authority for "how many identical
   * calls has this run made", which is exactly the defect that makes a run stop
   * at a different call than the hook warned about.
   *
   * The returned object is a fresh literal per call and typed
   * `RepeatedToolCallStreak`, which is re-derived rather than imported for the
   * package-cycle reason its own doc comment states.
   */
  stats(): RepeatedToolCallStreak | undefined {
    if (this.#count === 0 || this.#currentName === null) return undefined;
    return { count: this.#count, toolName: this.#currentName };
  }

  /**
   * Whether the streak has reached the host's threshold.
   *
   * `>=`, matching the legacy's own comparison (`shouldHardStop`), so the count
   * of dispatched calls at which the run ends is `hardStopAt` and not one more
   * or one fewer.
   */
  repeats(threshold: number): boolean {
    return this.#count >= threshold;
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
  /**
   * The run's anti-dead-loop HARD STOP thresholds, forwarded from
   * `RunExecutionRequest`. See `RepeatedCallStopPolicy`.
   *
   * Copied onto the context rather than re-read from the request for the reason
   * `modelRequestTimeoutMs` above gives: `#shouldStop` reads the context, and a
   * fact read from two places is a fact that can disagree with itself.
   */
  readonly repeatedCallStop?: RepeatedCallStopPolicy;
  /**
   * The consecutive-identical-call streak. A CELL, and run-scoped; see its
   * declaration in `#run` for why a per-turn value could never reach a
   * threshold.
   */
  readonly repeatedCalls: RunScoped<RepeatedCallStreak>;
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
/**
   * Fragments the NEXT turn's request will carry. A CELL, shared with `#run` by
   * reference -- see its declaration there.
   */
  readonly deferred: RunScoped<{ current: TransientContextFragment[] }>;
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
  /**
   * The transcript a compaction replaced, or null. A CELL for the same reason
   * `lastMessage` is one: `#compact` writes it and `#modelRequest` reads it, and
   * neither is the method that declared it. See its declaration in `#run`.
   */
  readonly compacted: RunScoped<{ current: readonly ModelMessage[] | null }>;
  /**
   * How many compactions have rewritten the context lineage. A CELL, because
   * `#compact` is the only writer. See its declaration in `#run` for why this is
   * not the run epoch.
   */
  readonly contextEpoch: RunScoped<{ current: number }>;
  /**
   * What the host injected between turns, for the rest of the run.
   *
   * A CELL with the same lifetime as `compacted`, and the reason is the same
   * shape of problem from the other direction: both are edits to the
   * TRANSCRIPT that outlive the turn that produced them. `#absorbInjection`
   * writes it, `#modelRequest` reads it, and neither declared it -- see the
   * declaration in `#run`.
   */
  readonly injected: RunScoped<{ current: readonly ModelMessage[] }>;
  /**
   * How many times the finalize poll has looped this run back open.
   *
   * Run-scoped because `#shouldStop` is the only writer and it is a method;
   * see the declaration in `#run` for the bound and why it exists.
   */
  readonly finalPollAbsorbs: RunScoped<{ current: number }>;
}

/**
 * The four things an extension phase actually needs, and the reason two phases
 * can run without a turn.
 *
 * `RunContext` satisfies this structurally, so the five per-turn call sites pass
 * it unchanged; the two run-scoped ones (`on_start`, `after_finalize`) pass a
 * four-field literal. See `#contribute` for why the distinction is load-bearing
 * rather than cosmetic.
 */
interface ExtensionScope {
  readonly runId: RunId;
  /**
   * The turn, or `0` for a phase outside one -- see `ExtensionContext.turn`,
   * which is the value a contributor actually reads and carries the same rule.
   */
  readonly turn: number;
  readonly signal: AbortSignal;
  readonly ports: RunEnginePorts;
  /**
   * The run's consecutive-identical-call streak, so `#contribute` can put it on
   * the context at EVERY phase -- including `on_start` and `after_finalize`,
   * which have no `RunContext` to read it from.
   *
   * Required rather than optional precisely because those two call sites build
   * their scope as a literal: an optional member would be omitted there, and
   * `on_start` would silently hand a contributor no streak on a run that had
   * already dispatched calls, which is a fact a hook cannot recover on its own.
   * A literal cannot supply a counter it does not own, so both run-scoped sites
   * pass the same run-scoped cell `#run` allocated.
   */
  readonly repeatedCalls: RunScoped<RepeatedCallStreak>;
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
 * Ceiling on the finalize-boundary poll's loop-backs.
 *
 * The legacy's own value, `FINAL_POLL_MAX_ABSORBS = 3` (`DuyaAgent.ts:1819`),
 * reproduced rather than re-chosen: the poll's absorbing answer keeps the run
 * open for another turn, and each of those costs a full model call, so an
 * unbounded poll against a host that always has something queued is a run that
 * never ends.
 */
const FINAL_POLL_MAX_ABSORBS = 3;
/** An error `message` is a summary, not a transcript of the tool's whole output. */
const TOOL_ERROR_MESSAGE_LIMIT = 512;

/**
 * The `ToolCallOutcome` a drained result projects to.
 *
 * ## Three arms in, three arms out, and the fourth is a non-answer
 *
 * `ToolOutcome.isError` is a tri-state, and each of its three values maps to
 * exactly one arm of the five-arm union in `payloads.ts:157-166`:
 *
 *  - `true` -- the producer STATED a failure. `tool_error`, carrying the
 *    producer's own text as the message. `tool_failed` is a real member of the
 *    closed `ErrorCode` taxonomy (`errors.ts:61`) and says exactly what was
 *    stated; inventing a narrower code from the message text would be a guess
 *    about a tool the engine has never seen.
 *  - `false` -- the producer stated the call did NOT fail. `success`.
 *  - `undefined` -- the producer said nothing. `indeterminate`, which the
 *    protocol calls the ONLY correct way to pass an absence through. This is
 *    the arm that must never be rounded to `success`.
 *
 * ## The two arms that are unreachable, and why that is correct
 *
 * `timeout` needs an elapsed bound the producer reported and `cancelled` needs
 * a reason string. `ToolOutcome` carries neither, and a timeout the ENGINE
 * imposed is already published as `tool.timed_out` by `#dispatchCall` with the
 * tool's name and the elapsed time. Emitting `timeout` here from
 * `durationMs` would be a category derived from a duration rather than from
 * anything that happened.
 */
function toolOutcomeOf(item: ToolOutcome): ToolCallOutcome {
  if (item.isError === undefined) {
    return {
      outcome: 'indeterminate',
      note: 'the producer completed this call without stating whether it failed',
    };
  }
  if (item.isError === true) {
    const detail = item.content.trim();
    return {
      outcome: 'tool_error',
      error: {
        code: 'tool_failed',
        message:
          detail === ''
            ? 'the producer stated this call failed and supplied no text'
            : detail.slice(0, TOOL_ERROR_MESSAGE_LIMIT),
      },
    };
  }
  return { outcome: 'success' };
}

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
    // A guardrail that fired is not a parent failure: the run ended on the
    // engine's own terms, exactly as `max_turns` does, and recording it as
    // `parent_failure` is the misreading this map exists to prevent.
    repeated_tool_calls: 'completed',
    budget_exhausted: 'budget_exhausted',
    cancelled: 'parent_cancel',
    failed: 'parent_failure',
  });

/** Re-exported so `ProtocolErrorInfo` stays reachable for a host's own errors. */
export type { ProtocolErrorInfo, RunStatus };
