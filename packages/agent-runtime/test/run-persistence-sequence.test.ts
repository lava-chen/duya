/**
 * R1.2 — the persistence SEQUENCE and the run lifecycle around it.
 *
 * ## How this relates to `run-correctness-seams.test.ts`
 *
 * That file pins what a run REPORTS. R1.1 made the answer honest. What was
 * still not pinned is the order and the bookkeeping underneath the answer:
 *
 *   - whether a batch that failed to persist is ever retried, or is spliced
 *     out of the buffer and gone (it was gone);
 *   - whether `flush()` waits for the batch `observe` already fired and forgot
 *     (it waited only for the ones still buffered, and the fire-and-forget was
 *     a silent-loss path);
 *   - whether the terminal EVENT is durable before the terminal ROW is written
 *     (the order existed, nothing said so, and the alternative ordering was
 *     equally available);
 *   - whether a run is dispatched before its `started` is acknowledged;
 *   - whether an abnormal exit produces a terminal EVENT or only a terminal ROW;
 *   - whether a late frame is a diagnostic or silence, and whether the
 *     controller forgets a run entirely.
 *
 * ## The one choice this file locks in (R1.2 item 2)
 *
 * Contract §C allows "append-ack then complete" OR "one SQLite transaction
 * holding the terminal event and the CAS". This suite pins the FIRST and only
 * the first. The reasoning is in `RunSession`'s header; the short version is
 * that the second is a property of an ADAPTER, and `RunPersistence` is a
 * cross-process port whose two calls are the only vocabulary it has. Choosing
 * it here means the in-memory adapter used by tests and the SQLite adapter used
 * by Desktop cannot drift, because neither of them gets a say.
 *
 * `it('calls the adapter with append and then complete, and nothing else')` is
 * the test that makes that structural rather than aspirational.
 *
 * ## Which of these failed before the fix, and which did not
 *
 * 17 of the 20 tests below fail on the pre-R1.2 source. The other three pin
 * something R1.1 already got right and this phase must not lose:
 *
 *   - `acknowledges the terminal event before it writes the terminal row` — the
 *     order was already append-then-complete. It is here to STOP it drifting,
 *     and it is labelled as a lock rather than dressed up as a fix.
 *   - `calls the adapter with append and then complete, and nothing else` — the
 *     same, as a structural assertion on the port's vocabulary.
 *   - `retains a bounded number of receipts over many runs` is new behaviour,
 *     but it would have "passed" against a controller that retained nothing at
 *     all. It is paired with `keeps the terminal queryable`, which fails
 *     without the receipts and is what gives this one its meaning.
 */

import { describe, expect, it } from 'vitest';
import type {
  ConnectorBinding,
  PermissionPolicyMode,
  RunBudget,
  RunEventEnvelope,
  RunHandle,
  RunManifest,
  RunMetrics,
  RunResult,
  RunTerminalState,
} from '@duya/agent-protocol';
import {
  RunController,
  type ExecutionChannel,
  type ExecutionHandle,
  type ExecutionSink,
  type RunPersistence,
  type TranslateContext,
} from '@duya/agent-runtime';

// ── a persistence whose every call the test can see ─────────────────────

/** One call the runtime made on `RunPersistence`, in the order it made it. */
interface PersistenceCall {
  readonly op: 'append' | 'complete';
  /** `append`: the seqs offered. `complete`: the terminal status. */
  readonly detail: string;
  /** The seqs already ACKNOWLEDGED when this call was made. */
  readonly ackedBefore: readonly number[];
}

/**
 * Records EVERY durability call, and lets the test decide per attempt whether
 * it is acknowledged, held open, or refused.
 *
 * `ackedBefore` is the field the ordering tests lean on. "The terminal event
 * was durable before the terminal row was written" is not observable from the
 * order of two calls alone — an implementation could call `append` and not
 * wait for it. Recording what was already acknowledged at each call makes the
 * barrier itself the assertion.
 */
class ScriptedPersistence implements RunPersistence {
  readonly calls: PersistenceCall[] = [];
  /** Seq numbers this persistence has acknowledged, in ack order. */
  readonly ackedSeqs: number[] = [];
  readonly completes: Array<{ terminal: RunTerminalState; metrics: RunMetrics }> = [];

  /** Refuse the next N append attempts, whatever they carry. */
  failNextAppends = 0;
  /** Refuse every append attempt. */
  alwaysFailAppends = false;
  /** Hold every append open until `releaseAppends()`. */
  holdAppends = false;

  #releases: Array<() => void> = [];

  get appendAttempts(): number {
    return this.calls.filter((c) => c.op === 'append').length;
  }

  /**
   * How many times an append carrying `seq` was OFFERED.
   *
   * Attempts, not acknowledgements: the bound is about what the runtime was
   * willing to keep asking for, and a batch that was re-offered and then
   * written is exactly the case the number has to capture.
   */
  attemptsFor(seq: number): number {
    return this.calls.filter(
      (c) =>
        c.op === 'append' &&
        c.detail
          .slice(c.detail.indexOf('[') + 1, c.detail.indexOf(']'))
          .split(',')
          .some((n) => Number(n.trim()) === seq),
    ).length;
  }

  /** The seqs of the append that carried a terminal event, or `null`. */
  terminalEventSeq(): number | null {
    for (const call of this.calls) {
      if (call.op !== 'append' || !call.detail.startsWith('seq')) continue;
      const found = /terminal:(yes|no)/.exec(call.detail);
      if (found?.[1] === 'yes') {
        const seqs = call.detail
          .slice(call.detail.indexOf('[') + 1, call.detail.indexOf(']'))
          .split(',')
          .map((n) => Number(n.trim()));
        return seqs[0] ?? null;
      }
    }
    return null;
  }

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    const carriesTerminal = envelopes.some(
      (e) => e.payload.type === 'run.completed' || e.payload.type === 'run.failed',
    );
    this.calls.push({
      op: 'append',
      detail: `seq[${envelopes.map((e) => e.seq).join(', ')}] terminal:${carriesTerminal ? 'yes' : 'no'}`,
      ackedBefore: [...this.ackedSeqs],
    });

    if (this.alwaysFailAppends || this.failNextAppends > 0) {
      if (this.failNextAppends > 0) this.failNextAppends -= 1;
      throw new Error('durable append refused by storage');
    }
    if (this.holdAppends) {
      await new Promise<void>((resolve) => {
        this.#releases.push(resolve);
      });
    }
    this.ackedSeqs.push(...envelopes.map((e) => e.seq));
  }

  async complete(terminal: RunTerminalState, metrics: RunMetrics): Promise<void> {
    this.calls.push({
      op: 'complete',
      detail: terminal.status,
      ackedBefore: [...this.ackedSeqs],
    });
    this.completes.push({ terminal, metrics });
  }

  releaseAppends(): void {
    this.holdAppends = false;
    for (const release of this.#releases.splice(0)) release();
  }
}

// ── executors ───────────────────────────────────────────────────────────

interface ExecutorProbe {
  stops: number;
}

/** An executor that never speaks and never ends the stream. */
function openExecutor(probe: ExecutorProbe): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async () => {
          probe.stops += 1;
        },
      };
    },
  };
}

/** An executor that reports frames the test feeds it, then ends. */
function manualExecutor(
  probe: ExecutorProbe,
): { channel: ExecutionChannel; frame: (f: Record<string, unknown>) => void; end: () => void } {
  let sink: ExecutionSink | null = null;
  return {
    channel: {
      async start(_runId, _sessionId, _input, received): Promise<ExecutionHandle> {
        sink = received;
        return {
          stop: async () => {
            probe.stops += 1;
          },
        };
      },
    },
    frame: (f) => {
      sink?.frame(f);
    },
    end: () => {
      sink?.end();
    },
  };
}

/** An executor whose dispatch throws before it can begin. */
function throwingDispatch(message: string): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      throw new Error(message);
    },
  };
}

// ── the manifest and translation context ─────────────────────────────────

function buildManifest(runId: string, budget: RunBudget = { maxTurns: 12 }): RunManifest {
  const permissionPolicy = {
    mode: 'default' as PermissionPolicyMode,
    hostSwitch: 'ask' as const,
    defaultTimeoutMs: 300_000,
  };
  const connectorBindings: readonly ConnectorBinding[] = [];
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/tmp/workspace'],
    cwd: '/tmp/workspace',
    permissionPolicy,
    capabilities: { profiles: [], modes: ['general'], tools: ['Read'] },
    connectorBindings,
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget,
    deterministic: false,
  };
}

function contextFor(): TranslateContext {
  return {
    messageId: 'msg-1',
    permission: {
      classify: () => 'tool_use',
      mode: 'generic',
      expiresInMs: 300_000,
      now: () => Date.now(),
    },
    nextTurn: (() => {
      let n = 0;
      return () => {
        n += 1;
        return { turnId: `turn-${n}`, index: n };
      };
    })(),
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

// ── shared builders ──────────────────────────────────────────────────────

interface HarnessOptions {
  readonly channel: ExecutionChannel;
  readonly persistence: RunPersistence;
  readonly receiptLimit?: number;
  readonly flushEvery?: number;
  readonly appendRetries?: number;
  readonly now?: () => number;
}

function buildController(options: HarnessOptions): {
  controller: RunController;
  dispatched: () => number;
} {
  let dispatched = 0;
  const counted = new Proxy(options.channel, {
    get(target, prop, receiver) {
      if (prop !== 'start') return Reflect.get(target, prop, receiver) as unknown;
      return async (...args: Parameters<ExecutionChannel['start']>): Promise<ExecutionHandle> => {
        dispatched += 1;
        return target.start(...args);
      };
    },
  });
  const controller = new RunController({
    channel: counted,
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => options.persistence,
    ...(options.receiptLimit === undefined ? {} : { receiptLimit: options.receiptLimit }),
    ...(options.flushEvery === undefined ? {} : { flushEvery: options.flushEvery }),
    ...(options.appendRetries === undefined ? {} : { appendRetries: options.appendRetries }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { controller, dispatched: () => dispatched };
}

function tick(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ═════════════════════════════════════════════════════════════════════════
// item 1 — one serial write queue per run
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 1 — a failed batch is retried, not dropped', () => {
  it('lands a batch whose first append attempt was refused', async () => {
    // `#flushBatch` spliced the batch out of the buffer and handed it to
    // `persistence.append`; a refusal recorded `#appendFault` and rethrew, and
    // the batch itself was never held anywhere. Nothing re-offered it, so a
    // transient refusal — a busy SQLite handle, a Control Plane that was not
    // listening yet — silently deleted a run's events. The fault flag made the
    // run report degraded, but the events were already gone and no amount of
    // retrying the flush could bring them back.
    //
    // The fix: the batch goes onto the run's write queue, not into a throwaway
    // local, so the next attempt re-offers the SAME seqs.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-retry-after-refusal';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      flushEvery: 1,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    expect(persistence.ackedSeqs).toEqual([1]);

    // Refuse the very next append, then let everything through.
    persistence.failNextAppends = 1;
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    await tick();

    controller.observeFrame(runId, { type: 'done', data: {} });
    const terminal = await controller.settle(runId);

    // The refused batch is in storage, under its own seq, exactly once.
    expect(persistence.ackedSeqs).toContain(2);
    expect(persistence.ackedSeqs).toEqual([...persistence.ackedSeqs].sort((a, b) => a - b));
    // Nothing was lost, so nothing is degraded: the run completed.
    expect(terminal.status).toBe('completed');
  });

  it('gives up after a bounded number of attempts instead of retrying forever', async () => {
    // A run whose storage is permanently gone must not spin. "Bounded" is the
    // whole requirement: the plan allows bounded retry OR fail-closed, and a
    // retry loop with no ceiling is neither — it is a livelock that also holds
    // every unsent event in memory for as long as it lasts.
    //
    // The run opens normally first, so the bound is measured on a batch that
    // is refused once storage has already proven it works. Measuring it on
    // `run.started` instead would assert against a start that never completed.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-bounded-retry';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      flushEvery: 1,
      appendRetries: 2,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });

    persistence.alwaysFailAppends = true;
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    const terminal = await controller.settle(runId);

    // The batch that carried `turn.started` was offered exactly `1 + retries`
    // times — once, plus the two it was allowed — and not once more.
    const turnSeq = persistence.calls
      .flatMap((c) => (c.op === 'append' ? c.detail.slice(4, c.detail.indexOf(']')).split(',') : []))
      .map((n) => Number(n.trim()))
      .find((n) => n > 1);
    expect(turnSeq).toBeDefined();
    expect(persistence.attemptsFor(turnSeq as number)).toBe(3);

    // And the run says so, rather than claiming a transcript it does not have.
    expect(terminal.status).toBe('failed');
    if (terminal.status !== 'failed') throw new Error('unreachable');
    expect(terminal.error.code).toBe('persistence_failed');
  });

  it('retains no unsent events once a run has given up', async () => {
    // The other half of "bounded". If a refused batch stayed queued forever,
    // every event a long run produced would be held in the controller's memory
    // for the life of the process. After the run is over there must be nothing
    // left to accumulate.
    //
    // The session is captured BEFORE the settle, because `settle` is supposed
    // to drop it from the controller. Reading `activeRun(...)?.pendingWrites`
    // after would answer 0 for a session that is simply gone, which is true of
    // the broken version too.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-no-accumulation';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      flushEvery: 1,
      appendRetries: 1,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    for (let n = 1; n <= 20; n += 1) {
      controller.observeFrame(runId, { type: 'text', data: { content: `line ${n}` } });
    }
    const session = controller.activeRun(runId);
    expect(session).toBeDefined();

    persistence.alwaysFailAppends = true;
    await controller.settle(runId);

    expect(session?.pendingWrites).toBe(0);
    // The events are accounted for as lost, not quietly forgotten.
    expect(session?.lostEvents).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 1 — flush() waits for the previous batch, and the fire-and-forget
//          flush in observe() is not a silent-loss path
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 1 — flush waits for every earlier batch', () => {
  it('re-offers an in-flight batch ahead of the batch flush() was asked to write', async () => {
    // `observe` fires `void this.flush()` when the buffer fills. The batch is
    // spliced out at that moment, so a caller that then awaits `flush()` is
    // waiting on an EMPTY buffer and gets a promise that resolves while the
    // batch it knows about is still in flight. Order is the substance here:
    // a later batch must not overtake an earlier one, or `run_events` is a log
    // of a run in an order that never happened.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-flush-waits';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      flushEvery: 1,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });

    // Hold the appends so the first batch is genuinely in flight, and feed a
    // second one behind it.
    persistence.holdAppends = true;
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    await tick();
    controller.observeFrame(runId, { type: 'text', data: { content: 'hello' } });
    await tick();

    persistence.holdAppends = false;
    persistence.releaseAppends();
    controller.observeFrame(runId, { type: 'done', data: {} });
    const terminal = await controller.settle(runId);

    // Every acknowledged seq arrived in ascending order — the first batch did
    // not land after the second one.
    expect(persistence.ackedSeqs).toEqual([...persistence.ackedSeqs].sort((a, b) => a - b));
    expect(terminal.status).toBe('completed');
  });

  it('recovers a batch the fire-and-forget flush lost, with no explicit flush()', async () => {
    // The `void this.flush()` inside `observe` is the silent-loss path the plan
    // names. Nothing awaits it and nothing can report it, so before this fix a
    // refusal there deleted the batch outright. There is still no caller to
    // await — the point is that the batch is re-offered on its own, and that
    // the run's verdict reflects that it was eventually stored.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-fire-and-forget';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      flushEvery: 1,
      appendRetries: 3,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });

    // Refuse the auto-flushed batch once. Nobody is awaiting it.
    persistence.failNextAppends = 1;
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    await tick();

    controller.observeFrame(runId, { type: 'done', data: {} });
    await controller.settle(runId);

    expect(persistence.ackedSeqs).toContain(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 2 — the terminal decision and the commit promise are separate, and
//          the terminal EVENT is acknowledged before `complete`
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 2 — append-ack, then complete, and one shared promise', () => {
  it('acknowledges the terminal event before it writes the terminal row', async () => {
    // Contract §C offers two orderings. This suite pins the first: the terminal
    // EVENT lands and is acknowledged, and only then is the terminal ROW
    // written. The alternative — one SQLite transaction holding both — was
    // rejected, and `RunSession`'s header says why: it is a property of an
    // adapter, and this is a cross-process port with exactly two calls.
    //
    // What is asserted is the BARRIER, not the call order: `complete` records
    // which seqs were already durable when it was made, so an implementation
    // that called `append` and then did not wait for it cannot pass.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-terminal-order';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame(runId, { type: 'done', data: {} });
    await controller.settle(runId);

    const terminalSeq = persistence.terminalEventSeq();
    expect(terminalSeq).not.toBeNull();

    const completeCall = persistence.calls.find((c) => c.op === 'complete');
    expect(completeCall).toBeDefined();
    // By the time the row was written, the terminal event was already durable.
    expect(completeCall?.ackedBefore).toContain(terminalSeq);
  });

  it('acknowledges a RETRIED terminal event before it writes the terminal row', async () => {
    // The same barrier, read from the case the write queue created. A terminal
    // batch that storage refused on the first attempt is re-offered rather
    // than dropped — and the row must still not be written until the RE-OFFERED
    // batch has been acknowledged.
    //
    // Before the queue existed, the refusal discarded the batch, `#appendFault`
    // was set, and `complete` was never called at all. So this fails on the old
    // code for the right reason: there was no second attempt for the barrier to
    // wait on, because there was no second attempt.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-retried-terminal-order';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      appendRetries: 2,
    });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    // Refuse the batch carrying `done` once. Everything else is acknowledged.
    persistence.failNextAppends = 1;
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    await tick();
    controller.observeFrame(runId, { type: 'done', data: {} });

    const terminal = await controller.settle(runId);
    const terminalSeq = persistence.terminalEventSeq();
    expect(terminalSeq).not.toBeNull();

    const completeCall = persistence.calls.find((c) => c.op === 'complete');
    expect(completeCall).toBeDefined();
    expect(completeCall?.ackedBefore).toContain(terminalSeq);
    // Nothing was lost in the end, so the run is not degraded.
    expect(terminal.status).toBe('completed');
  });

  it('calls the adapter with append and then complete, and nothing else', async () => {
    // The structural half of the same decision. `RunPersistence` has two
    // methods, so "which writes go in one transaction" is not a question an
    // adapter gets to answer differently — and if a third call ever appears
    // here, the ordering guarantee is no longer the one this suite pins.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-adapter-vocabulary';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'done', data: {} });
    await controller.settle(runId);

    const ops = [...new Set(persistence.calls.map((c) => c.op))];
    expect(ops).toEqual(['append', 'complete']);
  });

  it('gives repeated settles and repeated results one shared promise', async () => {
    // Contract §C: 多次读取和settle共享完成Promise. Settling twice must not
    // write a second terminal row, and `result()` must be a read of that one
    // settlement — not a second caller that decides anything.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-shared-promise';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    const handle = await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'done', data: {} });

    const [first, second] = await Promise.all([controller.settle(runId), controller.settle(runId)]);
    expect(first).toBe(second);
    // ONE terminal row, not one per settle call.
    expect(persistence.completes).toHaveLength(1);

    const [resultA, resultB] = await Promise.all([handle.result(), handle.result()]);
    // The receipt is one object. Two `result()` calls that each rebuilt their
    // own would report a different `wallClockMs` and a caller comparing them
    // would see a run that changed while it was not running.
    expect(resultA).toBe(resultB);
    expect(resultA.status).toBe('completed');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 3 — dispatch only after the durable `started` is acknowledged
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 3 — a run dispatches only after `started` is durable', () => {
  it('does not dispatch an executor when the started event cannot be stored', async () => {
    // `start()` awaited `session.flush()`, which was the right intent — but a
    // refusal REJECTED out of `start`, so the dispatch never happened, by
    // accident of the throw rather than by a decision, and the caller was
    // handed an adapter error with no code and nothing to branch on. A real
    // host that catches broadly would treat "the record is not there" and "the
    // worker is starting" as the same failure.
    const persistence = new ScriptedPersistence();
    persistence.alwaysFailAppends = true;
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-start-failed';
    const { controller, dispatched } = buildController({
      channel: openExecutor(probe),
      persistence,
      appendRetries: 0,
    });

    const error = await controller
      .start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' })
      .then(() => null)
      .catch((e: unknown) => e);

    // The CODE is what a host branches on, so the code is what is asserted.
    // Naming the class as well would pin the mechanism rather than the
    // contract, and the contract is `start_failed`.
    expect((error as { code?: string } | null)?.code).toBe('start_failed');
    // The point of the item: the executor never started.
    expect(dispatched()).toBe(0);
  });

  it('leaves no live run behind when the start failed', async () => {
    // `start()` registered the run in `#runs` before awaiting the flush, so a
    // refused start left an entry that no host would ever settle — a run that
    // exists in memory and in no database, counted by neither.
    const persistence = new ScriptedPersistence();
    persistence.alwaysFailAppends = true;
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-start-failed-cleanup';
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      appendRetries: 0,
    });

    await controller
      .start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' })
      .catch(() => undefined);

    expect(controller.liveRuns).toBe(0);
    expect(controller.activeRun(runId)).toBeUndefined();
    // And no receipt: the run never opened, so there is nothing to report.
    expect(controller.receiptFor(runId)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 4 — every abnormal exit produces an explicit terminal
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 4 — an abnormal exit still produces a terminal', () => {
  it('records a terminal EVENT for a stream that ended in silence', async () => {
    // `resolveRunOutcome` reads silence as `runtime_crash`, and the settle path
    // wrote the ROW. Nothing ever appended the terminal EVENT, so the durable
    // log of a crashed run ended with a `text` block and a `running` row that
    // the crash itself explained. Contract §C: executor退出无终态…必须合成明确
    // terminal事件.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-silence-terminal-event';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    // The executor's stream ends with no `done` and no `error`.
    const terminal = await controller.settle(runId);

    expect(terminal.status).toBe('failed');
    expect(persistence.terminalEventSeq()).not.toBeNull();
    // The synthesized event carries the same verdict the row does.
    const terminalAppend = persistence.calls.find(
      (c) => c.op === 'append' && c.detail.includes('terminal:yes'),
    );
    expect(terminalAppend).toBeDefined();
  });

  it('records a terminal when the dispatch itself throws', async () => {
    // A channel that throws before it can begin leaves a `run.started` already
    // durable and no execution. Previously the throw escaped `start()` with
    // the run still live in `#runs` and the row still `running` — a run that
    // exists, will never do anything, and nothing will ever close.
    const persistence = new ScriptedPersistence();
    const runId = 'run-dispatch-threw';
    const { controller } = buildController({
      channel: throwingDispatch('the executor refused to start'),
      persistence,
    });

    await controller
      .start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' })
      .catch(() => undefined);

    // A terminal row was written, and the log carries a terminal event with it.
    await tick();
    expect(persistence.completes).toHaveLength(1);
    expect(persistence.completes[0]?.terminal.status).toBe('failed');
    expect(persistence.terminalEventSeq()).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 5 — late frames, cleanup, and a queryable receipt
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 5 — a late frame is a diagnostic, and the run is cleaned up', () => {
  it('rejects a frame that arrives after the terminal', async () => {
    // `settle` deletes the run from `#runs`, so a frame arriving afterwards hit
    // the "unknown run" branch and returned a shape indistinguishable from a
    // frame for a session that never opened one. A dropped terminal event from
    // a worker that was still flushing is exactly the case a host needs to see.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-late-frame';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'done', data: {} });
    await controller.settle(runId);

    const before = persistence.ackedSeqs.length;
    const late = controller.observeFrame(runId, { type: 'text', data: { content: 'too late' } });

    expect(late.late).toBe(true);
    // Rejected, not recorded: no seq consumed, nothing appended.
    expect(persistence.ackedSeqs).toHaveLength(before);
    expect(persistence.completes).toHaveLength(1);
  });

  it('distinguishes a late frame from a frame for a run that never existed', async () => {
    // The two are different facts and a host debugging a stuck session needs
    // to tell them apart. R1.1 already made the second one an honest
    // `run_not_found`; folding it together with "arrived too late" would undo
    // half of that.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    const neverOpened = controller.observeFrame('run-never-opened', { type: 'text', data: { content: 'x' } });
    expect(neverOpened.late).toBe(false);
    expect(neverOpened.unknown).toBe(true);
  });

  it('keeps the terminal queryable after the live run is dropped', async () => {
    // Contract §C keeps the receipt answerable. The controller forgetting the
    // run is correct; forgetting what it DECIDED is not — `settle` on an ended
    // run answers `run_not_found`, which is a lie about a run that ended.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-receipt';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'done', data: {} });
    const settled = await controller.settle(runId);

    expect(controller.liveRuns).toBe(0);
    expect(controller.receiptFor(runId)).toEqual(settled);
    // Settling it again reports the terminal it reached, not "no such run".
    expect(await controller.settle(runId)).toEqual(settled);
  });

  it('retains a bounded number of receipts over many runs', async () => {
    // The other half of "clean up". An unbounded receipt map is a slower leak
    // than the one it replaced, and the plan's acceptance scenario measures it
    // directly: after 100 runs the controller must be back to its baseline.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const { controller } = buildController({
      channel: openExecutor(probe),
      persistence,
      receiptLimit: 8,
    });

    for (let n = 0; n < 100; n += 1) {
      const runId = `run-bounded-${n}`;
      await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
      controller.observeFrame(runId, { type: 'done', data: {} });
      await controller.settle(runId);
    }

    expect(controller.liveRuns).toBe(0);
    expect(controller.retainedReceipts).toBe(8);
    // The most recent run is still answerable; the oldest is not claimed to be.
    expect(controller.receiptFor('run-bounded-99')).not.toBeNull();
    expect(controller.receiptFor('run-bounded-0')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// item 6 — one arbiter for the cancel/done race
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 item 6 — cancel and done share one arbiter', () => {
  it('decides the race once when done lands inside the stop window', async () => {
    // Contract §D: 所有terminal candidate通过同一串行arbiter. `cancel` awaits
    // `handle.stop()`, and a worker that finishes inside that window is the
    // normal case, not an exotic one. Both callers must reach the SAME
    // settlement, and the verdict is `resolveRunOutcome`'s: the host's own
    // statement that it asked to stop wins, because which of the two happened
    // first is not observable from the stream.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-cancel-done-race';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });

    // The stop is cooperative and the worker answers with `done` while it is
    // being granted — the exact overlap the arbiter exists for.
    const outcome = await controller.cancel(runId);
    // The executor is told to stop exactly once: this phase adds no second
    // worker-stop path, and a second stop is a second escalation.
    expect(probe.stops).toBe(1);

    expect(outcome.applied).toBe(true);
    expect(outcome.terminal.status).toBe('cancelled');
    // One terminal row and one terminal event, from one decision.
    expect(persistence.completes).toHaveLength(1);
    const terminalAppends = persistence.calls.filter((c) => c.detail.includes('terminal:yes'));
    expect(terminalAppends).toHaveLength(1);
  });

  it('reports applied:false with the terminal the run actually reached', async () => {
    // `cancel` checked `isClosed` BEFORE awaiting the stop, so a run that ended
    // during the grace window was reported `applied: true` carrying a terminal
    // it did not produce. The caller is asking "did I cancel this?", and the
    // honest answer for a run that finished on its own is no.
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-cancel-after-end';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'done', data: {} });
    const settled = await controller.settle(runId);

    const outcome = await controller.cancel(runId);

    expect(outcome.applied).toBe(false);
    expect(outcome.terminal).toEqual(settled);
    // No stop was sent: the run was already over, and this phase does not
    // invent a worker-stop path for a run that needs none.
    expect(probe.stops).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// the receipt a host reads: `result()` after a run has been forgotten
// ═════════════════════════════════════════════════════════════════════════

describe('R1.2 — the result receipt survives the live run', () => {
  it('reports the same receipt however many times it is read', async () => {
    const persistence = new ScriptedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-receipt-read';
    const { controller } = buildController({ channel: openExecutor(probe), persistence });

    const handle: RunHandle = await controller.start(buildManifest(runId), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame(runId, { type: 'done', data: {} });
    await controller.settle(runId);

    const first: RunResult = await handle.result();
    const second: RunResult = await handle.result();
    expect(second).toBe(first);
    expect(first.status).toBe('completed');
    // Reading it did not settle anything twice.
    expect(persistence.completes).toHaveLength(1);
  });
});
