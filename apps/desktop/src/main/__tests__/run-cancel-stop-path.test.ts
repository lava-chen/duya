/**
 * Plan 587 R2.3 — the Desktop side of cancel and budget.
 *
 * ## What the runtime suite cannot cover
 *
 * `packages/agent-runtime/test/run-cancel-budget.test.ts` proves the run layer's
 * own accounting. It cannot prove three things that live only here:
 *
 *  1. **The ceiling actually reaches the model loop.** The runtime learns a turn
 *     started when a `turn_start` frame arrives — which is after the request has
 *     left. The only place that can refuse the SECOND request is the worker's
 *     own turn gate (`DuyaAgent`'s `maxTurns` check, reached through
 *     `options.maxTurns`), and the only way to reach that is to put the
 *     manifest's ceiling on the `chat:start` command. Before this,
 *     `run-orchestrator.ts` carried no budget at all, so R1.1's wiring reached
 *     the recorded verdict and nothing else.
 *  2. **The stop is bounded and reports its outcome.** `WorkerManager` already
 *     escalates after a grace deadline; it did it in a `setTimeout` nobody could
 *     observe, so the runtime could not tell a clean stop from a kill.
 *  3. **Deleting a chat is a cancel, not a side effect.** `handleDeleteChat`
 *     interrupted the worker and left the run un-settled, while the SSE
 *     disconnect path one screen away went through the arbiter. Two
 *     host-initiated stops, one of which leaves a `running` row behind forever.
 *
 * ## What these tests do NOT prove
 *
 * No worker process, no provider key, no Electron. A real `DuyaAgent` honouring
 * `options.maxTurns` is asserted at the COMMAND, not at the loop, and a real
 * `child_process` being SIGKILLed is asserted at the interrupt, not at the OS.
 */

import { describe, expect, it } from 'vitest';
import type { StopDisposition } from '@duya/agent-protocol';
import { handleDeleteChat } from '../agents/server/router';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
  type ChatStartCommand,
  type WorkerInterrupt,
} from '../agents/server/run-orchestrator';

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  prompt: 'hello',
  options: {} as Record<string, unknown>,
};

function recorder(): {
  calls: Array<{ action: string; payload: Record<string, unknown> }>;
  request: (a: string, p: Record<string, unknown>) => Promise<unknown>;
} {
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
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

interface Harness {
  orchestrator: RunOrchestrator;
  commands: ChatStartCommand[];
  interrupts: Array<{ sessionId: string; graceMs: number; reason: string }>;
  /** The terminal every `run:complete` call carried, in order. */
  completions: () => Array<Record<string, unknown>>;
}

function harness(
  options: { disposition?: StopDisposition; hang?: boolean } = {},
): Harness {
  const commands: ChatStartCommand[] = [];
  const interrupts: Array<{ sessionId: string; graceMs: number; reason: string }> = [];
  const { calls, request } = recorder();

  const orchestrator = new RunOrchestrator({
    dbRequest: request,
    channel: createWorkerExecutionChannel({
      dispatch: (command) => {
        commands.push(command);
        return true;
      },
      interrupt: (sessionId, graceMs, reason): WorkerInterrupt => {
        interrupts.push({ sessionId, graceMs, reason });
        if (options.hang === true) {
          return { accepted: true, settled: new Promise<StopDisposition>(() => undefined) };
        }
        return { accepted: true, settled: Promise.resolve(options.disposition ?? 'cooperative') };
      },
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

async function open(h: Harness, maxTurns?: number): Promise<string> {
  const start = await h.orchestrator.openRun(
    'session-1',
    maxTurns === undefined ? intent : { ...intent, maxTurns },
  );
  if (!start.accepted) throw new Error(`openRun not accepted (${start.stage})`);
  return start.runId;
}

// ── item 3: the ceiling has to reach the model loop ─────────────────────

describe('R2.3 — the manifest budget reaches the worker command', () => {
  it('puts maxTurns on chat:start, which is where the worker reads it', async () => {
    // `DuyaAgent` refuses to dispatch turn N+1 when `options.maxTurns` is set
    // and the turn count has reached it. Nothing else in the pipeline can
    // prevent that request, so the ceiling has to be ON THE COMMAND. The
    // runtime cannot do it: it only learns a turn started once the frame
    // returns, which is after the provider call has gone.
    const h = harness();
    await open(h, 1);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.options.maxTurns).toBe(1);
  });

  it('leaves the option off when the manifest set no ceiling', async () => {
    // A ceiling of `0` means "unset" everywhere else in this codebase
    // (`isBudgetExhausted`'s `isPositive`), and forwarding `maxTurns: 0` would
    // make the worker's `maxTurns === undefined` test pass and stop a healthy
    // run after its first turn.
    const h = harness();
    await open(h);

    expect(h.commands).toHaveLength(1);
    expect('maxTurns' in (h.commands[0]?.options ?? {})).toBe(false);
  });

  it('does not overwrite a caller-supplied maxTurns with the manifest ceiling', async () => {
    // The command's options are the run's INPUT. Overwriting one of them with
    // configuration would make `inputRevision` — the digest of exactly these
    // options — describe something the worker never received.
    const h = harness();
    await h.orchestrator.openRun('session-1', { ...intent, maxTurns: 1 });

    expect(h.commands[0]?.options.maxTurns).toBe(1);
    expect(h.commands[0]?.inputRevision).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── item 1 + 2: the stop receipt reaches the runtime ─────────────────────

describe('R2.3 — ExecutionHandle.stop reports what the host actually did', () => {
  it('reports a cooperative stop as cooperative', async () => {
    const h = harness({ disposition: 'cooperative' });
    await open(h);

    const outcome = await h.orchestrator.cancelSession('session-1', 'user');

    expect(h.interrupts).toHaveLength(1);
    // The reason names the ROUTE, not just the intent. `CancelReason` can only
    // say "a user asked"; the durable receipt has to say which of the two
    // user-initiated stops it was, or a conversation deleted out from under a
    // run is indistinguishable from a stop button.
    expect(h.interrupts[0]?.reason).toBe('delete:user');
    expect(outcome?.requested).toBe(true);
    expect(outcome?.applied).toBe(true);
    expect(outcome?.disposition).toBe('cooperative');
    expect(outcome?.terminal.status).toBe('cancelled');
  });

  it('reports an escalated stop as escalated, and records runtime_crash', async () => {
    // The Desktop host ALREADY kills the worker after the grace deadline
    // (`WorkerManager.interruptWorker`). What was missing is that nobody could
    // see it happen, so the run was recorded as a clean `cancelled` — claiming
    // the clean-cancel path was honoured when the process was killed. Contract
    // §D: a hard kill with no clean-exit evidence is `runtime_crash`, with
    // `escalated` and the requested reason recorded.
    const h = harness({ disposition: 'escalated' });
    await open(h);

    const outcome = await h.orchestrator.cancelSession('session-1', 'user');

    expect(outcome?.disposition).toBe('escalated');
    expect(outcome?.terminal.status).toBe('failed');
    expect(h.completions().at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'runtime_crash' },
    });
  });

  it('reports applied: false for a run that already ended', async () => {
    const h = harness();
    await open(h);
    await h.orchestrator.settleSession('session-1');

    const outcome = await h.orchestrator.cancelSession('session-1', 'user');

    expect(outcome?.requested).toBe(true);
    expect(outcome?.applied).toBe(false);
    // A second stop would be a second `chat:interrupt` on the same worker, and
    // `agent-process-entry` treats a double interrupt as "clear the command
    // queue" — a different behaviour, not a louder version of the same one.
    expect(h.interrupts).toHaveLength(0);
  });

  it('returns null for a session that never opened a run', async () => {
    // "There was no run" is not "the run was cancelled". A host that treats
    // null as a success invents a cancellation for a turn that never started.
    const h = harness();

    expect(await h.orchestrator.cancelSession('session-that-never-ran', 'user')).toBeNull();
    expect(h.interrupts).toHaveLength(0);
  });
});

// ── item 5: deleting a chat is the same cancel, through the same arbiter ──

describe('R2.3 — deleting a chat goes through the arbiter', () => {
  function deleteDeps(h: Harness): { deps: unknown; interrupts: number[] } {
    const interrupts: number[] = [];
    const deps = {
      runOrchestrator: h.orchestrator,
      sessionManager: {
        getSession: () => ({ state: 'STREAMING' }),
        transitionState: () => undefined,
      },
      workerManager: {
        interruptWorker: () => {
          interrupts.push(1);
          return { accepted: true, settled: Promise.resolve('cooperative') };
        },
      },
      httpLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      dbRequest: async () => ({ ok: true }),
    };
    return { deps, interrupts };
  }

  function fakeResponse(): { res: unknown; body: () => Record<string, unknown> } {
    let payload: Record<string, unknown> = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead: () => res,
      end: (chunk: string) => {
        payload = JSON.parse(chunk) as Record<string, unknown>;
        res.writableEnded = true;
        return res;
      },
      write: () => true,
      once: () => res,
      on: () => res,
    };
    return { res, body: () => payload };
  }

  it('settles the run and reports the receipt, instead of leaving it running', async () => {
    // This is the defect R2.3 closes. `handleDeleteChat` interrupted the worker
    // and returned, so the run row stayed `running` forever — while the SSE
    // disconnect path thirty lines away interrupted AND settled. A user who
    // stopped a turn by deleting the conversation got no terminal at all.
    const h = harness();
    await open(h);
    const { deps, interrupts } = deleteDeps(h);
    const { res, body } = fakeResponse();

    await handleDeleteChat('session-1', res as never, deps as never);

    // The run is closed, and it is closed as a CANCELLATION, not as a crash:
    // this host asked the worker to stop, one line above the settle.
    expect(h.completions().at(-1)).toMatchObject({ status: 'cancelled' });
    expect(body()).toMatchObject({ ok: true, requested: true, applied: true, disposition: 'cooperative' });
    // Exactly ONE interrupt, and it came from the runtime's own stop. Two
    // `chat:interrupt` commands on one worker is how the worker clears its
    // command queue, which is a different behaviour from the first.
    expect(h.interrupts).toHaveLength(1);
    expect(interrupts).toHaveLength(0);
  });

  it('reports applied: false for a session whose run had already ended', async () => {
    const h = harness();
    await open(h);
    await h.orchestrator.settleSession('session-1');
    const { deps } = deleteDeps(h);
    const { res, body } = fakeResponse();

    await handleDeleteChat('session-1', res as never, deps as never);

    // The old handler answered `{ ok: true, interrupted }` and a host could not
    // tell "I stopped this" from "it had already ended". `applied` is the field
    // that says which happened.
    expect(body()).toMatchObject({ ok: true, requested: true, applied: false });
    expect(body().terminal).toMatchObject({ status: expect.any(String) });
  });

  it('still stops the worker when the session has no run at all', async () => {
    // The route's original job, preserved. With no run there is no runtime stop
    // to inherit, and a streaming worker the user asked to stop must still be
    // stopped — the run layer is additive, not a gate.
    const h = harness();
    const { deps, interrupts } = deleteDeps(h);
    const { res, body } = fakeResponse();

    await handleDeleteChat('session-without-a-run', res as never, deps as never);

    expect(interrupts).toHaveLength(1);
    expect(body()).toMatchObject({ ok: true, requested: false, applied: false });
  });
});
