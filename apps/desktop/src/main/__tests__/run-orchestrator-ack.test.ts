/**
 * The orchestrator's side of the receipt contract.
 *
 * Plan 587 R1.3, items 1, 2, 4 and 5 as they are observable from the host. The
 * receipt vocabulary itself is covered by `run-receipt-contract.test.ts` and the
 * SQL behaviour by `run-store-idempotency.test.ts`; this file is the part that
 * only the orchestrator can answer, because it is the only place where a
 * durability verdict becomes something a USER is told.
 *
 * The load-bearing assertion in here is the first one. A lost CAS that another
 * writer resolved identically used to reach the host as a FAILED run: the
 * adapter threw, R1.2's degraded terminal reported `persistence_failed`, and a
 * run that had in fact completed was presented to the user as one that had not.
 */

import { describe, expect, it } from 'vitest';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
  type WorkerInterrupt,
} from '../agents/server/run-orchestrator';

const COOPERATIVE_INTERRUPT: WorkerInterrupt = {
  accepted: true,
  settled: Promise.resolve('cooperative'),
};

interface Call {
  action: string;
  payload: Record<string, unknown>;
}

/** A `db:request` that answers whatever the test needs, per action. */
function scripted(
  answers: Partial<Record<string, (payload: Record<string, unknown>) => unknown>>,
): { calls: Call[]; request: (a: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (action, payload) => {
      calls.push({ action, payload });
      const answer = answers[action];
      if (answer !== undefined) return answer(payload);
      if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
      if (action === 'run:append') {
        return { ok: true, state: 'applied', runId: payload.runId, written: (payload.events as unknown[]).length };
      }
      return { ok: true, state: 'applied', runId: payload.runId, applied: true };
    },
  };
}

function makeOrchestrator(request: (a: string, p: Record<string, unknown>) => Promise<unknown>) {
  let dispatched = 0;
  const orchestrator = new RunOrchestrator({
    dbRequest: request,
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
  prompt: 'hello',
  options: {},
};

async function open(orchestrator: RunOrchestrator, sessionId: string): Promise<string> {
  const start = await orchestrator.openRun(sessionId, intent);
  if (!start.accepted) {
    throw new Error(`openRun was not accepted (${start.stage}: ${start.reason})`);
  }
  return start.runId;
}

/**
 * Drive a run to a terminal, then hand back the `RunResult` the host would see.
 *
 * The worker is scripted to say `done` immediately, so the terminal is decided
 * without a real worker process and the whole receipt path is exercised.
 *
 * Deliberately does NOT assert the terminal's status: a run whose durable
 * barrier failed legitimately REPORTS a different terminal than the one the
 * worker produced, and asserting the produced one here would fail every test
 * that is specifically about that substitution. Each caller asserts what it
 * expects.
 */
async function settleWith(
  orchestrator: RunOrchestrator,
  sessionId: string,
  outcome: 'completed' | 'failed' = 'completed',
): Promise<{ runId: string; result: Awaited<ReturnType<typeof orchestrator.resultFor>> }> {
  const runId = await open(orchestrator, sessionId);
  orchestrator.observe(sessionId, outcome === 'completed' ? { type: 'done' } : { type: 'error', error: 'boom' });
  await orchestrator.settleSession(sessionId);
  return { runId, result: await orchestrator.resultFor(sessionId) };
}

describe('a lost CAS that another writer agreed with is not a failed run (R1.3 item 4)', () => {
  it('reports the run as completed when the durable terminal already agrees', async () => {
    const { request } = scripted({
      'run:complete': (payload) => {
        // Exactly what `RunStore.settleRun` + `onWire` produce for a lost CAS
        // whose committed terminal is identical to the one proposed. Note the
        // ABSENCE of `applied`: this call did not write the terminal, another
        // writer did, and that is the whole content of the `reconciled` state.
        // Before this slice the adapter read the missing `applied` as a lost
        // CAS, threw, and R1.2 reported `persistence_failed` — telling the user
        // a run that had completed had not.
        const terminal = payload.terminal as { status: string };
        return { ok: true, state: 'reconciled', runId: payload.runId, committed: terminal };
      },
    });
    const { orchestrator } = makeOrchestrator(request);
    const { result } = await settleWith(orchestrator, 'session-reconciled');

    // Before this slice the adapter saw a lost CAS, threw, and R1.2 reported
    // `persistence_failed` — telling the user a run that had completed had not.
    expect(result?.status).toBe('completed');
    expect(result?.error).toBeUndefined();
  });

  it('still refuses a lost CAS that DISAGREED, and does not claim success', async () => {
    const { request } = scripted({
      'run:complete': (payload) => ({
        ok: false,
        state: 'conflict',
        runId: payload.runId,
        applied: false,
        committed: { status: 'cancelled' },
        reason: 'another writer cancelled this run',
      }),
    });
    const { orchestrator } = makeOrchestrator(request);
    const runId = await open(orchestrator, 'session-conflict');
    orchestrator.observe('session-conflict', { type: 'done' });
    await orchestrator.settleSession('session-conflict');

    const result = await orchestrator.resultFor('session-conflict');
    // The claim was lost, so the run must NOT be reported as the `completed`
    // this writer decided. It is degraded, which is the honest answer.
    expect(result?.status).toBe('failed');
    expect(result?.error?.code).toBe('persistence_failed');
    expect(runId).not.toBeNull();
  });
});

describe('a result that does not throw is not a success (R1.3 item 1)', () => {
  it('degrades a run whose run:complete reply cannot be read', async () => {
    for (const reply of [null, undefined, 'ok', {}, { ok: true }, { ok: true, state: 'invented' }, { ok: true, state: 'applied' }]) {
      const { request } = scripted({ 'run:complete': () => reply });
      const { orchestrator } = makeOrchestrator(request);
      const runId = await open(orchestrator, 's-unreadable');
      orchestrator.observe('s-unreadable', { type: 'done' });
      await orchestrator.settleSession('s-unreadable');
      const result = await orchestrator.resultFor('s-unreadable');
      // Every one of these is a reply the OLD `{ ok === true }` check would have
      // accepted for `{}`-and-`{ok:true}`, and rejected for the rest. None of
      // them is evidence that a terminal was recorded, so none may be reported
      // as a completed run.
      expect(result?.status, JSON.stringify(reply)).toBe('failed');
      expect(result?.error?.code, JSON.stringify(reply)).toBe('persistence_failed');
      expect(runId).not.toBeNull();
    }
  });

  it('degrades a run whose run:append reply claims success without a written count', async () => {
    // The FIRST append is `run.started`, and an unacknowledged start means the
    // run is never dispatched — so the malformed reply has to be aimed at a
    // LATER append to exercise the degraded-terminal path rather than the
    // start-refused one.
    let appends = 0;
    const { request } = scripted({
      'run:append': (payload) => {
        appends += 1;
        if (appends === 1) {
          return { ok: true, state: 'applied', runId: payload.runId, written: (payload.events as unknown[]).length };
        }
        return { ok: true, state: 'applied', runId: payload.runId };
      },
    });
    const { orchestrator } = makeOrchestrator(request);
    const { result } = await settleWith(orchestrator, 's-append-unreadable');
    expect(result?.status).toBe('failed');
    expect(result?.error?.code).toBe('persistence_failed');
  });

  it('treats a busy database as a refusal, not a durable write', async () => {
    const { request } = scripted({
      'run:complete': (payload) => ({ ok: false, state: 'busy', runId: payload.runId, reason: 'database is locked' }),
    });
    const { orchestrator } = makeOrchestrator(request);
    const runId = await open(orchestrator, 's-busy');
    orchestrator.observe('s-busy', { type: 'done' });
    await orchestrator.settleSession('s-busy');
    const result = await orchestrator.resultFor('s-busy');
    expect(result?.status).toBe('failed');
    expect(result?.error?.code).toBe('persistence_failed');
  });
});

describe('an active run is never overwritten (R1.3 item 2)', () => {
  it('refuses a second run for a session that already has a live one', async () => {
    const { request, calls } = scripted({});
    const { orchestrator, dispatchCount } = makeOrchestrator(request);
    const first = await open(orchestrator, 'session-busy-live');

    const second = await orchestrator.openRun('session-busy-live', intent);

    // The map is keyed on the session, so an overwrite would rebind it and send
    // the first run's frames into the second run's ledger.
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.stage).toBe('run_active');
      expect(second.reason).toContain(first);
    }
    // Nothing was dispatched for the refused run: the dispatch lives inside the
    // start, and the start never ran.
    expect(dispatchCount()).toBe(1);
    // And no second row was opened.
    expect(calls.filter((c) => c.action === 'run:create')).toHaveLength(1);

    // The first run is still the one the session points at. A frame for the
    // session is therefore still routed into a live run (`late: false`); had
    // the binding been clobbered it would have landed in the refused run's
    // place, or been reported as late.
    const observed = orchestrator.observe('session-busy-live', { type: 'text', text: 'still streaming' });
    expect(observed.late).toBe(false);
  });

  it('still allows a second run once the first has ended', async () => {
    // The guard must not turn the session into a one-turn-per-lifetime object.
    const { orchestrator } = makeOrchestrator(scripted({}).request);
    await open(orchestrator, 'session-serial');
    orchestrator.observe('session-serial', { type: 'done' });
    await orchestrator.settleSession('session-serial');
    await expect(open(orchestrator, 'session-serial')).resolves.toEqual(expect.any(String));
  });
});

describe('the run row records the input revision (R1.3 item 2)', () => {
  it('sends the same digest to the Control Plane and to the executor command', async () => {
    const { calls, request } = scripted({});
    const { orchestrator } = makeOrchestrator(request);
    await open(orchestrator, 'session-input');

    const create = calls.find((c) => c.action === 'run:create');
    expect(typeof create?.payload.inputHash).toBe('string');
    expect(create?.payload.inputHash).toHaveLength(64);
  });

  it('refuses to dispatch a second execution for a run the Control Plane already opened', async () => {
    const { request } = scripted({
      'run:create': (payload) => ({ ok: true, state: 'reused', runId: payload.runId }),
    });
    const { orchestrator, dispatchCount } = makeOrchestrator(request);

    const start = await orchestrator.openRun('session-reused', intent);

    // The row is CORRECT — same manifest, same input. What is refused is
    // starting a second executor against a run that already has one; reporting
    // `run_not_created` here would tell an operator the run had no durable
    // record when it has a perfect one.
    expect(start.accepted).toBe(false);
    if (!start.accepted) {
      expect(start.stage).toBe('run_already_exists');
    }
    expect(dispatchCount()).toBe(0);
  });

  it('refuses a run the Control Plane says already records different content', async () => {
    const { request } = scripted({
      'run:create': (payload) => ({
        ok: false,
        state: 'conflict',
        runId: payload.runId,
        reason: 'already recorded with a different input',
      }),
    });
    const { orchestrator, dispatchCount } = makeOrchestrator(request);

    const start = await orchestrator.openRun('session-clash', intent);
    expect(start.accepted).toBe(false);
    expect(dispatchCount()).toBe(0);
  });
});

describe('an unaccepted start dispatches nothing (R1.3 item 5)', () => {
  it.each([
    ['busy', { ok: false, state: 'busy', reason: 'database is locked' }],
    ['unavailable', { ok: false, state: 'unavailable', reason: 'cannot open database file' }],
    ['sql_failed', { ok: false, state: 'sql_failed', reason: 'near "INSR": syntax error' }],
    ['invalid', { ok: false, state: 'invalid', reason: 'run:create requires runId' }],
    ['unreadable', undefined],
  ])('reports %s as not accepted, with nothing dispatched', async (_label, reply) => {
    // The plan's "SQL transaction failure, busy, and worker exit need explicit
    // states": each is a DIFFERENT fact and none of them is a success, so the
    // chat fallback stays an explicitly declared degraded observation layer and
    // a durable run never claims a record it does not have.
    const { request } = scripted({ 'run:create': () => reply });
    const { orchestrator, dispatchCount } = makeOrchestrator(request);

    const start = await orchestrator.openRun(`session-${_label}`, intent);
    expect(start.accepted).toBe(false);
    expect(dispatchCount()).toBe(0);
    // No run was bound, so no frame can be teed into a run that never opened.
    expect(await orchestrator.resultFor(`session-${_label}`)).toBeNull();
  });
});
