/**
 * One run's state: identity, sequence, events, and the terminal decision.
 *
 * ## Why the ledger is not re-implemented here
 *
 * `@duya/agent-protocol` exports `RunLedger`, which is the
 * specification of what a legal run stream is: gapless run-scoped `seq` from
 * 1, exactly one terminal event, a tool result with no invocation rejected, a
 * permission resolution for a request nobody saw rejected. Those rules are
 * already written once and already tested.
 *
 * Re-deriving them here would be the exact failure `run-ledger.ts`'s header
 * warns about — "writing the rules twice, once in prose and once in each host,
 * is how they diverge". So this class OWNS the ledger and adds only what the
 * protocol cannot know: where durable events go, and how the terminal state
 * reaches storage.
 *
 * ## The `seq` namespace
 *
 * The ledger mints `seq` per RUN, starting at 1, gapless. This is deliberate
 * and it is the one place the Reference Run knowingly diverges from today's
 * wire: the router's SSE `id:` resets per POST while `session.lastEventId` is
 * per-session, so a second turn re-issues ids the first turn already used
 * (`envelope.ts:14-35`, GAPS G-8). The run log is therefore keyed on
 * `(runId, seq)` and is correct from the first run, while the SSE `id:` is left
 * exactly as it was so the renderer is untouched. The wire defect stays a
 * separate, separately-fixable item instead of being inherited into storage.
 */

import type {
  ControlFrame,
  EventSource,
  MeasuredTokens,
  PermissionAuditEntry,
  RunBudget,
  RunEvent,
  RunEventEnvelope,
  RunMetrics,
  RunResult,
  RunSurface,
  RunTerminalState,
  WireEnvelope,
} from '@duya/agent-protocol';
import { EVENT_REGISTRY, RunLedger, isTerminal, type LifecycleViolation } from '@duya/agent-protocol';
import {
  countEvent,
  emptyCounters,
  isBudgetExhausted,
  resolveRunOutcome,
  type BudgetVerdict,
  type RunEventCounters,
  type RunSpend,
} from '@duya/agent-core';

/** Where a run's durable events go. Supplied by the Control Plane. */
export interface RunPersistence {
  /** Append durable envelopes. Resolves once they are durable. */
  append(envelopes: readonly RunEventEnvelope[]): Promise<void>;
  /** Record the one-shot terminal decision plus the run's metrics. */
  complete(terminal: RunTerminalState, metrics: RunMetrics): Promise<void>;
}

/**
 * ## Why this port has exactly two methods, and why that decides R1.2 item 2
 *
 * Contract §C allows a terminal to be committed two ways: append-ack the
 * terminal EVENT and then write the terminal ROW, or hold one SQLite
 * transaction across the terminal event and the CAS. **This port chooses the
 * first, and the choice is made here rather than in an adapter on purpose.**
 *
 * The transaction form is a property of the ADAPTER. An adapter that can hold a
 * transaction open decides when the terminal event and the row become
 * durable together; an adapter that cannot (the in-memory one every test uses,
 * and the forked agent-server reaching the Control Plane over `db:request`)
 * does not. So picking the transaction form would mean the two adapters in this
 * repository commit terminals by different rules — exactly the cross-adapter
 * divergence the plan forbids (02-run-correctness.md §R1.2: pick one of the two
 * orderings, and do not let adapters diverge quietly), reached by a
 * legitimate-looking code path.
 *
 * The rejected alternative, read under a crash between the two writes:
 *
 *   - **append-ack then complete (chosen).** The terminal EVENT is durable and
 *     the ROW is still `running`. The decided terminal is in the log, so a
 *     reconciler can find it and close the row. The evidence of the decision
 *     survives the crash.
 *   - **one transaction.** Neither write landed. The row says `running` and
 *     there is no terminal event to contradict it, so the only supportable
 *     reading is "this run did not finish", and the one thing the runtime
 *     knew — how it did finish — is gone.
 *
 * The first failure mode is recoverable and the second is not, and only the
 * first is expressible over a two-call cross-process port. So `settle` does the
 * first, for every adapter, and `RunPersistence` is not given a third method
 * that would let one of them do otherwise.
 */

/**
 * Reads a run's stored events back.
 *
 * ## Why this is not a third method on `RunPersistence`
 *
 * That port has exactly two methods for a reason stated above: a third would let
 * an adapter pick its own ordering for committing a terminal, and the two
 * adapters in this repository would then commit terminals by different rules.
 * A READ cannot do that — it never writes, so it cannot reorder a commit — and
 * folding it in anyway would extend the port to fix a problem it does not have
 * while weakening the guarantee that is actually load-bearing.
 *
 * ## Why it is OPTIONAL
 *
 * Because reading a run back is a capability an adapter may genuinely lack, and
 * "this adapter cannot read runs" is a different answer from "this run has no
 * events". An absent reader is reported as `unsupported`, never as an empty
 * transcript. See `RunResult.transcript`.
 */
export interface RunTranscriptReader {
  /** The run's durable and volatile events, in `seq` order. */
  readTranscript(runId: string): Promise<readonly RunEventEnvelope[]>;
}

/** One batch awaiting acknowledgement, and what it has already cost. */
interface PendingBatch {
  readonly envelopes: readonly RunEventEnvelope[];
  /** Append attempts made so far, including the first. */
  attempts: number;
}

export interface RunSessionOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId?: string;
  /** Stamps every envelope. A deterministic run substitutes a virtual clock. */
  readonly now: () => number;
  readonly startedAt: number;
  /** Wall-clock reading, for budget ceilings and metrics. */
  readonly clock: () => number;
  readonly persistence: RunPersistence;
  /**
   * The run's ceilings, decided by the Control Plane.
   *
   * A runtime that chose its own budget would let an agent raise its own
   * limits, so the numbers arrive from the manifest and the measurement lives
   * in `@duya/agent-core`.
   */
  readonly budget?: RunBudget;
  /**
   * Overrides budget evaluation entirely, for a policy the shared measurement
   * cannot express (a per-provider cost ceiling, a tenant quota).
   */
  readonly budgetBreached?: (spend: RunSpend, wallClockMs: number) => boolean;
  /**
   * Batching size for durable appends.
   *
   * Not an optimisation knob: a text answer produces one durable block per
   * assistant message, and a tool-heavy turn produces a `call_started` /
   * `call_completed` pair per call. Flushing per event would turn every tool
   * call into a round trip to the Control Plane across a process boundary.
   * The terminal event always flushes, so batching can never delay the end of
   * a run.
   */
  readonly flushEvery?: number;
  /**
   * How many times a refused batch is re-offered before it is given up on.
   *
   * Bounded on purpose. A batch is either still in the queue or it is not, so
   * an unbounded retry is not a retry at all — it is a livelock that also holds
   * every unsent event of a long run in memory for as long as it lasts. The
   * default of 2 covers the failure this is actually for (a Control Plane that
   * was momentarily unreachable) without covering one that is not (a database
   * that is gone).
   *
   * A batch that exhausts its budget is DROPPED, and the drop is what turns
   * the run's verdict into `persistence_failed` — see `#lostBatch`. The
   * alternative, keeping a batch nobody will ever write, would leave the run
   * claiming a transcript it does not have.
   */
  readonly appendRetries?: number;
  /**
   * Awaits `ms` before a refused batch is re-offered.
   *
   * ## Why this is injected rather than reached for
   *
   * Retry timing is the whole content of a backoff, and `setTimeout` is the one
   * way to write a test that cannot observe it: a real timer makes the only
   * available assertions "it eventually succeeded" and "it took at least
   * roughly this long", the second of which is a coin flip on a loaded CI box.
   * A function that waits means a test can substitute a counter, assert the
   * EXACT schedule the runtime chose, and finish instantly — which is how the
   * ladder in `#backoff` is pinned at all.
   *
   * The default is a real timer, so production behaviour is unchanged. Nothing
   * else in this class reads a timer directly; a bare `setTimeout` in the retry
   * path would put the schedule back out of reach of a test.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * The most wall-clock time the write path may add in retry backoff, summed
   * over every refusal in this run.
   *
   * ## Why a second bound when `appendRetries` already bounds the loop
   *
   * `appendRetries` bounds the ATTEMPTS and this bounds the TIME, and they are
   * not the same bound. The attempt ladder is exponential, so the same attempt
   * count is 75ms at the default and 30s at `appendRetries: 12` — and
   * `settle` awaits the write queue before it publishes a terminal, so that
   * difference is added directly to how long a finished run takes to report
   * itself finished. A bound expressed in attempts cannot see that; one in
   * milliseconds can.
   *
   * ## How this relates to `stopBoundMs`
   *
   * They bound different things and must not be confused. `stopBoundMs` is the
   * runtime's promise to the CALLER about the EXECUTOR: "you will get an answer
   * about stopping in this long". This is the write path's promise to itself,
   * and it is spent only after the stop has already been answered, because
   * `cancel` waits for the executor's own disposition before it settles. So the
   * backoff can delay the PUBLICATION of a terminal, never the ANSWER to a
   * cancel, and the default is two orders of magnitude below the default stop
   * bound for exactly that reason.
   *
   * Once the budget is spent the remaining retries proceed immediately. They
   * are still bounded by `appendRetries`, and a retry that is going to be
   * dropped anyway is better spent discovering that sooner.
   */
  readonly appendBackoffBudgetMs?: number;
  /**
   * Reads the run's stored events back for `result().transcript`.
   *
   * Absent — which is the case for every adapter in this repository today — and
   * the transcript is reported `unsupported` rather than empty. See
   * {@link RunTranscriptReader}.
   */
  readonly transcriptReader?: RunTranscriptReader;
}

export interface ObserveResult {
  readonly envelope: RunEventEnvelope;
  /** True when the event was buffered for persistence. */
  readonly buffered: boolean;
}

/**
 * The live state of one run.
 *
 * A session is created when the Control Plane opens a run and dies with it. It
 * holds no cross-run state by construction: a session outlives its runs, and a
 * resumed run is a NEW run with a NEW `runId` and its own `seq` from 1.
 */
export class RunSession {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;

  readonly #ledger: RunLedger;
  readonly #options: RunSessionOptions;
  readonly #buffer: RunEventEnvelope[] = [];
  readonly #terminalEvents: RunEvent[] = [];
  #counters: RunEventCounters = emptyCounters();
  #spend: RunSpend = { turns: 0, toolCalls: 0, tokens: 0 };
  #terminal: RunTerminalState | null = null;
  #closed = false;
  /**
   * The in-flight settlement, so concurrent settles share ONE barrier pass.
   *
   * Not a second decision cache — `#terminal` is that. This exists because the
   * decision is no longer published the moment it is made, so two callers
   * racing to settle would otherwise both append and both complete.
   */
  #settling: Promise<RunTerminalState> | null = null;
  /**
   * THE WRITE QUEUE. One per run, head first, in the order the events were
   * observed.
   *
   * A batch lands here before it is offered, and leaves only when storage has
   * acknowledged it or the run has given up on it. It used to be a local in
   * `#flushBatch`: the batch was spliced out of the buffer, handed to
   * `persistence.append`, and if that refused, gone. Every refusal was a
   * permanent, silent deletion of a run's events, and the fire-and-forget
   * flush inside `observe` had nobody to report it to.
   */
  #queue: PendingBatch[] = [];
  /**
   * The tail of the write queue. Every batch is handed to the persistence in
   * observation order, and `flush()` awaits this chain rather than only the
   * batches still sitting in the buffer — so a caller that awaits one flush
   * also waits for every batch still in flight behind it, retries included.
   */
  #flushChain: Promise<void> = Promise.resolve();
  /**
   * The first batch that was given up on, kept so a later settle can report
   * the run as degraded instead of completed.
   *
   * Set ONLY when a batch is actually lost, never on a refusal that a retry
   * then wrote. A run that recovered from a busy database did not lose its
   * transcript, and degrading it would report a failure that never happened.
   */
  #lostBatch: unknown = null;
  #lostEvents = 0;
  #lostBatches = 0;
  /**
   * Milliseconds of backoff this run has already spent, across every refusal.
   *
   * The write path's own bound, and the reason it is counted here rather than
   * per batch: the budget is a property of the RUN, so a run with nine refused
   * batches on nine different batches has spent nine delays' worth and gets
   * nine delays' worth of budget. Counting per batch would let a run multiply
   * its own bound by the number of batches it happened to have.
   */
  #backoffSpentMs = 0;
  /**
   * Every permission decision this run recorded, in the order it was resolved.
   *
   * ## Why this is retained at all when the transcript is not
   *
   * Because the two have different costs and different purposes. The transcript
   * is unbounded — every envelope of a long run, for the life of the handle —
   * and the durable copy already exists in `run_events`, so retaining it here
   * would be a second source of truth with a shorter lifetime. A permission
   * audit is one entry per approval, which a run asks for in the presence of a
   * human, and it is the surface whose whole value is that a consumer can trust
   * it without a second round trip.
   *
   * Bounded by the number of permission requests the run made, and a run that
   * makes a million of them has a million of them in storage too. This is
   * collected in-process from the events the session already observes, so it is
   * a real read and not a promise about a read that has not happened — and its
   * COMPLETENESS is checked against {@link #permissionRequests} before it is
   * reported as an audit rather than a fragment of one.
   */
  readonly #permissionAudit: PermissionAuditEntry[] = [];
  /**
   * Permission requests this run made, and so the number of decisions an audit
   * of it would have to contain.
   *
   * The counter is what lets the audit be honest about its own completeness.
   * Nothing in this runtime emits `permission.resolved` — the Control Plane
   * census names a producer that does not exist, and the only permission port
   * here (`permissionResponder`) delegates the decision to the host rather than
   * recording one — so a run that asks for approval and gets no resolution back
   * is the NORMAL case today, not a broken one. Reporting its audit as an empty
   * list would be the same lie this surface type exists to remove, one level
   * down: "no activity" reported for a run that had an activity and no record
   * of it. See `#permissionAuditSurface`.
   */
  #permissionRequests = 0;
  /**
   * Whether any `assistant.usage` event was observed.
   *
   * The difference between a measured token total and an absent one. A run that
   * emitted no usage event has not been shown to have spent zero tokens; it has
   * been shown to have reported nothing, and those are different facts with
   * different consequences for whoever is billed. See `MeasuredTokens`.
   */
  #usageObserved = false;
  /**
   * When each in-flight tool call started, on the wall clock.
   *
   * Only for the calls that have not closed, and only so a dangling call can
   * report a MEASURED duration when it is closed as unknown. See `observe`.
   */
  readonly #toolStartedAt = new Map<string, number>();
  readonly #terminalPromise: Promise<RunTerminalState>;
  #resolveTerminal!: (state: RunTerminalState) => void;
  /** The receipt. Built once, handed out by identity to every reader. */
  #resultPromise: Promise<RunResult> | null = null;

  constructor(options: RunSessionOptions) {
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.traceId = options.traceId ?? `trace-${options.runId}`;
    this.#options = options;
    this.#ledger = new RunLedger({
      runId: this.runId,
      sessionId: this.sessionId,
      traceId: this.traceId,
      now: options.now,
    });
    this.#terminalPromise = new Promise<RunTerminalState>((resolve) => {
      this.#resolveTerminal = resolve;
    });
  }

  /** The run's last minted sequence number. */
  get seq(): number {
    return this.#ledger.seq;
  }

  /** The one-shot terminal state, or `null` while the run is live. */
  get terminal(): RunTerminalState | null {
    return this.#terminal;
  }

  /** Resolves exactly once, when the run ends — for any reason. */
  get terminal$(): Promise<RunTerminalState> {
    return this.#terminalPromise;
  }

  get counters(): RunEventCounters {
    return this.#counters;
  }

  get spend(): RunSpend {
    return this.#spend;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Batches still waiting to be acknowledged.
   *
   * A run that has given up on its storage reports zero here rather than
   * holding every event it ever produced, which is the difference between a
   * controller that is busy and one that grows for the life of the process.
   */
  get pendingWrites(): number {
    return this.#queue.length;
  }

  /** Events that were offered to storage and never acknowledged, ever. */
  get lostEvents(): number {
    return this.#lostEvents;
  }

  /** Batches given up on. Diagnostics; `lostEvents` is the number that counts. */
  get lostBatches(): number {
    return this.#lostBatches;
  }

  /**
   * Append one event to the run.
   *
   * @throws {LifecycleViolation} when the event breaks a run invariant. The
   *   throw is deliberate and matches the ledger: a run that has already
   *   violated an invariant is not one whose remaining events can be
   *   interpreted, so continuing would produce confidently wrong state. The
   *   caller turns this into `run.failed` rather than swallowing it.
   */
  observe(event: RunEvent): RunEventEnvelope {
    const envelope = this.#ledger.emit(event, this.#options.now());
    this.#counters = countEvent(this.#counters, event);
    this.#spend = accumulate(event, this.#spend);
    // Stamped here rather than at settle time, because the interval this
    // produces is the call's OWN duration and settle time is not it. Bounded by
    // the number of tool calls a run makes, and dropped as soon as the call is
    // closed, so it cannot become a per-run memory leak.
    if (event.type === 'tool.call_started') {
      this.#toolStartedAt.set(event.toolCallId, this.#options.clock());
    } else if (event.type === 'tool.call_completed' || event.type === 'tool.timed_out') {
      this.#toolStartedAt.delete(event.toolCallId);
    }

    if (event.type === 'run.completed' || event.type === 'run.failed') {
      this.#terminalEvents.push(event);
    }
    // The audit is folded from `permission.resolved` and not from
    // `permission.requested`, because the resolution is the decision. A request
    // that expired, timed out, or was closed by a cancellation still resolves,
    // and an audit built from requests alone would report an approval the run
    // never recorded an answer for.
    if (event.type === 'permission.requested') this.#permissionRequests += 1;
    if (event.type === 'permission.resolved') {
      this.#permissionAudit.push({
        requestId: event.requestId,
        action: event.action,
        source: event.source,
        latencyMs: event.latencyMs,
        ...(event.scope === undefined ? {} : { scopeKind: event.scope.kind }),
      });
    }
    if (event.type === 'assistant.usage') this.#usageObserved = true;
    if (EVENT_REGISTRY.specOf(event.type)?.durability === 'durable') {
      this.#buffer.push(envelope);
      // `run.started` flushes IMMEDIATELY, on its own, ahead of the batch.
      //
      // It is the one event whose value is "this run existed before anything
      // happened", and batching it behind up to `flushEvery` later events means
      // a run that crashes on its first frame loses exactly the record that
      // would explain the crash. Every other durable event can be reconstructed
      // from what follows it; this one cannot.
      if (event.type === 'run.started' || this.#buffer.length >= (this.#options.flushEvery ?? 16)) {
        // Observed frames must never block on a cross-process write, so this
        // is not awaited. It is also no longer a place where a batch can be
        // lost: the batch is on the run's write queue before the flush starts,
        // so a refusal is re-offered from there rather than dropped where it
        // stood. The catch keeps the floating promise from surfacing as an
        // unhandled rejection — the refusal itself is not lost with it, and
        // `settle` reads `#lostBatch` to report the run as degraded.
        void this.flush().catch(() => undefined);
      }
    }
    return envelope;
  }

  /**
   * Settle the run.
   *
   * The decision is delegated to `@duya/agent-core`'s `resolveRunOutcome`, so
   * the rules about cancellation-vs-completion and silence-vs-completion live
   * in exactly one place and this class cannot drift from them.
   *
   * One-shot: a second call returns the first decision and does nothing, and
   * concurrent callers share the in-flight pass. A caller that settles twice
   * has a bug, and the correct behaviour is to leave the recorded history
   * alone.
   *
   * ## The decision and its publication are two steps
   *
   * The decision may be made in memory at any time, but it is NOT published
   * until the durable barrier has been acknowledged. So the order is:
   * decide → flush every batch → write the terminal row → publish. A host
   * waiting on `terminal$` therefore cannot observe a run as finished while
   * its last event is still in flight, and a barrier that fails can still
   * change the answer: the run reports an explicit `persistence_failed`
   * terminal rather than the `completed` it decided in memory.
   */
  async settle(intent?: {
    cancelRequested?: boolean;
    escalated?: boolean;
    requestedReason?: string;
  }): Promise<RunTerminalState> {
    if (this.#terminal !== null) return this.#terminal;
    if (this.#settling !== null) return this.#settling;

    this.#settling = this.#settleOnce(intent);
    return this.#settling;
  }

  async #settleOnce(intent?: {
    cancelRequested?: boolean;
    escalated?: boolean;
    requestedReason?: string;
  }): Promise<RunTerminalState> {
    const wallClockMs = this.#options.clock() - this.#options.startedAt;
    // Before the verdict, not after it: a dangling tool call is a fact about the
    // run's transcript, and a terminal that contradicts it is a transcript
    // nobody can trust. `observe` throws only if a terminal event already
    // exists, and this runs before `#synthesizeTerminalEvent` can create one.
    this.#closeDanglingTools(intent?.requestedReason ?? 'no stop was requested');
    const decided = resolveRunOutcome(this.#terminalEvents, {
      ...(intent === undefined ? {} : { intent }),
      budgetExhausted: this.budgetVerdict(wallClockMs).exhausted,
    });

    // An exit that produced no terminal EVENT still has to produce one.
    // Contract §C: an executor that exits with no terminal state, a failed
    // dispatch, or a hard kill must all synthesise an explicit terminal EVENT.
    // Writing the terminal ROW without the event left the durable log of a
    // crashed run ending mid-answer with nothing saying how it ended, and a row
    // whose `running` status was the only trace of it. The verdict comes from
    // `resolveRunOutcome` as always; this only gives it a log.
    this.#synthesizeTerminalEvent(decided);

    let terminal = decided;
    let transcriptLost = false;
    try {
      // Flush before completing: a terminal decision recorded with its events
      // still sitting in a buffer is a run whose last word is missing. The
      // batch that `observe` already spliced out is covered too — `#flushChain`
      // is the tail of every append this run has made, not just the buffered
      // ones, so a batch still in flight cannot overtake this terminal row.
      await this.flush();
      if (this.#lostBatch !== null) {
        transcriptLost = true;
        throw this.#lostBatch;
      }
      await this.#options.persistence.complete(decided, this.#metrics(wallClockMs));
    } catch (error) {
      terminal = degradedTerminal(error);
      // A run whose transcript has a hole is the one case where the row is
      // worth rewriting even though the barrier failed. Left alone it stays
      // `running` forever, which is indistinguishable from a run that is still
      // executing and that nothing will ever close — the exact row R1.1 left
      // behind. This is best effort by construction: if the row cannot be
      // written either, the degraded terminal is what the host is told, and
      // the run stays a `running` row, which is R1.3's DB-fault state to
      // reconcile. Only the APPEND failure lands here; a `complete` that failed
      // on its own is deliberately not retried, because a refusal there is
      // most often a lost CAS and the row already holds another writer's
      // terminal.
      if (transcriptLost) {
        try {
          await this.#options.persistence.complete(terminal, this.#metrics(wallClockMs));
        } catch {
          // Nothing further to try. The host already has the degraded receipt.
        }
      }
    }

    this.#terminal = terminal;
    this.#closed = true;
    this.#resolveTerminal(terminal);
    return terminal;
  }

  /**
   * Give a verdict that no event described an event of its own.
   *
   * Only ever called before a terminal event exists, so the ledger accepts it;
   * a run that already emitted one keeps the one the executor produced, and the
   * terminal it carries stays the single source of the verdict.
   */
  #synthesizeTerminalEvent(decided: RunTerminalState): void {
    if (this.#terminalEvents.length > 0) return;
    if (decided.status === 'failed') {
      this.observe({ type: 'run.failed', error: decided.error });
      return;
    }
    this.observe({
      type: 'run.completed',
      status: decided.status,
      ...(decided.stopReason === undefined ? {} : { stopReason: decided.stopReason }),
      // The verdict was cancelled, not completed. Recording it as a plain
      // completion would drop the only distinction between "the model finished"
      // and "the host stopped it" from the durable log.
      ...(decided.status === 'cancelled' ? { cancelRequested: true } : {}),
    });
  }

  /**
   * Flush every batch this run still owes storage.
   *
   * Waits for the batches already in flight AND for its own, including the
   * retries of any that were refused earlier. Safe to call more than once; a
   * call with nothing to write is a resolved promise, not a skipped one.
   */
  flush(): Promise<void> {
    const pass = this.#flushChain.then(
      () => this.#drain(),
      () => this.#drain(),
    );
    // The chain continues past a failure on purpose. A refused batch is
    // re-offered from the queue rather than by re-running the chain from the
    // top, so one dead batch cannot wedge every batch behind it forever.
    this.#flushChain = pass;
    return pass;
  }

  /**
   * Offer the write queue to storage, head first, until it is empty or stuck.
   *
   * Terminates because every iteration either removes a batch or spends one of
   * that batch's retries, and both are finite — which is what "bounded" means
   * here, and what keeps a permanently broken database from becoming an
   * infinite loop that also retains the run's whole event stream.
   */
  async #drain(): Promise<void> {
    const maxAttempts = 1 + (this.#options.appendRetries ?? 2);
    for (;;) {
      if (this.#queue.length === 0 && this.#buffer.length > 0) {
        this.#queue.push({
          envelopes: this.#buffer.splice(0, this.#buffer.length),
          attempts: 0,
        });
      }
      const batch = this.#queue[0];
      if (batch === undefined) return;

      try {
        await this.#options.persistence.append(batch.envelopes);
        this.#queue.shift();
        return;
      } catch (error) {
        batch.attempts += 1;
        if (batch.attempts >= maxAttempts) {
          this.#queue.shift();
          this.#lostBatch ??= error;
          this.#lostBatches += 1;
          this.#lostEvents += batch.envelopes.length;
          // Keep going. One lost batch does not excuse losing the rest of the
          // run's transcript as well, and the next batch may well succeed.
          continue;
        }
        // Retry the same batch, in place, inside this same pass. Re-offering
        // the SAME seqs matters: `(runId, seq)` is the storage identity, so a
        // retry is idempotent and a re-minted seq would be a second event.
        await this.#backoff(batch.attempts);
        continue;
      }
    }
  }

  /**
   * Wait before re-offering a refused batch.
   *
   * `attempt` is the number of attempts ALREADY made, so the first refusal waits
   * the base delay and each refusal after it doubles, capped.
   *
   * ## The schedule, and why it is this one
   *
   * Doubling from 25ms. The failure this is for is transient and named: a
   * Control Plane that was momentarily unreachable, or a storage handle that was
   * momentarily busy. Both clear in milliseconds, so a retry after 25ms finds a
   * healthy store and the run continues as though nothing had happened — which
   * is the outcome `appendRetries` was already assuming when it re-offered the
   * batch immediately. What it is NOT for is a store that is gone, because no
   * amount of waiting distinguishes one from the other: the attempt count still
   * ends the loop, and a backoff must never be the reason a lost batch takes
   * seconds to be admitted as lost. The delay exists to stop a busy store being
   * hammered, not to keep trying a dead one.
   *
   * Capped at {@link APPEND_BACKOFF_MAX_MS} so the tail of a long ladder cannot
   * escape {@link RunSessionOptions.appendBackoffBudgetMs}, and the budget is
   * subtracted from rather than checked against, so a run cannot overshoot it by
   * the size of the last delay it asked for.
   */
  async #backoff(attempt: number): Promise<void> {
    const wanted = Math.min(APPEND_BACKOFF_BASE_MS * 2 ** (attempt - 1), APPEND_BACKOFF_MAX_MS);
    const budgetMs = this.#options.appendBackoffBudgetMs ?? APPEND_BACKOFF_BUDGET_MS;
    const waitMs = Math.min(wanted, Math.max(0, budgetMs - this.#backoffSpentMs));
    this.#backoffSpentMs += waitMs;
    if (waitMs <= 0) return;
    await (this.#options.delay ?? realDelay)(waitMs);
  }

  /**
   * The run's result, once it has ended.
   *
   * A READ. It waits on the same completion promise every other reader uses and
   * never settles the run: settling here would mean a host that asked "what
   * happened?" decided the answer, and an executor still streaming would be
   * recorded as a success it never reached. If the run has not ended, this
   * promise stays pending — which is the truth, and the caller's cue to keep
   * waiting.
   *
   * ## What it does and does not carry
   *
   * The two surfaces are answered from different places, and the difference is
   * the point rather than an accident:
   *
   *  - `permissionAudit` is decided by what the run actually did — see
   *    {@link RunSession.#permissionAuditSurface}. A run that asked for nothing
   *    reports `read` with no entries, which is a real measurement; a run that
   *    asked and was not answered reports `unsupported` rather than an empty
   *    list standing in for the missing decision.
   *  - `transcript` is `unsupported` unless a {@link RunTranscriptReader} was
   *    supplied. The session deliberately does not retain envelopes (see the
   *    class header), so with no reader there is nothing to hand back, and an
   *    empty array would be claiming a run produced no events when the truth is
   *    that this runtime does not read them.
   *
   * ONE receipt, built once and handed back by identity. Every reader shares
   * this promise, so a second call cannot report a different `wallClockMs` for
   * a run that stopped changing when its terminal was published. A receipt that
   * varies between reads is not a receipt.
   */
  result(): Promise<RunResult> {
    this.#resultPromise ??= this.#buildResult();
    return this.#resultPromise;
  }

  async #buildResult(): Promise<RunResult> {
    const terminal = await this.#terminalPromise;
    const wallClockMs = this.#options.clock() - this.#options.startedAt;
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      status: terminal.status,
      ...(terminal.status === 'failed' ? { error: terminal.error } : {}),
      ...(terminal.status !== 'failed' && terminal.stopReason !== undefined
        ? { stopReason: terminal.stopReason }
        : {}),
      metrics: this.#metrics(wallClockMs),
      transcript: await this.#transcript(),
      permissionAudit: this.#permissionAuditSurface(),
      budgetUsed: {
        turns: this.#spend.turns,
        toolCalls: this.#spend.toolCalls,
        tokens: this.#tokenCount(),
      },
    };
  }

  /**
   * The permission audit, or the statement that this run's cannot be completed.
   *
   * ## How "no permission activity" is told apart from "no audit here"
   *
   * By EVIDENCE IN THE RUN, not by a capability flag a host sets and can get
   * wrong. A flag would have to be declared in advance of the run and trusted
   * afterwards; a count cannot be. Three cases, and the consumer narrows on the
   * one that is true:
   *
   *  - **The run asked for nothing.** `read` with no entries. This is the strong
   *    claim and it is available: there was no permission activity, so there is
   *    nothing the audit could be hiding.
   *  - **The run asked, and every request was decided.** `read` with one entry
   *    per decision. The audit is complete and real.
   *  - **The run asked, and a request has no decision.** `unsupported`. The run
   *    HAD an approval and this runtime did not record its answer, so the
   *    entries it does hold are a partial list and calling that list the audit
   *    would tell a reviewer a run was fully accounted for when the one request
   *    that mattered is missing. The reason carries both numbers so the gap is
   *    legible without re-deriving it.
   *
   * The third case is the live one: nothing in this runtime emits
   * `permission.resolved`, so any run that raises a prompt lands there today.
   * It is reported rather than smoothed over, which is the point — the moment a
   * producer is wired this flips to `read` on its own, with no flag to flip
   * alongside it.
   */
  #permissionAuditSurface(): RunSurface<PermissionAuditEntry> {
    if (this.#permissionRequests > this.#permissionAudit.length) {
      return {
        state: 'unsupported',
        reason:
          `this run made ${this.#permissionRequests} permission request(s) and recorded ${this.#permissionAudit.length} decision(s), so this runtime cannot produce a complete permission audit; an empty list here would read as "nothing was asked"`,
      };
    }
    return { state: 'read', entries: [...this.#permissionAudit] };
  }

  /**
   * The run's events, or the statement that this runtime does not read them.
   *
   * A read that FAILS is reported `unsupported` rather than as an empty
   * transcript. It is not as precise as it could be — a store that refused a
   * read is not the same as a store that cannot be read — but the alternative is
   * the one thing this type exists to prevent: handing a consumer `[]` and
   * letting it conclude the run produced nothing. The `reason` names the
   * failure, so the two cases stay tellable apart.
   */
  async #transcript(): Promise<RunSurface<RunEventEnvelope>> {
    const reader = this.#options.transcriptReader;
    if (reader === undefined) {
      return {
        state: 'unsupported',
        reason:
          'this runtime does not retain a run\'s envelopes and no transcript reader was supplied, so the transcript was not read back; this is an absent capability, not an empty run',
      };
    }
    try {
      return { state: 'read', entries: await reader.readTranscript(this.runId) };
    } catch (error) {
      return { state: 'unsupported', reason: `reading the transcript back failed: ${describe(error)}` };
    }
  }

  /**
   * The run's token total, or the statement that it was never measured.
   *
   * The measured case is reached only after an `assistant.usage` event, so
   * `measured: true` with `total: 0` is a true statement (a provider reported
   * zero) and is not the same value as the other arm. See {@link MeasuredTokens}
   * for why a nullable would not have been enough.
   */
  #tokenCount(): MeasuredTokens {
    if (this.#usageObserved) return { measured: true, total: this.#spend.tokens };
    return {
      measured: false,
      reason:
        'no assistant.usage event was observed, so this runtime cannot say what the run spent on tokens; it is not claiming the run spent none',
    };
  }

  /**
   * Whether the run exhausted its budget, right now.
   *
   * PUBLIC, and the reason is R2.3. It used to be a private method called only
   * from `settle`, which made it a verdict machine: it decided what a finished
   * run should be recorded as, and could not stop anything. Contract §D asks for
   * the check BEFORE the next turn or tool call, and the component that knows
   * the run's spend is this one.
   *
   * So the measurement is exposed rather than duplicated. A second copy in the
   * controller would be a second place for the counting rules to drift, and
   * `run-budget.ts`'s header says exactly why that is not allowed.
   *
   * A custom `budgetBreached` wins, so a host can enforce a policy the shared
   * measurement cannot express. Otherwise the manifest's own budget is measured
   * here. A run with no budget is never exhausted, which is the correct reading
   * of "no ceiling was set" rather than "every ceiling is zero".
   */
  budgetVerdict(wallClockMs?: number): BudgetVerdict {
    const elapsed = wallClockMs ?? this.#options.clock() - this.#options.startedAt;
    const custom = this.#options.budgetBreached;
    if (custom !== undefined) return hostPolicyVerdict(custom(this.#spend, elapsed));
    const budget = this.#options.budget;
    if (budget === undefined) return hostPolicyVerdict(false);
    return isBudgetExhausted(budget, this.#spend, elapsed);
  }

  /**
   * Tool calls that started and never reported an outcome.
   *
   * Read by the settle path to close the transcript honestly. See
   * {@link RunLedger.danglingToolCalls} for why the ledger tracks them instead
   * of rejecting them.
   */
  danglingToolCalls(): readonly string[] {
    return this.#ledger.danglingToolCalls();
  }

  /**
   * Give every unanswered tool call an explicit, UNKNOWN completion.
   *
   * Contract §D: a tool that was running when the run ended either completes
   * correctly or is marked unknown, and the side-effect reconciliation is D7.
   *
   * `indeterminate` rather than `cancelled` is the load-bearing choice. A
   * `cancelled` outcome is a claim that the call did not finish, and a call that
   * did not finish is not the same as a call that had no effect: a half-written
   * file, a request already on the wire, a payment already submitted. Recording
   * `cancelled` would tell every downstream reader — the cost dashboard, the
   * transcript, D7's eventual reconciler — that nothing happened. A kill is not
   * an undo, and this is the place that would otherwise quietly claim it was.
   */
  #closeDanglingTools(reason: string): void {
    const now = this.#options.clock();
    for (const toolCallId of this.danglingToolCalls()) {
      const startedAt = this.#toolStartedAt.get(toolCallId);
      this.observe({
        type: 'tool.call_completed',
        toolCallId,
        // Empty, and deliberately so. There is no result, and a synthesised
        // string here would be a fabricated answer to a question the run never
        // got back. The `outcome` below is the part that carries the meaning.
        content: '',
        // Measured, not defaulted: the interval from the call's own start event
        // to the terminal is a fact about how long the run waited, and it is the
        // only honest value available for a call that never returned.
        durationMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
        outcome: {
          outcome: 'indeterminate',
          // The id is IN the note, not only beside it. Whoever reconciles this
          // in D7 may be reading the note alone, from a log line, and a note
          // that only says "a call" cannot be joined to anything.
          note: `${toolCallId}: no result was observed before the run ended (${reason}); whether this call's side effects landed is unknown`,
        },
      });
    }
  }

  #metrics(wallClockMs: number): RunMetrics {
    return {
      eventsTotal: this.#counters.total,
      eventsDurable: this.#counters.durable,
      eventsVolatile: this.#counters.volatile,
      eventsEphemeral: this.#counters.ephemeral,
      toolCalls: this.#counters.toolCalls,
      permissionRequests: this.#counters.permissionRequests,
      wallClockMs,
    };
  }
}

/**
 * The first retry wait, and the multiplier for every one after it.
 *
 * See {@link RunSession.#backoff} for why the ladder exists and why it stops
 * being the thing that bounds the write path.
 */
const APPEND_BACKOFF_BASE_MS = 25;

/** Ceiling on any single backoff wait, so a long ladder cannot escape the budget. */
const APPEND_BACKOFF_MAX_MS = 250;

/**
 * The default total backoff a run may spend on its write path.
 *
 * Deliberately far below the default `stopBoundMs` (a grace window plus two
 * seconds). The two are not comparable — one bounds an executor's answer and
 * this bounds a queue's — but a write-path wait that could approach the stop
 * bound would make a cancel's answer depend on how busy storage happened to be,
 * and that is the interaction the two bounds exist to prevent.
 */
const APPEND_BACKOFF_BUDGET_MS = 500;

/**
 * The production delay: a real timer.
 *
 * The default behind {@link RunSessionOptions.delay}, and the ONLY place in this
 * class that reads a timer. Unref'd so a delay still outstanding cannot hold the
 * process open after the run it belonged to is gone — the same reasoning
 * `controller.ts` applies to the stop bound, and the same reason the timer is
 * released on every path out of the race that created it.
 */
function realDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * The terminal a run reports when its durable barrier was never acknowledged.
 *
 * `persistence_failed`, not `completed` and not a silent success: the run's
 * work may well have finished, but this runtime cannot show that any of it
 * reached storage, and a host that counts this as a success is counting a run
 * whose record it does not have. The run is over either way, so this replaces
 * the decision rather than opening a second one.
 */
function degradedTerminal(cause: unknown): RunTerminalState {
  return {
    status: 'failed',
    error: {
      code: 'persistence_failed',
      message: 'the run ended, but its durable events were not acknowledged',
      details: { durability: 'degraded', reason: describe(cause) },
    },
  };
}

/**
 * A host policy's yes/no answer, shaped as a verdict.
 *
 * `budgetBreached` is a boolean hook and `BudgetVerdict` is a shaped answer, so
 * a host that says "yes" without naming the ceiling it crossed would leave a
 * caller able to report nothing more informative than "over budget". The
 * `breaches` list stays empty for a host policy: inventing the crossed ceiling
 * from a hook that never named one is the same fabrication as a guessed token
 * count, and an empty list is a true statement about what the hook said.
 */
function hostPolicyVerdict(exhausted: boolean): BudgetVerdict {
  return { exhausted, breaches: [] };
}

/** A cause, as one diagnostic line. Never the payload it carried. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Fold one event into the spend.
 *
 * Turn and tool-call counting rules live in `@duya/agent-core`; this is the
 * incremental form of the same fold, for a run that is already streaming and
 * cannot afford to re-walk its history at the end.
 */
function accumulate(event: RunEvent, spend: RunSpend): RunSpend {
  switch (event.type) {
    case 'turn.started':
      return { ...spend, turns: spend.turns + 1 };
    case 'tool.call_started':
      return { ...spend, toolCalls: spend.toolCalls + 1 };
    case 'assistant.usage': {
      const total = event.usage.totalTokens;
      const resolved =
        typeof total === 'number' && Number.isFinite(total)
          ? total
          : event.usage.inputTokens + event.usage.outputTokens;
      return { ...spend, tokens: spend.tokens + resolved };
    }
    default:
      return spend;
  }
}

/**
 * An in-memory `EventSource` over a run's envelopes.
 *
 * Implements the protocol's `EventSource` so a host can consume a run the same
 * way whether the runtime is in-process or across HTTP. The buffer is bounded:
 * an unbounded queue under a slow consumer is a memory leak with a latency bug
 * attached, and a run that outruns its reader is a run the persistence layer
 * has already recorded.
 */
export class RunEventStream implements EventSource {
  readonly #queue: WireEnvelope[] = [];
  readonly #waiters: Array<(value: IteratorResult<WireEnvelope>) => void> = [];
  #closed = false;
  readonly #limit: number;

  constructor(limit = 1024) {
    this.#limit = limit;
  }

  push(envelope: RunEventEnvelope): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.#limit) this.#queue.shift();
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: envelope, done: false });
    else this.#queue.push(envelope);
  }

  close(_frame?: ControlFrame): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0, this.#waiters.length)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WireEnvelope> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<WireEnvelope>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (result.done === true) return;
      yield result.value;
    }
  }
}

export { isTerminal, type LifecycleViolation };
