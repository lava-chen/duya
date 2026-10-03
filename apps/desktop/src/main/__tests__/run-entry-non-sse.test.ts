/**
 * Plan 587 R2.1 — the non-SSE chat turn is inside the run boundary.
 *
 * ## Why this file is separate from `run-entry-single-dispatch.test.ts`
 *
 * It imports `handlePostChatNonSSE`, which the router did not export before
 * R2.1. So before the fix this whole file fails to LOAD — which is the honest
 * signal (the non-SSE path had no observable seam at all), but it would also
 * take the rest of the R2.1 suite red with it. Keeping it alone means every
 * other new test can still be diagnosed on its own.
 *
 * ## What was broken
 *
 * This path never opened a run, never routed a frame through
 * `normalizeAndObserve`, and answered a client disconnect with
 * `{ status: 'interrupted' }` while leaving the worker running. The router's
 * fork even had a comment defending that — "only the SSE branch can record a
 * run faithfully" — which was true, because nothing here recorded anything. Half
 * the product's chat turns left no run row at all.
 *
 * ## What is being decided, not just tested
 *
 * On a client disconnect this path answers `{ events, status: 'interrupted',
 * run }` and settles the run as `cancelled`, and it does NOT interrupt the
 * worker. Both halves are deliberate and both are asserted below:
 *
 *  - The worker keeps running, because contract §D separates disconnect from
 *    cancel and says Desktop keeps its old adapter behaviour. Stopping it would
 *    be a silent behaviour change to a path that never did.
 *  - The run is still closed, as `cancelled` rather than `runtime_crash`.
 *    Silence here means "the client went away", and recording it as a crash
 *    would accuse the runtime of something this handler did.
 *
 * These tests drive the handler with a fake child stdout and a real HTTP
 * response double. They do NOT need a worker process, a provider key, or an
 * Electron host — so they prove the host's OWN bookkeeping, and nothing about
 * what a real `DuyaAgent` emits.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
} from '../agents/server/run-orchestrator';
import { handlePostChatNonSSE, type RouterDeps } from '../agents/server/router';
import type { WorkerInterrupt } from '../agents/server/run-orchestrator';

/**
 * A stop the host has already completed: accepted, and the worker left cleanly.
 *
 * R2.3 gave the interrupt a receipt instead of a boolean, so a double can no
 * longer say "interrupted" without saying HOW. This one says: cleanly.
 */
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

function depsFor(orchestrator: RunOrchestrator): RouterDeps {
  return {
    runOrchestrator: orchestrator,
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
  const orchestrator = new RunOrchestrator({
    dbRequest: async (action, payload) => {
      if (action === 'run:create') return { ok: true, state: 'created', runId: payload.runId };
      if (action === 'run:append') {
        for (const event of payload.events as Array<{ payload: { type: string } }>) {
          appendSink?.(event);
        }
        return { ok: true, state: 'applied', runId: payload.runId, written: (payload.events as unknown[]).length };
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
  return { orchestrator, commands };
}

/** A child process whose stdout is a real readable stream we can write to. */
function fakeChild(): { child: EventEmitter & { stdout: PassThrough }; emit: (line: string) => void } {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout }) as EventEmitter & {
    stdout: PassThrough;
  };
  return {
    child,
    emit: (line: string) => {
      stdout.write(`${line}\n`);
    },
  };
}

/** A response double that records what `sendJson` wrote. */
function fakeResponse(): {
  res: ServerResponse;
  body: () => Record<string, unknown>;
} {
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
  } as unknown as ServerResponse;
  return { res, body: () => payload };
}

/**
 * Let the handler's async settle path finish before asserting.
 *
 * `setImmediate`, not microtask draining: the response is written after a chain
 * of `await`s that cross the fake `dbRequest`, and draining microtasks alone
 * stops before that chain has run.
 */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('R2.1 — the non-SSE chat turn is inside the run boundary', () => {
  it('observes the turn and answers with the run’s real result', async () => {
    const seen: string[] = [];
    const { orchestrator } = makeOrchestrator((event) => seen.push(event.payload.type));
    const { res, body } = fakeResponse();
    const { child, emit } = fakeChild();

    handlePostChatNonSSE(
      'session-1',
      new EventEmitter() as IncomingMessage,
      res,
      child as never,
      depsFor(orchestrator),
    );
    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);

    emit(JSON.stringify({ type: 'chat:turn_start', data: { turnCount: 1 } }));
    emit(JSON.stringify({ type: 'chat:text', data: 'hi' }));
    emit(JSON.stringify({ type: 'chat:done' }));
    await drain();

    // The frames reached the run layer. Before R2.1 this path recorded nothing,
    // so a non-SSE turn left no trace in `runs` at all.
    expect(seen).toContain('run.started');
    // Printed on failure so the diagnosis is one read, not a bisect.
    expect(seen).toContain('run.completed');

    // The response still carries the events it always did — the tee is a copy,
    // not a rewrite — AND the run's own receipt, which it had no way to
    // produce before.
    const payload = body();
    expect(Array.isArray(payload['events'])).toBe(true);
    const run = payload['run'] as { status?: string; runId?: string };
    expect(run.status).toBe('completed');
    expect(run.runId).toBe(start.accepted ? start.runId : null);
  });

  it('settles a disconnected turn as cancelled and leaves the worker running', async () => {
    // The behaviour decision, asserted in both halves so neither can drift.
    const { orchestrator, commands } = makeOrchestrator();
    const { res, body } = fakeResponse();
    const { child, emit } = fakeChild();
    const req = new EventEmitter() as IncomingMessage;

    handlePostChatNonSSE('session-1', req, res, child as never, depsFor(orchestrator));
    await orchestrator.openRun('session-1', intent);

    emit(JSON.stringify({ type: 'chat:turn_start', data: { turnCount: 1 } }));
    await drain();

    // The client goes away mid-turn.
    req.emit('close');
    await drain();

    const payload = body();
    // Old contract preserved verbatim: still `interrupted`, still carrying the
    // events collected so far.
    expect(payload['status']).toBe('interrupted');
    expect(Array.isArray(payload['events'])).toBe(true);

    // NEW: the run is closed, and honestly. `cancelled`, not `runtime_crash` —
    // this handler stopped observing, and `resolveRunOutcome` reads a
    // host-requested stop as a cancellation rather than a runtime failure.
    const run = payload['run'] as { status?: string };
    expect(run.status).toBe('cancelled');

    // And the worker was NOT interrupted. Contract §D separates disconnect from
    // cancel; Desktop keeps its old adapter behaviour here. An `interrupt` in
    // this list would be a silent behaviour change to a path that never had one.
    expect(commands).not.toContain('interrupt');
  });

  it('answers a session with no run with no fabricated receipt', async () => {
    // The orchestrator is optional in `RouterDeps` (every existing embedder
    // constructs deps without it). Absence must be reported as absence, never as
    // a successful run.
    const { res, body } = fakeResponse();
    const { child, emit } = fakeChild();
    const req = new EventEmitter() as IncomingMessage;

    handlePostChatNonSSE(
      'session-1',
      req,
      res,
      child as never,
      depsFor(undefined as unknown as RunOrchestrator),
    );
    emit(JSON.stringify({ type: 'chat:done' }));
    await drain();

    const payload = body();
    expect(Array.isArray(payload['events'])).toBe(true);
    expect(payload['run']).toBeUndefined();
  });
});
