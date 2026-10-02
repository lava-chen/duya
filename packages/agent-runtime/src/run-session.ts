/**
 * One run's state: identity, sequence, events, and the terminal decision.
 *
 * ## Why the ledger is not re-implemented here
 *
 * `@duya/agent-protocol/testing` exports `RunLedger`, which is the
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
  RunBudget,
  RunEvent,
  RunEventEnvelope,
  RunMetrics,
  RunResult,
  RunTerminalState,
  WireEnvelope,
} from '@duya/agent-protocol';
import { EVENT_REGISTRY, isTerminal } from '@duya/agent-protocol';
// The ledger is the protocol's own specification of a legal run stream. It
// lives under the `/testing` subpath by design — depending on it is a
// deliberate act, and this is that act.
import { RunLedger, type LifecycleViolation } from '@duya/agent-protocol/testing';
import {
  countEvent,
  emptyCounters,
  isBudgetExhausted,
  resolveRunOutcome,
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
  readonly #terminalPromise: Promise<RunTerminalState>;
  #resolveTerminal!: (state: RunTerminalState) => void;

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

    if (event.type === 'run.completed' || event.type === 'run.failed') {
      this.#terminalEvents.push(event);
    }
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
        void this.flush();
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
   * One-shot: a second call returns the first decision and does nothing. A
   * caller that settles twice has a bug, and the correct behaviour is to leave
   * the recorded history alone.
   */
  async settle(intent?: {
    cancelRequested?: boolean;
    escalated?: boolean;
  }): Promise<RunTerminalState> {
    if (this.#terminal !== null) return this.#terminal;

    const wallClockMs = this.#options.clock() - this.#options.startedAt;
    const state = resolveRunOutcome(this.#terminalEvents, {
      ...(intent === undefined ? {} : { intent }),
      budgetExhausted: this.#budgetVerdict(wallClockMs),
    });

    this.#terminal = state;
    this.#resolveTerminal(state);

    // Flush before completing: a terminal decision recorded with its events
    // still sitting in a buffer is a run whose last word is missing.
    await this.flush();
    await this.#options.persistence.complete(state, this.#metrics(wallClockMs));
    this.#closed = true;
    return state;
  }

  /** Flush any buffered durable events. Safe to call more than once. */
  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0, this.#buffer.length);
    await this.#options.persistence.append(batch);
  }

  /**
   * The run's result, once it has ended.
   *
   * `transcript` is empty by design in this slice. Filling it would mean the
   * session retained every envelope for the life of the handle, and the durable
   * copy already exists in `run_events` — the transcript is what a future
   * replay window will read back, and building it in memory first would be a
   * second source of truth with a shorter lifetime.
   */
  async result(): Promise<RunResult> {
    const terminal = this.#terminal ?? (await this.settle());
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
      transcript: [],
      permissionAudit: [],
      budgetUsed: {
        turns: this.#spend.turns,
        toolCalls: this.#spend.toolCalls,
        tokens: this.#spend.tokens,
      },
    };
  }

  /**
   * Whether the run exhausted its budget.
   *
   * A custom `budgetBreached` wins, so a host can enforce a policy the shared
   * measurement cannot express. Otherwise the manifest's own budget is
   * measured here. A run with no budget is never exhausted — which is the
   * correct reading of "no ceiling was set", not "every ceiling is zero".
   */
  #budgetVerdict(wallClockMs: number): boolean {
    const custom = this.#options.budgetBreached;
    if (custom !== undefined) return custom(this.#spend, wallClockMs);
    const budget = this.#options.budget;
    if (budget === undefined) return false;
    return isBudgetExhausted(budget, this.#spend, wallClockMs).exhausted;
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
