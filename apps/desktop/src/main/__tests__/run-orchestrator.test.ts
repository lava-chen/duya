/**
 * The agent-server's run layer, driven the way the router drives it.
 *
 * ## What this covers that the runtime suite cannot
 *
 * `packages/agent-runtime` is proven end to end in
 * `reference-run.test.ts`, with a scripted executor. What is left untested
 * there is the ADAPTER: the translation from the router's `db:request` channel
 * into the Control Plane's actions, and from a normalised worker frame into
 * `observeFrame`. That adapter is where a wrong action name or a wrong payload
 * shape would live, and both would fail silently — the chat would work, the
 * chat would always work, and no run would ever be recorded.
 *
 * So this test asserts on the CALLS, using a `dbRequest` double that records
 * every action and payload. `run:create` must be issued before any frame is
 * observed, `run:append` must carry the durable envelopes, and `run:complete`
 * must carry the terminal state.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RunTerminalState } from '@duya/agent-protocol';
import { RunOrchestrator, createWorkerExecutionChannel, type ChatStartCommand } from '../agents/server/run-orchestrator';
import { logger } from '../agents/server/logger';

/**
 * A stop the host has already completed: accepted, and the worker left cleanly.
 *
 * Shared by every double in this file so they all report the SAME thing. Before
 * R2.3 the binding returned a boolean, which could not distinguish this from a
 * worker that had to be killed.
 */
const COOPERATIVE_INTERRUPT: WorkerInterrupt = {
  accepted: true,
  settled: Promise.resolve('cooperative'),
};


interface Call {
  action: string;
  payload: Record<string, unknown>;
}

function recorder(): { calls: Call[]; request: (a: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
      if (action === 'run:append') {
        return { ok: true, state: 'applied', runId: payload.runId, written: (payload.events as unknown[]).length };
      }
      return { ok: true, state: 'applied', runId: payload.runId, applied: true };
    },
  };
}

function makeOrchestrator(dbRequest: (a: string, p: Record<string, unknown>) => Promise<unknown>) {
  let dispatched = 0;
  const orchestrator = new RunOrchestrator({
    dbRequest,
    channel: createWorkerExecutionChannel({
      dispatch: () => {
        dispatched += 1;
        return true;
      },
      interrupt: () => COOPERATIVE_INTERRUPT,
    }),
  });
  return { orchestrator, dispatchCount: () => dispatched };
}

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  origin: 'user' as const,
  // Plan 587 R2.1: the prompt and options are run INPUT now, passed through the
  // single entry rather than sent by the router beside it.
  prompt: 'hello',
  options: {},
};

/**
 * Open a run and return its id, failing loudly when it was NOT accepted.
 *
 * `openRun` returns an acknowledgement rather than `string | null` (R2.1), so
 * a test that wants the id has to assert acceptance. Collapsing that back into
 * a bare `null` here would hide exactly the distinction R2.1 added.
 */
async function open(orchestrator: RunOrchestrator, sessionId: string): Promise<string> {
  const start = await orchestrator.openRun(sessionId, intent);
  if (!start.accepted) {
    throw new Error(`openRun was not accepted (${start.stage}: ${start.reason})`);
  }
  return start.runId;
}

describe('RunOrchestrator', () => {
  it('opens the run through the Control Plane with a frozen manifest', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    const runId = await open(orchestrator, 'session-1');
    expect(runId).not.toBeNull();

    const create = calls.find((c) => c.action === 'run:create');
    expect(create).toBeDefined();
    expect(create?.payload.runId).toBe(runId);
    expect(create?.payload.sessionId).toBe('session-1');
    // The manifest is persisted VERBATIM, and the hash is pinned by the
    // Control Plane before the run exists. A hash that is only computed later
    // proves nothing about what the run was given.
    expect(typeof create?.payload.manifestHash).toBe('string');
    expect((create?.payload.manifestHash as string).length).toBe(64);
    expect((create?.payload.manifest as { cwd: string }).cwd).toBe('/repo');
  });

  it('never lets a Control Plane refusal block the chat', async () => {
    // Losing the durable record is a degradation; refusing the user's message
    // is a regression. `openRun` must report NOT ACCEPTED and the router must
    // carry on — and, because the dispatch is inside the start, "not accepted"
    // now also means nothing was sent to the worker.
    // `no core stores` is the `unavailable` state exactly: the Control Plane
    // exists but its database cannot be reached. R1.3 named that refusal, and
    // the acceptance still carries the producer's own sentence so a host can
    // branch on it.
    const { orchestrator, dispatchCount } = makeOrchestrator(async () => ({
      ok: false,
      state: 'unavailable',
      runId: '',
      reason: 'no core stores',
    }));
    await expect(orchestrator.openRun('session-1', intent)).resolves.toMatchObject({
      accepted: false,
      stage: 'run_not_created',
      reason: 'no core stores',
    });
    expect(dispatchCount()).toBe(0);
  });

  it('never lets a Control Plane throw block the chat', async () => {
    const { orchestrator, dispatchCount } = makeOrchestrator(async () => {
      throw new Error('db:request channel closed');
    });
    await expect(orchestrator.openRun('session-1', intent)).resolves.toMatchObject({ accepted: false });
    expect(dispatchCount()).toBe(0);
  });

  it('records run.started before the first frame is observed', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    // Everything the run is OPENED with must be on the wire before
    // `openRun` resolves, because the host dispatches the execution the moment
    // it does. `run.started` is flushed on its own and awaited for exactly
    // that reason: a run that crashes on its first frame still leaves the
    // record that says what it was given.
    await open(orchestrator, 'session-1');
    const openWindow = calls.length;

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    await vi.waitFor(() => {
      expect(calls.some((c) => c.action === 'run:complete')).toBe(false);
    });

    const createIndex = calls.findIndex((c) => c.action === 'run:create');
    const firstAppendIndex = calls.findIndex((c) => c.action === 'run:append');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(firstAppendIndex).toBeGreaterThan(createIndex);
    // Both landed inside `openRun`, not after it.
    expect(firstAppendIndex).toBeLessThan(openWindow);

    const events = calls[firstAppendIndex]?.payload.events as Array<{ payload: { type: string } }>;
    // The first batch is `run.started` ALONE — proof it was not batched behind
    // the turn event that followed it.
    expect(events.map((e) => e.payload.type)).toEqual(['run.started']);
    expect(calls[firstAppendIndex]?.payload.runId).toBe(calls[createIndex]?.payload.runId);
  });

  it('settles the run when the worker reports done', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    const runId = await open(orchestrator, 'session-1');

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    orchestrator.observe('session-1', { type: 'text', data: { content: 'hi' } });
    orchestrator.observe('session-1', { type: 'done', data: {} });

    await vi.waitFor(() => {
      expect(calls.some((c) => c.action === 'run:complete')).toBe(true);
    });
    const complete = calls.find((c) => c.action === 'run:complete');
    expect(complete?.payload.runId).toBe(runId);
    const terminal = complete?.payload.terminal as RunTerminalState;
    expect(terminal.status).toBe('completed');
    // Cancellation is not failure, and natural completion carries no error.
    expect(complete?.payload.terminal).not.toHaveProperty('error');
  });

  it('settles a run whose stream ended with no terminal frame as a crash', async () => {
    // Silence is not consent. Without this, a worker that dies mid-turn leaves
    // a `running` row that no process will ever close.
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await open(orchestrator, 'session-1');

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    await orchestrator.settleSession('session-1');

    const complete = calls.find((c) => c.action === 'run:complete');
    const terminal = complete?.payload.terminal as RunTerminalState;
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'failed') expect(terminal.error.code).toBe('runtime_crash');
  });

  it('keeps concurrent sessions on separate runs', async () => {
    // The bug this guards is a single shared "current run" field, which would
    // route one session's events into the other session's row.
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    const runA = await open(orchestrator, 'session-a');
    const runB = await open(orchestrator, 'session-b');
    expect(runA).not.toBe(runB);

    orchestrator.observe('session-a', { type: 'turn_start', data: { turnCount: 1 } });
    orchestrator.observe('session-b', { type: 'turn_start', data: { turnCount: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    const appends = calls.filter((c) => c.action === 'run:append');
    const owners = new Set(appends.map((c) => c.payload.runId));
    expect(owners.has(runA as string)).toBe(true);
    expect(owners.has(runB as string)).toBe(true);
  });

  it('ignores frames for a session with no run', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    // A GET-reconnect for a session whose run was never opened must not write
    // anything, and must not throw.
    expect(() => orchestrator.observe('unknown-session', { type: 'text', data: { content: 'x' } })).not.toThrow();
    expect(calls.filter((c) => c.action === 'run:append')).toHaveLength(0);
  });

  it('forwards a frame it could not model, flagged as forward-only', async () => {
    const { request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await open(orchestrator, 'session-1');

    // `workflow_run` has no protocol counterpart, and the renderer renders it.
    // Dropping it would break the UI, which is the one thing this plan must
    // not do.
    const outcome = orchestrator.observe('session-1', { type: 'workflow_run', data: { run: { id: 'w1' } } });
    expect(outcome.forwardOnly).toBe(true);
    expect(outcome.legacy).toBeNull();
  });

  it('drops an internal control-plane frame instead of recording it', async () => {
    const { request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await open(orchestrator, 'session-1');

    const outcome = orchestrator.observe('session-1', { type: 'pong' });
    expect(outcome.forwardOnly).toBe(false);
    expect(outcome.legacy).toBeNull();
  });

  it('dispatches the chat command with the run’s own identity, exactly once', async () => {
    // The seam's contract, R2.1: `controller.start` asks the channel to begin,
    // and the channel sends the ONE `chat:start` for the turn. It used to be
    // handed a bare runId while the router sent the real command itself with a
    // second id — so this is the assertion that the executor is now told which
    // run it is executing.
    //
    // Strengthened rather than replaced: it still proves the channel fires once
    // with the run's own id, and now also that the manifest reference and the
    // input revision travel on the same message.
    const seen: ChatStartCommand[] = [];
    const created: Array<Record<string, unknown>> = [];
    const orchestrator = new RunOrchestrator({
      dbRequest: async (action, payload) => {
        if (action === 'run:create') {
          created.push(payload);
          return { ok: true, state: 'created', runId: payload.runId };
        }
        if (action === 'run:append') {
          return {
            ok: true,
            state: 'applied',
            runId: payload.runId,
            written: (payload.events as unknown[]).length,
          };
        }
        return { ok: true, state: 'applied', runId: payload.runId, applied: true };
      },
      channel: createWorkerExecutionChannel({
        dispatch: (command) => {
          seen.push(command);
          return true;
        },
        interrupt: () => COOPERATIVE_INTERRUPT,
      }),
    });

    const runId = await open(orchestrator, 'session-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runId).toBe(runId);
    // The manifest reference is the SAME hash the Control Plane pinned on the
    // row, not a recomputed one. Two hashes would mean the run record and the
    // executor disagree about what they were both given.
    expect(seen[0]?.manifestHash).toBe(created[0]?.['manifestHash']);
    expect(typeof seen[0]?.inputRevision).toBe('string');
    expect((seen[0]?.inputRevision as string).length).toBe(64);
    // `id` is the TURN id, not the run id. Conflating the two is how the two
    // identities got confused in the first place.
    expect(seen[0]?.id).not.toBe(runId);
  });
});

/**
 * Seam 4 — the adapter must not swallow a Control Plane ack.
 *
 * ## What is broken
 *
 * The persistence adapter awaits `dbRequest(...)` and discards the reply
 * (`run-orchestrator.ts:120-125`). The Control Plane on the other side of that
 * channel reports honestly and distinguishes three outcomes that mean very
 * different things:
 *
 *   - `{ ok: false, error }`      — the write did not happen
 *   - `{ ok: true, applied: false }` — a LOST CAS: another writer already
 *                                    decided this run's history
 *   - a thrown error              — the channel itself failed
 *
 * The adapter treats all three as success, so the runtime believes a run is
 * durably recorded when nothing was written. Contract §C: a DB failure must
 * return an explicit failure / degraded receipt, and must never be dressed up
 * as `completed`; a CAS that was not applied must be reconciled against the
 * existing terminal rather than silently assumed to be this call's success.
 *
 * ## What these tests can and cannot prove
 *
 * The orchestrator exposes no receipt surface for an append or a terminal
 * write — `settleSession` returns `void` and swallows settle errors into a log
 * line. So the only thing observable from outside is whether the failure was
 * REPORTED. That is asserted here. It is the narrowest honest evidence
 * available without changing production signatures, and it is deliberately
 * tolerant of the mechanism the fix chooses (warn, error, or a thrown error
 * that `settleSession` logs) — what it forbids is silence.
 */
describe('RunOrchestrator — Control Plane acks are not swallowed', () => {
  /**
   * Collect every diagnostic the orchestrator emits, and keep the spies out of
   * the way of stdout. `warn` and `error` are pooled because the right level
   * for a degraded transcript and the right level for a lost CAS are not the
   * same question, and this test does not want to answer it.
   */
  function captureReports(): { reports: string[]; restore: () => void } {
    const reports: string[] = [];
    const warn = vi.spyOn(logger, 'warn').mockImplementation((msg: string) => {
      reports.push(`warn:${msg}`);
    });
    const error = vi.spyOn(logger, 'error').mockImplementation((msg: string) => {
      reports.push(`error:${msg}`);
    });
    return { reports, restore: () => { warn.mockRestore(); error.mockRestore(); } };
  }

  /** `run:create` succeeds so the run opens; every other action is stubbed. */
  function stubFor(action: string, reply: unknown) {
    return async (requested: string, payload: Record<string, unknown>): Promise<unknown> => {
      if (requested === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
      if (requested === action) return reply;
      // R1.3: the fallthrough has to answer each action in ITS OWN vocabulary.
      // A single `{ applied: true }` for everything satisfies neither: an
      // `run:append` receipt is invalid without a `written` count, and the
      // reader rejects an unrecognisable shape rather than assuming a write.
      if (requested === 'run:append') {
        return {
          ok: true,
          state: 'applied',
          runId: payload.runId,
          written: (payload.events as unknown[]).length,
        };
      }
      return { ok: true, state: 'applied', runId: payload.runId, applied: true };
    };
  }

  it('reports a durable append the Control Plane refused', async () => {
    // `appendRunEvents` never throws: it catches and answers a receipt
    // (`run-control-plane.ts`). So a lost event batch cannot reach the runtime
    // as a rejection — the ONLY way it can become visible is if the adapter
    // reads the reply it currently throws away. R1.3 gave that reply a state, so
    // the refusal now says WHICH kind it is rather than only that it happened.
    const { reports, restore } = captureReports();
    try {
      // R2.1: only the MID-STREAM batches are refused. Refusing the very first
      // append would refuse `run.started`, and a run whose start is not durable
      // is not dispatched at all — which is R1.2's rule, and it would make this
      // test pass for a different reason than the one it exists to prove.
      const { orchestrator } = makeOrchestrator(async (action, payload) => {
        if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
        if (action === 'run:append') {
          const events = payload.events as Array<{ payload: { type: string } }>;
          if (events.some((e) => e.payload.type === 'run.started')) {
            return { ok: true, state: 'applied', runId: payload.runId, written: events.length };
          }
          return { ok: false, state: 'busy', runId: payload.runId, reason: 'SQLITE_BUSY: database is locked' };
        }
        return { ok: true, state: 'applied', runId: payload.runId, applied: true };
      });
      await open(orchestrator, 'session-1');

      orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
      orchestrator.observe('session-1', { type: 'done', data: {} });

      await vi.waitFor(() => {
        expect(reports).not.toHaveLength(0);
      });
    } finally {
      restore();
    }
  });

  it('reports a terminal write the Control Plane refused', async () => {
    // `completeRun` answers a refusal receipt on a DB failure
    // (`run-control-plane.ts`). Without a reported failure the run looks settled
    // in the host while its `runs` row is still `running`. R1.3 named that
    // refusal: a busy database is a distinct state from any other SQL failure,
    // because only one of them is worth retrying.
    const { reports, restore } = captureReports();
    try {
      const { orchestrator } = makeOrchestrator(
        stubFor('run:complete', {
          ok: false,
          state: 'busy',
          runId: 'r-1',
          reason: 'SQLITE_BUSY: database is locked',
        }),
      );
      await open(orchestrator, 'session-1');

      orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
      orchestrator.observe('session-1', { type: 'done', data: {} });

      await vi.waitFor(() => {
        expect(reports).not.toHaveLength(0);
      });
    } finally {
      restore();
    }
  });

  it('reports a lost terminal CAS instead of assuming this call won it', async () => {
    // R1.3 replaced the bare `{ ok: true, applied: false }` this used to stub.
    // A lost CAS is no longer reported as a single anonymous "did not land": the
    // Control Plane now READS the committed terminal back and says which of two
    // very different things happened — `reconciled` (another writer agreed, and
    // the run IS settled as decided) or `conflict` (another writer decided
    // something else, and the claim is lost). This asserts the second, which is
    // the one that must never be reported as a win. The first is asserted in
    // `run-orchestrator-ack.test.ts`, where it must NOT degrade the run.
    const { reports, restore } = captureReports();
    try {
      const { orchestrator } = makeOrchestrator(
        stubFor('run:complete', {
          ok: false,
          state: 'conflict',
          runId: 'r-1',
          applied: false,
          committed: { status: 'cancelled' },
          reason: 'another writer cancelled this run',
        }),
      );
      await open(orchestrator, 'session-1');

      orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
      orchestrator.observe('session-1', { type: 'done', data: {} });

      await vi.waitFor(() => {
        expect(reports).not.toHaveLength(0);
      });
    } finally {
      restore();
    }
  });

  it('surfaces a channel that throws mid-append rather than losing the batch', async () => {
    // A throw is the one failure mode the adapter already propagates: the
    // rejection escapes `append`, unwinds the settle, and the orchestrator logs
    // it. This test is a guard rather than a regression — it pins the behaviour
    // that makes the three cases above unambiguously defects: silence, not
    // propagation, is what a lost ack looks like today.
    const { reports, restore } = captureReports();
    try {
      const { orchestrator } = makeOrchestrator(async (action, payload) => {
        if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
        if (action === 'run:append') {
          const events = payload.events as Array<{ payload: { type: string } }>;
          // `run.started` must land for `openRun` to resolve, so only the
          // terminal batch is allowed to fail.
          if (events.some((e) => e.payload.type === 'run.completed')) {
            throw new Error('db:request channel closed mid-append');
          }
          return { ok: true, state: 'applied', runId: payload.runId, written: events.length };
        }
        return { ok: true, state: 'applied', runId: payload.runId, applied: true };
      });
      await open(orchestrator, 'session-1');

      orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
      orchestrator.observe('session-1', { type: 'done', data: {} });

      await vi.waitFor(() => {
        expect(reports).not.toHaveLength(0);
      });
    } finally {
      restore();
    }
  });
});

/**
 * R1.2 — the adapter's half of the persistence sequence and the lifecycle
 * around it.
 *
 * The runtime package owns the write queue, the one-shot settlement and the
 * terminal event. What is left here is the ADAPTER, and it has three jobs of
 * its own that no runtime test can reach:
 *
 *   1. **A run that was never opened must not be addressable.** `openRun`
 *      registered the session BEFORE the durable `started`, so a start that
 *      failed left the session pointing at a run that does not exist — and the
 *      router's next frame was teed into it.
 *   2. **The per-run model binding must be released.** `#modelByRun` was only
 *      ever written. One entry per turn, for the life of the agent-server
 *      process, which is the unbounded half of R1.2 item 5.
 *   3. **A frame for a run that has ended is a diagnostic.** The router keeps
 *      writing it either way; the run layer's job is to say so.
 */
describe('RunOrchestrator — R1.2 lifecycle at the adapter', () => {
  function openAndRefuseStarted(): { orchestrator: RunOrchestrator; dispatched: () => number } {
    let dispatched = 0;
    const orchestrator = new RunOrchestrator({
      // `run:create` succeeds — the row exists — and the FIRST append is
      // refused, so the run cannot be made durable and must not be dispatched.
      dbRequest: async (action, payload) => {
        if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
        if (action === 'run:append') return { ok: false, state: 'busy', runId: payload.runId, reason: 'SQLITE_BUSY' };
        return { ok: true, state: 'applied', runId: payload.runId, applied: true };
      },
      channel: createWorkerExecutionChannel({
        dispatch: () => {
          dispatched += 1;
          return true;
        },
        interrupt: () => COOPERATIVE_INTERRUPT,
      }),
    });
    return { orchestrator, dispatched: () => dispatched };
  }

  it('does not open a session whose durable start failed', async () => {
    // The run row exists, `run.started` did not land, so the run did not open.
    // `openRun` must report that rather than hand back a runId the host will
    // attribute a whole turn's events to.
    const { orchestrator, dispatched } = openAndRefuseStarted();
    const { reports, restore } = (() => {
      const reports: string[] = [];
      const warn = vi.spyOn(logger, 'warn').mockImplementation((msg: string) => {
        reports.push(msg);
      });
      return { reports, restore: () => warn.mockRestore() };
    })();

    try {
      const start = await orchestrator.openRun('session-1', intent);
      // Not accepted, and the stage is NAMED: the row exists, `run.started` did
      // not land. `not.toBeNull()` would not distinguish that from a refused row,
      // which needs a different operator response.
      expect(start).toMatchObject({ accepted: false, stage: 'started_not_durable' });
      // The executor was never told to go.
      expect(dispatched()).toBe(0);
      // And the failure was NAMED in the log too. A generic "openRun failed"
      // line is what a host reads today, and it cannot distinguish a Control
      // Plane that refused the row from a run that could not be made durable.
      expect(reports.join('|')).toMatch(/start_failed|run\.started/i);
    } finally {
      restore();
    }
  });

  it('leaves no session mapping behind for a run that never opened', async () => {
    // `openRun` set `#bySession` before `controller.start`. On a start that
    // failed, the next frame from the worker was routed into a run that has no
    // record and no `run.started` — an append for a run the Control Plane
    // never finished opening.
    const { calls, request } = recorder();
    const orchestrator = new RunOrchestrator({
      dbRequest: async (action, payload) => {
        if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
        if (action === 'run:append') return { ok: false, state: 'busy', runId: payload.runId, reason: 'SQLITE_BUSY' };
        return { ok: true, state: 'applied', runId: payload.runId, applied: true };
      },
      channel: createWorkerExecutionChannel({ dispatch: () => true, interrupt: () => true }),
    });
    void calls;
    void request;

    await orchestrator.openRun('session-1', intent).catch(() => null);
    // No run is addressable for this session, so a frame has nowhere to go.
    expect(orchestrator.runForSession('session-1')).toBeNull();

    const before = calls.length;
    orchestrator.observe('session-1', { type: 'text', data: { content: 'x' } });
    expect(calls).toHaveLength(before);
  });

  it('releases the per-run model binding when the run ends', async () => {
    // `#modelByRun` had no delete. One entry per turn, held for the life of the
    // agent-server process, keyed by a runId nothing could ever look up again.
    // The plan's acceptance scenario measures this directly: after 100 runs the
    // adapter must be back at its baseline.
    const { request } = recorder();
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({ dispatch: () => true, interrupt: () => true }),
    });

    for (let n = 0; n < 100; n += 1) {
      const sessionId = `session-${n}`;
      await orchestrator.openRun(sessionId, intent);
      orchestrator.observe(sessionId, { type: 'turn_start', data: { turnCount: 1 } });
      orchestrator.observe(sessionId, { type: 'done', data: {} });
      await orchestrator.settleSession(sessionId);
    }

    expect(orchestrator.retainedModelBindings).toBe(0);
    expect(orchestrator.retainedSessionRuns).toBe(0);
  });

  it('reports a frame that arrives after its run ended', async () => {
    // The router writes the frame either way — that is the live path and it
    // does not change. What the run layer owes the host is the fact that the
    // run had already decided, which is otherwise indistinguishable from a
    // frame for a session that never opened a run.
    const { request } = recorder();
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({ dispatch: () => true, interrupt: () => true }),
    });
    await open(orchestrator, 'session-1');
    orchestrator.observe('session-1', { type: 'done', data: {} });
    await orchestrator.settleSession('session-1');

    const late = orchestrator.observe('session-1', { type: 'text', data: { content: 'after' } });
    expect(late.late).toBe(true);

    // A session that never had a run is a different fact, and stays a no-op.
    const neverRan = orchestrator.observe('other-session', { type: 'text', data: { content: 'x' } });
    expect(neverRan.late).toBe(false);
  });

  it('records a client disconnect as cancelled, and releases the session', async () => {
    // The router's `req.on('close')` interrupts the worker and calls
    // `settleSession(sessionId, { cancelRequested: true })`. This host asked
    // for the stop, so `runtime_crash` would be a false accusation — and the
    // session has to be released on this path too, not only on the `done` one.
    const { calls, request } = recorder();
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({ dispatch: () => true, interrupt: () => true }),
    });
    await open(orchestrator, 'session-1');
    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });

    await orchestrator.settleSession('session-1', { cancelRequested: true });

    const complete = calls.find((c) => c.action === 'run:complete');
    const terminal = complete?.payload.terminal as RunTerminalState;
    expect(terminal.status).toBe('cancelled');
    expect(orchestrator.runForSession('session-1')).toBeNull();
    expect(orchestrator.retainedModelBindings).toBe(0);
  });
});
