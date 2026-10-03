/**
 * `RunController` — the `AgentRuntimeApi` implementation, and the tee the
 * agent-server's chat path hangs its run on.
 *
 * ## What this class is responsible for
 *
 * Run identity and nothing else. Given a manifest the Control Plane has already
 * frozen, it opens exactly one `RunSession`, drives an execution through the
 * `ExecutionChannel`, translates every frame into a protocol event, mints the
 * run-scoped `seq`, and settles the run once.
 *
 * Deliberately NOT responsible for:
 *
 *  - **Building the manifest.** That is the Control Plane's. A runtime that
 *    assembled its own manifest could not be checked against one, and the
 *    fingerprint that makes resume verifiable would be self-certified.
 *  - **Deciding how a run ends.** `resolveRunOutcome` in `@duya/agent-core`
 *    owns that, so the rules cannot drift between the layer that executes and
 *    the layer that records.
 *  - **Storing anything.** `RunPersistence` is supplied by the Control Plane.
 *
 * ## Why `observeFrame` is public
 *
 * The agent-server already normalises every worker frame
 * (`normalizeWorkerEvent`, router.ts:450) and already writes it to the SSE
 * response. Rather than re-plumb that path, the router TEES it: the frame goes
 * to `observeFrame`, which returns the protocol envelope AND the legacy frame
 * the renderer expects. One source, two consumers.
 *
 * That is also why `observeFrame` returns the legacy frame instead of the
 * controller writing to the response. The router keeps ownership of the HTTP
 * response — a run layer that wrote to `http.ServerResponse` would be a run
 * layer that could only ever be used by HTTP.
 */

import type {
  AgentRuntimeApi,
  CancelOutcome,
  CancelReason,
  EventSource,
  EventType,
  PermissionAck,
  PermissionResponse,
  ProtocolVersion,
  RunEvent,
  RunEventEnvelope,
  RunHandle,
  RunManifest,
  RunResult,
  RunTerminalState,
  RuntimeCapabilities,
  StartOptions,
} from '@duya/agent-protocol';
import { DEFAULT_LIMITS, EVENT_REGISTRY, LifecycleViolation, manifestFingerprint } from '@duya/agent-protocol';
import type { RunSpend } from '@duya/agent-core';
import { RunEventStream, RunSession, type RunPersistence } from './run-session.js';
import { projectToLegacyFrame } from './project/legacy-sse-projector.js';
import type { LegacySseFrame } from './legacy-sse-contract.js';
import { translateFrame, type RawFrame, type TranslateContext } from './translate/chat-event-translator.js';
import {
  ExecutionDispatchError,
  runInputRevision,
  type ExecutionChannel,
  type ExecutionHandle,
  type RunStartInput,
  type StopReceipt,
  type StopRequest,
} from './transport/execution-channel.js';

/** The runtime's own identity, as advertised in its `ready` frame. */
export interface RuntimeIdentity {
  readonly name: string;
  readonly version: string;
  readonly pid?: number;
}

export interface RunControllerOptions {
  readonly channel: ExecutionChannel;
  readonly identity: RuntimeIdentity;
  readonly protocol: ProtocolVersion;
  /**
   * Build the translation context for a run.
   *
   * A callback rather than a value because the context carries a clock, a turn
   * counter and a permission classifier, and the Control Plane is the component
   * that knows all three. Passing it per run also keeps the controller
   * stateless between runs, which is what makes concurrent sessions in one
   * process safe.
   */
  readonly contextFor: (manifest: RunManifest) => TranslateContext;
  readonly persistenceFor: (manifest: RunManifest) => RunPersistence;
  readonly now?: () => number;
  readonly clock?: () => number;
  /** Grace window handed to a cooperative stop, in ms. */
  readonly cancelGraceMs?: number;
  /**
   * How long the runtime will wait for the executor's stop to be acknowledged.
   *
   * Separate from `cancelGraceMs` on purpose, and larger. The grace window is
   * the host's promise to the EXECUTOR ("you have this long to leave cleanly");
   * this bound is the runtime's promise to the CALLER ("you will get an answer
   * in this long"). Without it a stop that is never acknowledged holds the
   * terminal decision open behind it, and a run whose worker is wedged becomes
   * a run nobody can close.
   */
  readonly stopBoundMs?: number;
  /**
   * Measure budget against something other than the manifest's own ceilings.
   *
   * Only needed for a policy `isBudgetExhausted` cannot express — a per-provider
   * cost ceiling, a tenant quota. The default is the manifest, which is where
   * the Control Plane put it, and this class has no second opinion to offer.
   */
  readonly budgetBreached?: (spend: RunSpend, wallClockMs: number) => boolean;
  /**
   * Durable-append batching and retry policy, passed through to every run.
   *
   * The Control Plane's to set, because both numbers are about the cost of a
   * round trip to storage: `flushEvery` trades durability latency against
   * traffic, and `appendRetries` decides how long a refused batch is re-offered
   * before the run is told it lost events. A runtime that chose them itself
   * would be choosing its own durability guarantees.
   */
  readonly flushEvery?: number;
  readonly appendRetries?: number;
  /**
   * How many ended runs this controller can still answer for.
   *
   * Bounded because the alternative is a slower version of the leak it
   * replaces: dropping the live run but remembering every run forever. The
   * durable row remains the receipt of record — this is the in-memory answer
   * for a host still holding a handle, not the archive.
   */
  readonly receiptLimit?: number;
  /**
   * Called after `run.started` is durable and immediately BEFORE the execution
   * is dispatched.
   *
   * The window exists because of plan 587 R2.1. Dispatch moved from the host
   * into `channel.start`, so the executor is now told to begin while the host
   * is still inside `start` — and the very first frame it produces is routed
   * back to the host's tee, which resolves a session to its run through a
   * binding the host has not been able to make yet.
   *
   * It used to be safe by accident: the host bound the session after `start`
   * returned, and the executor's first frame could only arrive on a later I/O
   * turn, by which time the binding existed. That is microtask ordering, not a
   * guarantee, and a dispatch that emitted a frame synchronously would have had
   * it recorded as a frame for a run the host had not bound.
   *
   * So the binding moves INTO this callback, where the order is stated rather
   * than inferred: durable first, bound second, dispatched third. A host that
   * has nothing to bind simply omits it.
   */
  readonly onDispatchReady?: (runId: string) => void;
  /**
   * The host's permission decision path (plan 587 R2.4).
   *
   * ## Why this is a port and not a method
   *
   * A permission answer is a Control Plane DECISION, and the Control Plane is
   * the only component that owns the durable record, the deadline and the
   * grant. The runtime cannot make that decision and must not keep a second
   * copy of one. So `RunHandle.respondToPermission` delegates here, and a host
   * that has not wired a decision path leaves it absent — in which case the
   * method refuses rather than guessing, and `permissionExpiryClock` stays
   * `'absent'` so no host is told a deadline exists that nobody enforces.
   *
   * The desktop implementation is `PermissionCoordinator`; it records the
   * decision durably BEFORE the answer is delivered to the worker, and answers
   * a late or duplicate call with a receipt instead of re-delivering.
   */
  readonly permissionResponder?: PermissionResponder;
  /**
   * Close every permission a run has open, and record why.
   *
   * Called on cancel. Without it a cancelled turn keeps a live prompt, and the
   * answer to that prompt is delivered to whatever tool call the recycled
   * worker is running next.
   */
  readonly permissionCloser?: (runId: string, reason: string) => void;
}

/** What the controller hands a host's decision path. */
export interface PermissionRespondInput {
  readonly runId: string;
  readonly requestId: string;
  readonly response: PermissionResponse;
}

/**
 * The host's permission decision path.
 *
   * Returns a {@link PermissionAck} rather than throwing, because a late or
   * duplicate answer is a normal outcome and the caller is entitled to know
   * which of the unanswerable situations it hit.
   */
export type PermissionResponder = (
  input: PermissionRespondInput,
) => Promise<PermissionAck>;

/**
 * A run that could not be opened.
 *
 * A named failure rather than an adapter's own error, because the two mean
 * different things to a host: "the record does not exist" and "the worker
 * refused to start" are different incidents, and a host that catches broadly
 * will otherwise treat them as the same failure and dispatch anyway. `start`
 * throws this instead of returning a handle, because there is no handle to
 * return — a run with no durable `started` is not a run.
 */
export class RunStartError extends Error {
  /** Stable across hosts: the code a host branches on, not a message. */
  readonly code = 'start_failed' as const;
  /** What the runtime was doing when it gave up, for a log line. */
  readonly stage: RunStartStage;

  constructor(stage: RunStartStage, cause: unknown) {
    super(
      stage === 'started_not_durable'
        ? 'run.started was not acknowledged by the Control Plane, so the run was not dispatched'
        : stage === 'dispatch_refused'
          ? 'the executor was not available, so the run was not dispatched'
          : stage === 'run_not_created'
            ? 'the Control Plane would not create the run row, so the run was not dispatched'
            : 'the execution channel refused to start the run',
    );
    this.name = 'RunStartError';
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Why a run was not dispatched.
 *
 * Every value is a `not accepted`, and they are named separately because each
 * demands a different response from a host:
 *
 *  - `run_not_created` — the Control Plane would not create the row. A
 *    durability problem; the host proceeds without a durable record.
 *  - `started_not_durable` — the row exists but `run.started` never landed. A
 *    transient storage problem.
 *  - `dispatch_refused` — the executor is not there (no worker, closed pipe).
 *    Retrying after one spawns is the fix.
 *  - `dispatch_threw` — the adapter itself failed. A host bug, not a state.
 *  - `unknown` — the host's own `openRun` plumbing failed before any of the
 *    above could be attributed.
 *
 * Collapsing them into one boolean is what let a run look live when nothing had
 * begun executing it.
 *
 * The first four are raised below and by the host adapter; the split is spelled
 * out here because the acceptance type is the host's contract and a host has to
 * be able to branch on all of them.
 */
export type RunStartStage =
  | 'run_not_created'
  | 'started_not_durable'
  | 'dispatch_refused'
  | 'dispatch_threw'
  | 'unknown';


/**
 * What a host learns when it asks for a run to be opened.
 *
 * The host's dispatch is INSIDE the start, so "did it begin executing?" and
 * "does a run exist?" are one answer, not two. A host that gets
 * `accepted: false` knows for certain that no executor was asked to do
 * anything — which is the whole point, because the alternative (dispatch
 * anyway, log the refusal) is what produces a run that looks live, answers
 * nobody, and is closed by nothing.
 */
export type RunStartAcceptance =
  | { readonly accepted: true; readonly runId: string }
  | {
      readonly accepted: false;
      /** The id that was minted and then abandoned, for the log line. */
      readonly runId: string | null;
      readonly stage: RunStartStage;
      readonly reason: string;
    };


/** What the caller learns about one observed frame. */
export interface FrameOutcome {
  /** The legacy frame to forward, or `null` when the event has no legacy form. */
  readonly legacy: LegacySseFrame | null;
  /** The protocol envelope, when the frame produced one. */
  readonly envelope: RunEventEnvelope | null;
  /** True when the frame had no protocol counterpart and is forward-only. */
  readonly forwardOnly: boolean;
  /** True when the frame was an internal control-plane frame and was dropped. */
  readonly internal: boolean;
  /** Present when the frame broke a run invariant. */
  readonly violation?: string;
  /**
   * True when the frame arrived for a run that had already reached its
   * terminal.
   *
   * Rejected, not recorded — the ledger has no seq to give it and the run's
   * history is closed. Reported rather than dropped, because a worker that
   * keeps producing after the run was decided is the difference between a
   * cosmetic duplicate and a host that never sees the frame it is waiting for.
   */
  readonly late?: boolean;
  /**
   * True when this controller has no record of the run at all, and never did.
   * Distinct from `late`: a frame for a run that never opened is a routing
   * mistake, and folding it in with the above would hide that behind a
   * perfectly ordinary race.
   */
  readonly unknown?: boolean;
}

interface ActiveRun {
  readonly manifest: RunManifest;
  readonly session: RunSession;
  readonly stream: RunEventStream;
  readonly translateCtx: TranslateContext;
  handle: ExecutionHandle | null;
  cancelRequested: boolean;
  /**
   * The in-flight settlement, typed by what it resolves to so no caller has to
   * re-derive the terminal from the session and risk inventing one.
   */
  settling: Promise<RunTerminalState> | null;
  /**
   * The wallclock budget timer, if this run has a ceiling.
   *
   * Held so `settle` can clear it. A timer that outlives its run does not just
   * leak a handle: it fires a stop at the executor of a run that no longer
   * exists, which is a stop against somebody else's work.
   */
  wallClockTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The stop currently in flight, so two producers asking to stop the same run
   * share ONE interrupt.
   *
   * Without it, a budget stop and a user cancel that land in the same window
   * each send a `chat:interrupt`, and `agent-process-entry` treats a second
   * interrupt as "clear the command queue" — a different behaviour, not a
   * louder version of the same one.
   */
  stopping: Promise<StopReceipt> | null;
}

export class RunController implements AgentRuntimeApi {
  readonly capabilities: RuntimeCapabilities;

  readonly #options: RunControllerOptions;
  readonly #runs = new Map<string, ActiveRun>();
  /**
   * What each recently-ended run decided, oldest first.
   *
   * The live run is dropped on settle — a run that is over must not be holding
   * a stream, a translation context and a manifest — but the VERDICT it
   * reached is kept, because the contract keeps a run's outcome answerable and
   * `run_not_found` is a lie about a run that ended. Bounded by
   * `receiptLimit`, because remembering every run forever is the same leak
   * with more useful-looking data in it.
   */
  readonly #receipts = new Map<string, RunTerminalState>();

  constructor(options: RunControllerOptions) {
    this.#options = options;
    const { identity, protocol } = options;
    this.capabilities = {
      protocol,
      runtime: { name: identity.name, version: identity.version },
      run: {
        resume: { turnBoundary: false, eventSeq: false, messageIndex: false, checkpointGeneration: false, oldestAvailableSeq: 0, latestSeq: 0, rejectsMidToolResume: true },
        cancel: 'cooperative',
        graceMs: options.cancelGraceMs ?? 5000,
        pause: false,
        deterministic: false,
        // The honest advertisement: this runtime has no permission timer.
        // Claiming one would be lying, and `permission_expiry` is gated on a
        // host capability precisely so a host is never told about a deadline
        // nobody enforces.
        permissionExpiryClock: 'absent',
      },
      events: {
        oldestAvailableSeq: 0,
        latestSeq: 0,
        durable: [...EVENT_REGISTRY.durable],
        volatile: [...EVENT_REGISTRY.volatile],
        ephemeral: [...EVENT_REGISTRY.ephemeral],
      },
      permissions: {
        actions: ['allow', 'allow_always', 'deny', 'defer'],
        defaultTimeoutMs: 300_000,
        maxTimeoutMs: 600_000,
      },
      catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
      transports: ['in-process', 'subprocess'],
      limits: DEFAULT_LIMITS,
      eventTypes: [...EVENT_REGISTRY.all],
    };
  }

  /**
   * The manifest fingerprint a host should record.
   *
   * Exposed statically so the Control Plane can compute and store the hash
   * BEFORE the run exists, and compare it when the run settles. A hash only
   * proves anything if it was pinned before the fact.
   */
  static fingerprint(manifest: RunManifest): string {
    return manifestFingerprint(manifest);
  }

  /**
   * Open a run and dispatch it.
   *
   * The order is the contract: record `run.started`, wait for the Control Plane
   * to acknowledge it, and only then begin the execution. A run dispatched
   * before its own start is durable is a run whose consequences outlive its
   * record, which is the case a durable run log exists to prevent.
   *
   * @throws {RunStartError} when the start could not be made durable, or when
   *   the execution channel refused. Either way the executor is NOT running and
   *   no live run is left behind.
   */
  async start(
    manifest: RunManifest,
    input: { readonly prompt: string; readonly sessionId: string; readonly options?: Readonly<Record<string, unknown>> },
    _opts?: StartOptions,
  ): Promise<RunHandle> {
    const now = this.#options.now ?? Date.now;
    const clock = this.#options.clock ?? Date.now;
    const runId = manifest.runId;

    const session = new RunSession({
      runId,
      sessionId: input.sessionId,
      now,
      startedAt: clock(),
      clock,
      persistence: this.#options.persistenceFor(manifest),
      // The manifest is the Control Plane's frozen decision about what this run
      // was allowed to spend, so it is the budget — not a controller-level
      // default. Omitting it made `#budgetVerdict` false for every run, and a
      // run that hit its ceiling was reported as something other than
      // `budget_exhausted`.
      budget: manifest.budget,
      ...(this.#options.budgetBreached === undefined
        ? {}
        : { budgetBreached: this.#options.budgetBreached }),
      ...(this.#options.flushEvery === undefined ? {} : { flushEvery: this.#options.flushEvery }),
      ...(this.#options.appendRetries === undefined
        ? {}
        : { appendRetries: this.#options.appendRetries }),
    });

    // `run.started` is emitted BEFORE the execution is dispatched, not after.
    // The event carries the manifest hash, and its whole purpose is to make
    // "what was this run given?" answerable for a run that crashed one
    // millisecond later. A run whose first event is a consequence of its
    // second cannot answer that.
    const startedEnvelope = session.observe({
      type: 'run.started',
      manifestHash: manifestFingerprint(manifest),
      protocol: this.#options.protocol,
      runtime: this.#options.identity,
    });

    const active: ActiveRun = {
      manifest,
      session,
      stream: new RunEventStream(),
      translateCtx: this.#options.contextFor(manifest),
      handle: null,
      cancelRequested: false,
      settling: null,
      wallClockTimer: null,
      stopping: null,
    };
    this.#runs.set(runId, active);
    active.stream.push(startedEnvelope);

    // AWAIT the first flush before returning. `observe` records
    // `run.started` immediately rather than behind the batch — and that flush
    // is a floating promise by design, because observing a frame must never
    // block on a cross-process write. But `start` is the one place where the
    // caller is explicitly asking "is this run open yet?", and the host
    // dispatches the execution the moment it returns. Without this await,
    // "recorded before the first frame" would be a race the run layer lost
    // about half the time.
    //
    // And a refusal here means the run is NOT open, which is a decision rather
    // than an accident of a throw: the executor is not started, the run is
    // dropped, and the caller is told which of the two things went wrong.
    //
    // The check is on what was LOST, not on whether `flush` rejected. A drain
    // that gives up on a batch has done its job by definition — the queue is
    // empty and nothing more can be done — so it resolves, and reading the
    // rejection alone would let a run whose `started` was thrown away dispatch
    // an executor anyway.
    try {
      await session.flush();
      if (session.lostEvents > 0) {
        throw new RunStartError('started_not_durable', 'run.started was not acknowledged');
      }
    } catch (error) {
      this.#runs.delete(runId);
      throw error instanceof RunStartError ? error : new RunStartError('started_not_durable', error);
    }

    let handle: ExecutionHandle;
    try {
      // Bind before dispatch, see `onDispatchReady`. Inside the same `try` so a
      // throwing host hook cannot leave the run bound with no executor behind
      // it: the catch below closes the run with a terminal either way.
      this.#options.onDispatchReady?.(runId);
      // The revision is computed HERE, once, and handed to the adapter. The
      // Control Plane that persists it and the adapter that puts it on the
      // executor's command must not each derive it from the same input by their
      // own rules, because two derivations that agree today are two sources of
      // truth that a future option can make disagree. The id is
      // `manifest.runId` and is never re-minted here.
      const startInput: RunStartInput = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        options: input.options ?? {},
        revision: runInputRevision({
          sessionId: input.sessionId,
          prompt: input.prompt,
          options: input.options ?? {},
        }),
      };
      handle = await this.#options.channel.start(manifest, startInput, {
        frame: (raw) => {
          this.observeFrame(runId, raw);
        },
        envelope: (envelope) => {
          active.stream.push(envelope);
        },
        end: () => {
          // The executor's stream ended. The run is not finished until it has
          // a terminal, and this is a floating call — so the catch is not
          // optional bookkeeping: `settle` degrades rather than rejects, but
          // a host that made the channel throw must not learn about it as an
          // unhandled rejection in a process nobody is watching.
          void this.settle(runId).catch(() => undefined);
        },
      });
    } catch (error) {
      // A channel that throws has begun no execution, and the run is already
      // durable — so this one CAN be given a terminal, and must be. Leaving
      // the row `running` here is how a run comes to exist, do nothing, and
      // never be closed by anything.
      await this.#failStart(runId, error);
      // `dispatch_refused` is the executor saying "there is nothing to run
      // this on" — a worker that never became resident, a closed pipe. That is
      // a different incident from an adapter that broke, and a host that cannot
      // tell them apart retries the wrong one.
      throw new RunStartError(
        error instanceof ExecutionDispatchError ? 'dispatch_refused' : 'dispatch_threw',
        error,
      );
    }
    active.handle = handle;
    this.#armWallClockBudget(active);

    return this.#handleFor(active);
  }

  /**
   * Arm the wallclock ceiling, if the run has one.
   *
   * A wallclock budget is the one ceiling that CANNOT be checked before the
   * operation it limits: nothing about "the run has been going four minutes"
   * is knowable until four minutes have gone. So a timer is the only honest
   * mechanism, and the timer calls the SAME stop path a user cancel uses. A
   * separate "budget shutdown" would be a second stop path, which the plan
   * forbids and which would make the escalation story depend on who noticed.
   *
   * `unref` where the runtime offers it, because a pending timer is a pending
   * timer in a process that wants to exit.
   */
  #armWallClockBudget(active: ActiveRun): void {
    const ceiling = active.manifest.budget.maxWallClockMs;
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return;
    const timer = setTimeout(() => {
      active.wallClockTimer = null;
      // Floating, with a catch. `cancel` settles the run on its own, so a
      // failure here is a failure to close a run that is out of time, and that
      // must not become an unhandled rejection in a process nobody is watching.
      // The executor's own stream ending still closes it; this only makes the
      // close happen at the deadline instead of whenever the worker next
      // reports something.
      void this.cancel(active.session.runId, { reason: 'budget', cancelReason: 'budget' }).catch(
        () => undefined,
      );
    }, ceiling);
    if (typeof timer.unref === 'function') timer.unref();
    active.wallClockTimer = timer;
  }

  /**
   * Close out a run whose dispatch threw.
   *
   * Synthesises the `run.failed` the executor will never send, so the settle
   * path has a terminal to record rather than a silence to interpret. The
   * verdict itself is still `resolveRunOutcome`'s.
   */
  async #failStart(runId: string, cause: unknown): Promise<void> {
    const active = this.#runs.get(runId);
    if (active === undefined) return;
    try {
      active.session.observe({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: 'the execution channel refused to start the run',
          cause: { system: 'runtime', code: 'dispatch_failed', detail: describe(cause) },
        },
      });
    } catch {
      // The ledger refused the failure event, which means a terminal was
      // already recorded. The settle below still has something to write.
    }
    await this.settle(runId);
  }

  /**
   * Not implemented in this slice, and it says so.
   *
   * `resume` needs a replay window and a verifiable manifest match, and the
   * Reference Run establishes the durable log that both read from. A resume
   * that accepted a manifest without comparing fingerprints would be the
   * "silently different run" failure the protocol was written to prevent, so
   * the honest state is "not yet" rather than a resume that does not check.
   */
  async resume(): Promise<RunHandle> {
    throw new Error(
      'run.resume is not implemented: the Reference Run establishes the durable run log; ' +
        'resume lands once a replay window and a manifest fingerprint check are in place.',
    );
  }

  async probe(): Promise<RuntimeCapabilities> {
    return this.capabilities;
  }

  /** The live run for an id, if any. The router resolves a session to its run
   *  through this while a chat turn is in flight. */
  activeRun(runId: string): RunSession | undefined {
    return this.#runs.get(runId)?.session;
  }

  /** Runs this controller is still holding open. Zero once everything settled. */
  get liveRuns(): number {
    return this.#runs.size;
  }

  /** Ended runs this controller can still answer for. Bounded by `receiptLimit`. */
  get retainedReceipts(): number {
    return this.#receipts.size;
  }

  /**
   * The terminal an ended run reached, or `null` for a run this controller
   * never opened.
   *
   * The in-memory half of the receipt the contract keeps queryable. The
   * durable half is the `runs` row, and it outlives this map — this answers
   * for the host still holding a handle, and says nothing about runs older
   * than the retention window.
   */
  receiptFor(runId: string): RunTerminalState | null {
    return this.#receipts.get(runId) ?? null;
  }

  /**
   * Observe one raw frame from the executor.
   *
   * Returns what the caller should forward and what the run recorded. Never
   * throws for a malformed frame: a bad frame is a fact about the stream, and
   * a run that dies because one frame was malformed would be a run that never
   * records what actually went wrong.
   */
  observeFrame(runId: string, raw: RawFrame): FrameOutcome {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      // A run that is gone is one of two things, and a host debugging a stuck
      // turn needs to tell them apart: it already ended, or it never opened.
      // Before this, both returned the same silent no-op.
      return {
        legacy: null,
        envelope: null,
        forwardOnly: false,
        internal: false,
        ...(this.#receipts.has(runId)
          ? { late: true }
          : { late: false, unknown: true }),
      };
    }

    const translated = translateFrame(raw, active.translateCtx);
    if (!translated.ok) {
      const internal = translated.reason === 'internal';
      return { legacy: null, envelope: null, forwardOnly: !internal, internal };
    }

    try {
      const envelope = active.session.observe(translated.event);
      active.stream.push(envelope);
      // The check runs on EVERY event, not only the ones that spend something:
      // `assistant.usage` is the only place a token ceiling can be seen, and it
      // arrives as an ordinary event. One call, evaluated by the same code that
      // decides the verdict at settle, so the two cannot disagree about whether
      // the run is over budget.
      this.#enforceBudget(active, translated.event.type);
      return { legacy: projectToLegacyFrame(envelope), envelope, forwardOnly: false, internal: false };
    } catch (error) {
      if (!(error instanceof LifecycleViolation)) throw error;
      return this.#onLifecycleViolation(active, error);
    }
  }

  /**
   * Settle a run.
   *
   * Idempotent: a second call returns the first decision, whether it arrives
   * while the first is still in flight or long after it finished. A caller that
   * settles twice has a bug, and the correct behaviour is to leave the recorded
   * history alone.
   *
   * Every path out of here returns a terminal the run actually produced. A run
   * id this controller has no record of is not a success, so it reports
   * `run_not_found` — a host that counted it as `completed` would be inflating
   * its own success metrics with a run it never opened.
   */
  async settle(
    runId: string,
    intent?: { cancelRequested?: boolean; escalated?: boolean; requestedReason?: string },
  ): Promise<RunTerminalState> {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      // An ended run reports what it reached. Returning `run_not_found` here
      // would make every post-hoc `settle` — the router's `res.on('close')`
      // backstop included — claim the run never existed.
      return this.#receipts.get(runId) ?? absentRun(runId);
    }
    if (active.settling !== null) return active.settling;

    // The wallclock timer dies with the run it was watching. Cleared HERE,
    // before the settlement promise exists, because a ceiling that outlives its
    // run fires a stop at an executor belonging to somebody else's turn.
    if (active.wallClockTimer !== null) {
      clearTimeout(active.wallClockTimer);
      active.wallClockTimer = null;
    }

    active.settling = (async () => {
      const merged =
        intent === undefined
          ? active.cancelRequested
            ? { cancelRequested: true }
            : undefined
          : { ...intent, ...(active.cancelRequested ? { cancelRequested: true } : {}) };
      const terminal = await active.session.settle(merged);
      active.stream.close();
      return terminal;
    })();

    const terminal = await active.settling;
    this.#runs.delete(runId);
    this.#remember(runId, terminal);
    return terminal;
  }

  /**
   * Keep what a run decided, up to the retention limit.
   *
   * `Map` preserves insertion order, so the first key is the oldest receipt
   * and evicting it evicts the right one without a second structure.
   */
  #remember(runId: string, terminal: RunTerminalState): void {
    const limit = this.#options.receiptLimit ?? 64;
    this.#receipts.delete(runId);
    this.#receipts.set(runId, terminal);
    while (this.#receipts.size > limit) {
      const oldest = this.#receipts.keys().next();
      if (oldest.done === true) return;
      this.#receipts.delete(oldest.value);
    }
  }

  /**
   * Cancel a run.
   *
   * The ONE worker-stop path, and R2.3 changed three things about it without
   * adding a second one.
   *
   *  1. **The stop is awaited, and bounded.** `handle.stop` used to be
   *     `Promise<void>` over a host interrupt that is fire-and-forget, so this
   *     returned before the grace window had opened. It now races the
   *     executor's own acknowledgement against {@link RunControllerOptions.stopBoundMs},
   *     so a cancel always produces an answer. A stop that is never answered is
   *     reported as `escalated`, because "we stopped waiting" is not "it stopped
   *     cleanly".
   *  2. **The disposition reaches the terminal.** An escalation now produces
   *     `failed` / `runtime_crash` with `escalated: true` and the requested
   *     reason, which is what `resolveRunOutcome` has always said an escalation
   *     means. Before this, nothing produced `escalated`, so a killed worker was
   *     recorded as the clean cancellation it failed to be.
   *  3. **The budget stops the run too.** A ceiling reached mid-flight calls
   *     this same method with `reason: 'budget'`.
   *
   * Every terminal candidate still goes through the one-shot `settle`, which is
   * contract §D's serial arbiter, and `resolveRunOutcome` still owns the
   * cancellation-vs-completion rule.
   *
   * Returns `applied: false` for a run that had already reached a terminal, and
   * does nothing in that case, so a host can tell "I cancelled this" from "it
   * had already ended".
   */
  async cancel(
    runId: string,
    opts?: { reason?: string; cancelReason?: CancelReason; graceMs?: number },
  ): Promise<CancelOutcome> {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      const receipt = this.#receipts.get(runId);
      // A run this controller opened and then ended still gets `requested:
      // true`: the ask DID reach a run, and the caller is entitled to the
      // terminal it reached rather than a "no such run". Only an id this
      // controller has never heard of reports `requested: false`, because there
      // was nothing to ask.
      return receipt === undefined
        ? { requested: false, applied: false, terminal: absentRun(runId) }
        : { requested: true, applied: false, terminal: receipt };
    }
    if (active.session.isClosed) {
      // Already terminal. `requested` stays TRUE: the ask did reach a run, and
      // the pair (requested, applied) is what lets a caller tell three cases
      // apart — nothing was live, the run had already ended, or the stop
      // landed. Only the first reports `requested: false`. Collapsing "already
      // ended" into "nothing was live" is the ambiguity `applied` exists to
      // remove, and it would put it straight back.
      //
      // No disposition: no stop was issued, and inventing one would put a
      // disposition in the record for a kill that never happened.
      return { requested: true, applied: false, terminal: active.session.terminal ?? absentRun(runId) };
    }
    active.cancelRequested = true;
    const reason = opts?.reason ?? String(opts?.cancelReason ?? 'user');
    // Close the run's open permission prompts BEFORE the stop, and with the
    // reason that is about to be recorded on the run. A prompt that outlives
    // the run it belongs to is answerable by anyone, and its answer lands on
    // whatever the recycled worker is doing next.
    this.#options.permissionCloser?.(runId, `run cancelled: ${reason}`);
    const receipt = await this.#stop(active, {
      graceMs: opts?.graceMs ?? this.#options.cancelGraceMs ?? 5000,
      reason,
    });
    // `stop` is a window, not an instant: a worker that was already finishing
    // can reach its own terminal inside it. `isClosed` is re-read HERE, after
    // the await, because checking it before is what let a cancel report
    // `applied: true` while handing back a terminal it had no part in — and
    // `applied` is the one field a host reads to know its stop did something.
    if (active.session.isClosed) {
      return {
        requested: true,
        applied: false,
        disposition: receipt.disposition,
        terminal: active.session.terminal ?? absentRun(runId),
      };
    }
    const terminal = await this.settle(runId, {
      cancelRequested: true,
      // The escalation is the caller's only evidence that the clean-cancel path
      // was NOT honoured. Passing it through is what stops a kill from being
      // recorded as a cancellation that worked.
      escalated: receipt.disposition === 'escalated',
      requestedReason: reason,
    });
    return { requested: true, applied: true, disposition: receipt.disposition, terminal };
  }

  /**
   * Ask the executor to stop, once, and never wait forever.
   *
   * Shared by every producer — a user cancel, a budget ceiling, a wallclock
   * timer — because "one interrupt" is a property of the RUN, not of whoever
   * happened to ask first. Two producers in the same window would otherwise
   * send two `chat:interrupt` commands, and the worker's own handling of a
   * second interrupt (clearing its command queue) is a different behaviour from
   * the first.
   */
  async #stop(active: ActiveRun, request: StopRequest): Promise<StopReceipt> {
    active.stopping ??= this.#stopOnce(active, request);
    return active.stopping;
  }

  async #stopOnce(active: ActiveRun, request: StopRequest): Promise<StopReceipt> {
    const handle = active.handle;
    if (handle === null) {
      // Nothing was dispatched, or the dispatch is still in flight. There is no
      // executor to stop, and claiming otherwise would put a cooperative
      // disposition on a stop that touched nothing.
      return { requested: false, disposition: 'unavailable', waitedMs: 0, reason: request.reason };
    }
    // Resolved once, the same way `start` resolves it: an optional clock is a
    // test seam, and reading it as possibly-undefined at three call sites is how
    // one of them ends up skipped.
    const clock = this.#options.clock ?? Date.now;
    const startedAt = clock();
    const boundMs = this.#options.stopBoundMs ?? (request.graceMs + 2000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const disposition = await Promise.race([
        handle.stop(request).then((receipt) => receipt.disposition),
        new Promise<'escalated'>((resolve) => {
          timer = setTimeout(() => resolve('escalated'), boundMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return {
        requested: true,
        disposition,
        waitedMs: clock() - startedAt,
        reason: request.reason,
      };
    } catch (error) {
      // A stop that THROWS is not a stop that worked, and it is not a stop that
      // left no evidence either. The only supportable claim is that the clean
      // path is unproven, which is what `escalated` means.
      return {
        requested: true,
        disposition: 'escalated',
        waitedMs: clock() - startedAt,
        reason: `${request.reason}: ${describe(error)}`,
      };
    } finally {
      // The bound is released on every exit, including the race going to the
      // executor. A timer left pending here is a live handle for the rest of
      // the process, and `run-cancel-budget.test.ts` asserts the cleanup
      // rather than trusting it.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Stop the run when a budget ceiling has been crossed.
   *
   * ## What this can and cannot preempt
   *
   * This is the *runtime-side* half of a budget check, and it is honest about
   * its reach. The runtime observes `turn.started` and `tool.call_started` when
   * the frames come BACK, so by the time it can act, the model request that
   * spent the turn has already been dispatched. What this guarantees is that
   * the run STOPS the moment its own accounting crosses a ceiling, so no
   * further turn or tool call is admitted — and, on the worker side, that the
   * second model request is never dispatched at all.
   *
   * The pre-dispatch half is the manifest's ceiling travelling to the executor
   * (see the Desktop adapter), because the executor is the only component that
   * knows it is about to make a request. A check that only ran here would be a
   * receipt, not a budget.
   *
   * A terminal event EXEMPTS the run. A turn that finishes and then reports
   * `run.completed` while over its ceiling needs no stop — the executor has
   * already left, and interrupting it now would put a `chat:interrupt` on a
   * worker that has nothing left to interrupt. The verdict still comes out
   * `budget_exhausted`, because `resolveRunOutcome` evaluates the ceiling at
   * settle; what is skipped is the pointless stop, not the accounting.
   */
  #enforceBudget(active: ActiveRun, eventType?: EventType): void {
    if (active.session.isClosed || active.cancelRequested) return;
    if (eventType === 'run.completed' || eventType === 'run.failed') return;
    if (!active.session.budgetVerdict().exhausted) return;
    void this.cancel(active.session.runId, { reason: 'budget', cancelReason: 'budget' }).catch(
      () => undefined,
    );
  }

  /**
   * Turn a lifecycle violation into the run's terminal state.
   *
   * Deliberately not re-thrown. The ledger throws because continuing to
   * interpret a broken stream produces confidently wrong derived state — and
   * the right response is to STOP interpreting it, which settling does. The
   * violation is preserved as the failure's `cause`, so the durable log says
   * exactly which rule broke.
   */
  #onLifecycleViolation(active: ActiveRun, violation: LifecycleViolation): FrameOutcome {
    if (active.session.isClosed) {
      // The run is decided and this frame arrived after it. `late` is set here
      // as well as on the "no such run" branch, because a frame can land in the
      // window where the run has been closed but not yet dropped from the map —
      // and a host watching for late frames must not see a gap in the middle of
      // its own race.
      return { legacy: null, envelope: null, forwardOnly: false, internal: false, violation: violation.code, late: true };
    }
    let envelope: RunEventEnvelope;
    try {
      envelope = active.session.observe({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: `run lifecycle violated: ${violation.detail}`,
          cause: { system: 'runtime', code: violation.code },
        },
      });
    } catch {
      // The ledger refused the failure event too — which means a terminal
      // event was already recorded. Nothing further can be appended.
      return { legacy: null, envelope: null, forwardOnly: false, internal: false, violation: violation.code };
    }
    active.stream.push(envelope);
    void this.settle(active.session.runId).catch(() => undefined);
    const legacy = projectToLegacyFrame(envelope);
    return { legacy, envelope, forwardOnly: false, internal: false, violation: violation.code };
  }

  #handleFor(active: ActiveRun): RunHandle {
    const controller = this;
    const session = active.session;
    const manifest = active.manifest;
    return {
      runId: session.runId,
      sessionId: session.sessionId,
      manifest,
      terminal: session.terminal$,
      events(): EventSource {
        return active.stream;
      },
      async respondToPermission(
        requestId: string,
        decision: PermissionResponse,
      ): Promise<PermissionAck> {
        // The answer goes to the Control Plane's decision path, which records
        // it durably and then delivers it to the worker. The runtime holds no
        // approval state of its own, so this delegation IS the round trip —
        // there is no second path for a host to accidentally use.
        const responder = controller.#options.permissionResponder;
        if (!responder) {
          return {
            accepted: false,
            reason: 'not_permission_action',
          };
        }
        return responder({ runId: session.runId, requestId, response: decision });
      },
      async cancel(reason?: CancelReason, opts?: { graceMs?: number; reason?: string }): Promise<CancelOutcome> {
        return controller.cancel(session.runId, {
          ...(opts?.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
          ...(opts?.reason === undefined && reason === undefined
            ? {}
            : { reason: opts?.reason ?? String(reason) }),
        });
      },
      async pause(): Promise<void> {
        throw new Error('run.pause is gated on replay, which this runtime does not advertise');
      },
      async result(): Promise<RunResult> {
        return session.result();
      },
    };
  }
}

/**
 * The terminal for a run this controller holds no record of.
 *
 * `run_not_found` rather than `completed`. "There is no such run" is a fact,
 * and it is not the same fact as "the run finished" — a host that settles an
 * unknown id and is handed `completed` has been told a success for a run it
 * never opened, which is precisely the accounting error `CancelOutcome.applied`
 * exists to prevent on the other side of this call.
 */
function absentRun(runId: string): RunTerminalState {
  return {
    status: 'failed',
    error: {
      code: 'run_not_found',
      message: `no live run ${runId} is known to this runtime`,
    },
  };
}

/** A cause, as one diagnostic line. Never the payload it carried. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every event type the runtime can emit. Closed set, by construction. */
export function runtimeEventTypes(): readonly EventType[] {
  return EVENT_REGISTRY.all;
}
