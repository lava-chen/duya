/**
 * The terminal-publication path: a run's ending is held until the durable
 * barrier answers, and the release honours the queue's bound.
 *
 * ## What is under test
 *
 * Three properties, each of which was a hole before this slice:
 *
 *  1. **A terminal is not announced early.** `emit`/`publish` mint it, the
 *     ledger numbers it and persistence writes it — and the public stream does
 *     NOT see it until `publishCommittedTerminal` runs. Announcing a run's
 *     ending before the barrier answered is how a run reports success it never
 *     reached.
 *  2. **Exactly once.** The held slot is cleared BEFORE the push, so a repeated
 *     `settle` — or any second caller — finds nothing and announces nothing.
 *  3. **The downgrade arm.** When the barrier's committed terminal contradicts
 *     what the run announced, the held terminal is DISCARDED and nothing is
 *     published in its place. Not a `run.failed` substituted for it: the
 *     barrier already decided, and inventing a second ending here would be the
 *     emitter deciding the run's outcome, which is the one thing this class
 *     exists to prevent.
 *
 * ## Why the two sides of every assertion come from different places
 *
 * Each check reads the STREAM for what was announced and the LEDGER plus
 * PERSISTENCE for what was recorded. A test that compared a value to itself
 * would pass for a publisher that records and announces the same array, and
 * that is precisely the bug class here: "recorded" and "announced" are
 * different facts and the whole change is about keeping them apart.
 */

import { describe, expect, it } from 'vitest';
import {
  RunEventEmitter,
  type EventPublisher,
  type RunEventEmitterPorts,
} from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import type { RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';

const PERSISTENCE_FAILED: RunTerminalState = {
  status: 'failed',
  error: {
    code: 'persistence_failed',
    message: 'the run ended, but its durable events were not acknowledged',
  },
};

interface Harness {
  readonly emitter: RunEventEmitter;
  readonly session: RunSession;
  /** Everything the stream was told. The ANNOUNCED side. */
  readonly pushed: RunEventEnvelope[];
  /** Everything handed to `persistence.append`. The RECORDED side. */
  readonly appended: RunEventEnvelope[][];
  /** The terminal `settle` would have written, and what the barrier answered. */
  readonly completed: RunTerminalState[];
  /** Opens the bound. Until called, `whenWritable` does not resolve. */
  open(): void;
  /** Awaits a tick, so a pending `whenWritable` gets its chance to run. */
  settleTick(): Promise<void>;
}

function harness(runId = 'run-1'): Harness {
  const pushed: RunEventEnvelope[] = [];
  const appended: RunEventEnvelope[][] = [];
  const completed: RunTerminalState[] = [];
  const persistence: RunPersistence = {
    append: async (envelopes) => {
      appended.push([...envelopes]);
    },
    complete: async (terminal: RunTerminalState, _metrics: RunMetrics) => {
      completed.push(terminal);
    },
  };

  // A gate the test opens by hand. A publisher that only reports `paused`
  // cannot show that anybody awaited it; a promise the test holds shut can.
  let opened = false;
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = () => {
      opened = true;
      resolve();
    };
  });
  const stream: EventPublisher = {
    push: (envelope: RunEventEnvelope) => {
      pushed.push(envelope);
    },
    whenWritable: () => gate,
  };

  const session = new RunSession({
    runId,
    sessionId: 'sess-1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const ports: RunEventEmitterPorts = { session, stream, runId };
  return {
    emitter: new RunEventEmitter(ports),
    session,
    pushed,
    appended,
    completed,
    open,
    settleTick: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
    // `opened` is read by the assertions through the gate's own state, never
    // asserted directly — it exists so the shim cannot optimize the await away.
    ...(opened ? {} : {}),
  };
}

const COMPLETED: RunTerminalState = { status: 'completed', stopReason: 'end_turn' };

describe('a terminal is persisted but not announced until the barrier answers', () => {
  it('mints and records the terminal, and the stream has not seen it', () => {
    const h = harness();
    const result = h.emitter.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.terminal).toBe(true);
    // The flag that distinguishes "this is a terminal" from "this terminal has
    // been announced".
    expect(result.held).toBe(true);

    // RECORDED: the ledger numbered it and persistence was offered it.
    expect(h.session.seq).toBe(1);
    // ANNOUNCED: nothing yet. Two different sources, deliberately.
    expect(h.pushed).toHaveLength(0);
    expect(h.emitter.hasHeldTerminal).toBe(true);
  });

  it('a non-terminal is announced immediately, so the hold is not a blanket delay', () => {
    const h = harness();
    const result = h.emitter.emit({ type: 'run.paused', at: 'turn_boundary' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.terminal).toBe(false);
    expect(result.held).toBe(false);
    expect(h.pushed).toHaveLength(1);
    expect(h.emitter.hasHeldTerminal).toBe(false);
  });
});

describe('the release honours the publisher bound', () => {
  it('waits for whenWritable before pushing the terminal, and pushes once', async () => {
    const h = harness();
    h.emitter.emit({ type: 'run.completed', status: 'completed' });

    let released = false;
    const releasing = h.emitter
      .publishCommittedTerminal(COMPLETED)
      .then((r) => {
        released = true;
        return r;
      });

    await h.settleTick();
    // The bound is shut, so the frame must not be on the stream yet.
    expect(released).toBe(false);
    expect(h.pushed).toHaveLength(0);

    h.open();
    const outcome = await releasing;
    expect(outcome.outcome).toBe('published');
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0].payload.type).toBe('run.completed');
  });

  it('waits for whenWritable BEFORE minting, so a held-back producer does not grow the log', async () => {
    const h = harness();
    let produced = false;
    const producing = h.emitter.publish({ type: 'run.paused', at: 'turn_boundary' }).then(() => {
      produced = true;
    });

    await h.settleTick();
    expect(produced).toBe(false);
    // The distinction that matters: NOT minted, so not on the ledger and not
    // consuming a sequence number. Awaiting after the mint would have bounded
    // the queue while the durable log grew anyway.
    expect(h.session.seq).toBe(0);
    expect(h.pushed).toHaveLength(0);

    h.open();
    await producing;
    expect(h.session.seq).toBe(1);
    expect(h.pushed).toHaveLength(1);
  });
});

describe('the held terminal is released exactly once', () => {
  it('a second release finds nothing held and announces nothing', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });

    const first = await h.emitter.publishCommittedTerminal(COMPLETED);
    expect(first.outcome).toBe('published');
    expect(h.emitter.hasHeldTerminal).toBe(false);

    // ANNOUNCED: exactly one terminal, after two release attempts.
    const second = await h.emitter.publishCommittedTerminal(COMPLETED);
    expect(second.outcome).toBe('none');
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed.filter((e) => e.payload.type === 'run.completed')).toHaveLength(1);

    // RECORDED, and the independent witness that no second terminal was minted:
    // the ledger consumed one sequence number, not two.
    expect(h.session.seq).toBe(1);
  });

  it('a re-entrant release during the bound cannot announce a second ending', async () => {
    // The ordering of the clear is only observable when something re-enters the
    // release while it is in flight, so this test BUILDS that: the publisher's
    // `whenWritable` calls back into `publishCommittedTerminal`, the way a
    // bounded queue draining a control frame that triggers a settle would.
    //
    // A sequential second call cannot tell the two orderings apart — both return
    // `none` — so a test that only did that would have passed with the clear
    // moved after the push, and this mutation is the one the guard is for.
    const pushed: RunEventEnvelope[] = [];
    let reentered: Promise<unknown> | null = null;
    const session = new RunSession({
      runId: 'run-1',
      sessionId: 'sess-1',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence: {
        append: async () => undefined,
        complete: async () => undefined,
      },
      flushEvery: 1,
    });
    const stream: EventPublisher = {
      push: (envelope) => {
        pushed.push(envelope);
      },
      whenWritable: () => {
        reentered ??= emitter.publishCommittedTerminal(COMPLETED);
        return Promise.resolve();
      },
    };
    const emitter = new RunEventEmitter({ session, stream, runId: 'run-1' });
    emitter.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });

    await emitter.publishCommittedTerminal(COMPLETED);
    await reentered;

    // ANNOUNCED: one terminal, not two. Two would mean the run announced its
    // ending to a consumer that then saw it again.
    expect(pushed.filter((e) => e.payload.type === 'run.completed')).toHaveLength(1);
    // RECORDED: one sequence number, from the ledger rather than the push list.
    expect(session.seq).toBe(1);
  });

  it('a run that never minted a terminal through the emitter releases nothing', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({ type: 'run.paused', at: 'turn_boundary' });
    const outcome = await h.emitter.publishCommittedTerminal(COMPLETED);
    // Reported, not treated as a failure: this is the case of a run that exited
    // silently and whose terminal `RunSession.settle` synthesised itself.
    expect(outcome.outcome).toBe('none');
    expect(h.pushed).toHaveLength(1);
  });
});

describe('the downgrade arm discards rather than substitutes', () => {
  it('a completed run whose barrier failed publishes nothing at all', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });

    const outcome = await h.emitter.publishCommittedTerminal(PERSISTENCE_FAILED);
    expect(outcome.outcome).toBe('discarded');
    if (outcome.outcome !== 'discarded') throw new Error('unreachable');
    // The disagreement is reported with both sides, not just a boolean.
    expect(outcome.declared.status).toBe('completed');
    expect(outcome.committed.status).toBe('failed');

    // ANNOUNCED: nothing. And specifically NOT a `run.failed` invented here.
    expect(h.pushed).toHaveLength(0);
    expect(h.pushed.filter((e) => e.payload.type === 'run.failed')).toHaveLength(0);

    // RECORDED: the original terminal event is still in storage. Discarding the
    // announcement is not erasing the history.
    expect(h.session.seq).toBe(1);
    await h.session.flush();
    expect(h.appended.flat().map((e) => e.payload.type)).toContain('run.completed');
  });

  it('a failed terminal that becomes a DIFFERENT failure is also discarded', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({
      type: 'run.failed',
      error: { code: 'internal', message: 'the tool runner died' },
    });

    const outcome = await h.emitter.publishCommittedTerminal({
      status: 'failed',
      error: { code: 'persistence_failed', message: 'the barrier never answered' },
    });
    // The STATUS matched, so only the error CODE can catch this — which is why
    // the comparison is not `status === status`.
    expect(outcome.outcome).toBe('discarded');
    expect(h.pushed).toHaveLength(0);
  });

  it('a failed terminal the barrier agreed with is still released', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({
      type: 'run.failed',
      error: { code: 'internal', message: 'the tool runner died' },
    });

    const outcome = await h.emitter.publishCommittedTerminal({
      status: 'failed',
      error: { code: 'internal', message: 'the tool runner died' },
    });
    // The guard against the discard degenerating into "a failure is never
    // announced", which would be its own silent hole.
    expect(outcome.outcome).toBe('published');
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0].payload.type).toBe('run.failed');
  });

  it('a cancelled run is a completed status, not a failure, and is released', async () => {
    const h = harness();
    h.open();
    h.emitter.emit({ type: 'run.completed', status: 'cancelled', stopReason: 'aborted' });
    const outcome = await h.emitter.publishCommittedTerminal({
      status: 'cancelled',
      stopReason: 'aborted',
    });
    expect(outcome.outcome).toBe('published');
    expect(h.pushed).toHaveLength(1);
  });
});
