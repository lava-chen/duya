/**
 * Plan 587 H8.2 — the `RunResult` read that automation settles on.
 *
 * ## The gap this closes
 *
 * `automation/agent-run.ts` submitted its durable intent through the same
 * `POST /sessions/:id/chat` the renderer uses, so "submit to the CP" was
 * already true. The other half was not: it settled on the worker's SSE `done`
 * FRAME and called that success. A turn that was cancelled, that stopped on a
 * budget ceiling, or that failed inside the runtime can still be followed by a
 * `done` frame, so a scheduler could record a successful wake for a run that
 * did not succeed.
 *
 * `handleGetRunResult` is the read that makes the run layer's terminal the
 * authority instead. It is a read of an already-decided verdict, so it cannot
 * widen the permission or budget gate — it is how automation learns the gate
 * said no.
 *
 * ## What these tests drive
 *
 * A REAL `RunOrchestrator` over a REAL `RunController`, with the Control Plane
 * `dbRequest` faked at the boundary and the worker channel faked at the
 * dispatch boundary. Frames are pushed through the orchestrator's own
 * `observe`, and the `RunResult` that comes back is the runtime's own —
 * `handle.result()` on the controller's handle, not a value this file wrote.
 *
 * So the terminal asserted here is decided by the run layer. What is NOT
 * crossed: no worker process, no provider, no Electron host, and no SQLite
 * file. The durable WRITE side is covered by the CP tests; this file is
 * about who is allowed to say the run finished, and how.
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';
import { handleGetRunResult, type RouterDeps } from '../agents/server/router';
import type { WorkerInterrupt } from '../agents/server/run-orchestrator';

const COOPERATIVE_INTERRUPT: WorkerInterrupt = {
  accepted: true,
  settled: Promise.resolve('cooperative'),
};

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  prompt: 'hello',
  options: {} as Record<string, unknown>,
};

function depsFor(orchestrator: RunOrchestrator | null): RouterDeps {
  return {
    runOrchestrator: orchestrator ?? undefined,
    httpLogger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as RouterDeps;
}

function makeOrchestrator(appendSink?: (event: { payload: { type: string } }) => void) {
  const commands: string[] = [];
  const runIds: string[] = [];
  const orchestrator = new RunOrchestrator({
    dbRequest: async (action, payload) => {
      if (action === 'run:create') {
        runIds.push(payload.runId as string);
        return { ok: true, state: 'created', runId: payload.runId };
      }
      if (action === 'run:append') {
        for (const event of payload.events as Array<{ payload: { type: string } }>) {
          appendSink?.(event);
        }
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
      dispatch: () => {
        commands.push('chat:start');
        return true;
      },
      interrupt: () => {
        commands.push('interrupt');
        return COOPERATIVE_INTERRUPT;
      },
    }),
  });
  return { orchestrator, commands, runIds };
}

/** A response double that records what `sendJson` wrote. */
function fakeResponse(): {
  res: ServerResponse;
  body: () => Record<string, unknown>;
  status: () => number;
} {
  let payload: Record<string, unknown> = {};
  let code = 0;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead: (statusCode: number) => {
      code = statusCode;
      res.headersSent = true;
      return res;
    },
    end: (chunk: string) => {
      payload = JSON.parse(chunk) as Record<string, unknown>;
      res.writableEnded = true;
      return res;
    },
    write: () => true,
    once: () => res,
    on: () => res,
  } as unknown as ServerResponse;
  return { res, body: () => payload, status: () => code };
}

const drain = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('H8.2 — a host can read the run layer’s terminal, not the worker’s frame', () => {
  it('answers with the RunResult the runtime decided, for a completed turn', async () => {
    const seen: string[] = [];
    const { orchestrator } = makeOrchestrator((event) => seen.push(event.payload.type));
    const { res, body, status } = fakeResponse();

    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);

    // Drive the run the way the router does, through its own `observe`.
    orchestrator.observe('session-1', { type: 'chat:turn_start', data: { turnCount: 1 } });
    orchestrator.observe('session-1', { type: 'chat:text', data: 'hi' });
    orchestrator.observe('session-1', { type: 'chat:done' });
    await drain();

    await handleGetRunResult('session-1', res, depsFor(orchestrator));

    expect(status()).toBe(200);
    const run = body()['run'] as { status?: string; runId?: string; sessionId?: string };
    // The terminal is the RUN LAYER's, and it is the same terminal the run
    // wrote to its durable record — `run.completed` was appended above.
    expect(seen).toContain('run.completed');
    expect(run.status).toBe('completed');
    expect(run.runId).toBe(start.runId);
    expect(run.sessionId).toBe('session-1');
  });

  it('reports a cancelled turn as cancelled, not as a completed one', async () => {
    // The case the `done` frame gets wrong in the direction that matters: a
    // host that treats "the stream finished" as success records a success here.
    const { orchestrator } = makeOrchestrator();
    const { res, body, status } = fakeResponse();

    await orchestrator.openRun('session-1', intent);
    orchestrator.observe('session-1', { type: 'chat:turn_start', data: { turnCount: 1 } });
    await drain();

    const outcome = await orchestrator.cancelSession('session-1', 'user stopped it');
    expect(outcome).not.toBeNull();
    await drain();

    await handleGetRunResult('session-1', res, depsFor(orchestrator));

    expect(status()).toBe(200);
    const run = body()['run'] as { status?: string; stopReason?: string };
    expect(run.status).toBe('cancelled');
  });

  it('answers with a null run for a session that never ran, and never as a success', async () => {
    const { orchestrator } = makeOrchestrator();
    const { res, body, status } = fakeResponse();

    await handleGetRunResult('session-never-ran', res, depsFor(orchestrator));

    // 200, because "this host has nothing for that session" is an answer, not
    // a transport failure. But `run` is null and `runId` is null: a consumer
    // that cannot confirm a terminal must not be handed one (contract §C).
    expect(status()).toBe(200);
    expect(body()['run']).toBeNull();
    expect(body()['runId']).toBeNull();
  });

  it('answers 501 on a host with no run layer, which is not the same as completed', async () => {
    const { res, body, status } = fakeResponse();

    await handleGetRunResult('session-1', res, depsFor(null));

    // The distinction this route exists to preserve: "this build cannot tell
    // you" must never be laundered into "that run succeeded".
    expect(status()).toBe(501);
    expect(body()['run']).toBeNull();
  });

  it('is a read: asking for the result does not settle or end the turn', async () => {
    // Contract §C: `result()` only waits; it must not settle. Asserted by
    // asking for the result of a turn that is still mid-flight, and then
    // driving that same turn to its own terminal — a route that settled the
    // run would have ended it early and the later frames would go nowhere.
    const seen: string[] = [];
    const { orchestrator, commands } = makeOrchestrator((event) => seen.push(event.payload.type));
    const { res } = fakeResponse();

    await orchestrator.openRun('session-1', intent);
    orchestrator.observe('session-1', { type: 'chat:turn_start', data: { turnCount: 1 } });
    await drain();

    // The read is issued while the run is still live.
    void handleGetRunResult('session-1', res, depsFor(orchestrator));
    await drain();

    // The run carried on: it was not closed by the read.
    orchestrator.observe('session-1', { type: 'chat:done' });
    await drain();

    expect(seen).toContain('run.completed');
    // Exactly one dispatch — the read started no second execution.
    expect(commands.filter((c) => c === 'chat:start')).toHaveLength(1);
  });
});
