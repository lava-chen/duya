/**
 * A successful cancel must release the session's live-run binding.
 *
 * ## The defect this pins
 *
 * `RunOrchestrator` keeps `#bySession` — the map that enforces one live run per
 * session, and the map whose guard produces `already has live run <id>` when a
 * second turn opens. `#finish` was the only thing that cleared it, and it was
 * reached from exactly two places: a terminal frame arriving through `observe`,
 * and the `catch` arm of `cancelRun`.
 *
 * The success arm of `cancelRun` released nothing. `controller.cancel` settles
 * the run's ledger row and closes its emitter, but `#bySession` is the
 * orchestrator's own bookkeeping and the controller holds no reference to it —
 * so a cancel that succeeded while the worker was wedged left the binding
 * pointing at a run that was already over.
 *
 * The Desktop path never showed it, because the router's `res.on('close')`
 * backstop calls `settleSession`, which calls `#finish`. The CLI/TUI path has no
 * such backstop: the SSE handler's `finally` only clears its heartbeat and ends
 * the response. So `duya tui` stranded the binding, and the next message on that
 * session was refused with `refused_run_open_failed — session <id> already has
 * live run <id>`.
 *
 * ## What these tests do NOT prove
 *
 * No worker process and no provider. The wedged worker is represented by a
 * worker that never produces a terminal frame, which is the property that
 * matters: the release must not depend on a frame arriving.
 */

import { describe, expect, it } from 'vitest';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
  type ChatStartCommand,
  type WorkerInterrupt,
} from '../src/run-orchestrator.js';

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  prompt: 'hello',
  options: {} as Record<string, unknown>,
};

interface Harness {
  orchestrator: RunOrchestrator;
  commands: ChatStartCommand[];
  interrupts: Array<{ sessionId: string; graceMs: number; reason: string }>;
  /** The terminal every `run:complete` call carried, in order. */
  completions: () => Array<Record<string, unknown>>;
}

/**
 * A worker that answers the interrupt cooperatively and then goes silent —
 * exactly the shape that stranded the binding. Nothing in this harness ever
 * calls `observe`, so no terminal frame can arrive to release the run.
 */
function harness(): Harness {
  const commands: ChatStartCommand[] = [];
  const interrupts: Array<{ sessionId: string; graceMs: number; reason: string }> = [];
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const request = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ action, payload });
    if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
    if (action === 'run:append') {
      return {
        ok: true,
        state: 'applied',
        runId: payload.runId,
        written: (payload.events as unknown[]).length,
      };
    }
    return { ok: true, state: 'applied', runId: payload.runId, applied: true };
  };

  const orchestrator = new RunOrchestrator({
    dbRequest: request,
    channel: createWorkerExecutionChannel({
      dispatch: (command) => {
        commands.push(command);
        return true;
      },
      interrupt: (sessionId, graceMs, reason): WorkerInterrupt => ({
        accepted: true,
        settled: Promise.resolve('cooperative'),
      }),
    }),
  });

  return {
    orchestrator,
    commands,
    interrupts,
    completions: () =>
      calls
        .filter((call) => call.action === 'run:complete')
        .map((call) => call.payload.terminal as unknown as Record<string, unknown>),
  };
}

async function open(h: Harness): Promise<string> {
  const start = await h.orchestrator.openRun('session-1', intent);
  if (!start.accepted) throw new Error(`openRun not accepted (${start.stage})`);
  return start.runId;
}

describe('a successful cancel releases the session binding', () => {
  it('binds the session while the run is live, so the test can see it drop', async () => {
    // Guard against a vacuous pass: if `runForSession` did not report the
    // binding in the first place, "it is gone after cancel" would prove nothing.
    const h = harness();
    const runId = await open(h);

    expect(h.orchestrator.runForSession('session-1')).toBe(runId);
  });

  it('drops the binding when the cancel succeeds', async () => {
    const h = harness();
    await open(h);

    const outcome = await h.orchestrator.cancelSession('session-1', 'user');

    expect(outcome?.requested).toBe(true);
    expect(outcome?.applied).toBe(true);
    // The whole point: the release must NOT depend on a terminal frame
    // arriving, because a stopped worker is the one that never sends one.
    expect(h.orchestrator.runForSession('session-1')).toBeNull();
  });

  it('admits the next turn instead of refusing it as already-live', async () => {
    // The user-visible symptom, asserted at the guard that produced it. The
    // TUI reports this refusal verbatim and the session is stuck until it is
    // restarted, so `accepted` is the property that matters — not the reason
    // string, which is free to be reworded.
    const h = harness();
    await open(h);
    await h.orchestrator.cancelSession('session-1', 'user');

    const next = await h.orchestrator.openRun('session-1', intent);

    expect(next.accepted).toBe(true);
    expect(next.runId).not.toBeNull();
  });

  it('does not write a second terminal for a run the controller already closed', async () => {
    // `#finish` calls `controller.settle`, and `controller.cancel` settled the
    // same run a moment earlier. Two writers for one terminal is refused as a
    // conflict, so a duplicate here would show up as a stray `run:complete`.
    const h = harness();
    await open(h);

    await h.orchestrator.cancelSession('session-1', 'user');

    expect(h.completions()).toHaveLength(1);
    expect(h.completions().at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('is a no-op for a run a terminal frame already released', async () => {
    // The Desktop path reaches `#finish` twice on a cancel: once from
    // `settleSession` (the router's close backstop) and once from `cancelRun`.
    // The second must not disturb the first, and must still report the run as
    // ended rather than as freshly stopped.
    const h = harness();
    await open(h);
    await h.orchestrator.settleSession('session-1');

    const outcome = await h.orchestrator.cancelSession('session-1', 'user');

    expect(outcome?.requested).toBe(true);
    expect(outcome?.applied).toBe(false);
    expect(h.orchestrator.runForSession('session-1')).toBeNull();
    // Already over, so no second interrupt is sent: the worker treats a double
    // `chat:interrupt` as "clear the command queue".
    expect(h.interrupts).toHaveLength(0);
  });

  it('leaves an unrelated session binding untouched', async () => {
    // `#release` is guarded on the binding still naming THIS run. Cancelling
    // one session's run must not disturb another session that happens to share
    // the same worker process.
    const h = harness();
    const first = await h.orchestrator.openRun('session-1', intent);
    const second = await h.orchestrator.openRun('session-2', intent);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    await h.orchestrator.cancelSession('session-1', 'user');

    expect(h.orchestrator.runForSession('session-1')).toBeNull();
    expect(h.orchestrator.runForSession('session-2')).toBe(second.runId);
  });
});
