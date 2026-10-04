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
 * On a client disconnect this path writes NOTHING and settles NOTHING, and it
 * does NOT interrupt the worker. All three halves are deliberate and all three
 * are asserted below:
 *
 *  - The worker keeps running, because contract §D separates disconnect from
 *    cancel and says Desktop keeps its old adapter behaviour. Stopping it would
 *    be a silent behaviour change to a path that never did.
 *  - The run stays OPEN. It used to be closed here as `cancelled`, which made a
 *    turn that was still executing look finished — and the worker's later tool
 *    calls and results then landed after a run the database had already closed.
 *  - No response is written, because the response that would carry it is the
 *    one that just went away.
 *
 * The run is still closed, eventually, by the worker's real terminal frame —
 * which is a fact about the run rather than about the socket. An explicit stop
 * is a different request and goes through `cancelSession`.
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

  it('settles nothing on disconnect, and still keeps the worker running', async () => {
    // The behaviour decision, asserted in every part so none can drift.
    //
    // This used to assert the opposite: a disconnect answered
    // `{ status: 'interrupted', events }` and persisted the run as
    // `cancelled`, with a comment calling that "honest". It was not. The
    // worker kept running either way, so a turn that was still executing was
    // recorded as finished, and its later tool calls and results landed after
    // a run the database had already closed.
    //
    // A disconnect is a CONNECTION fact. It changes what may still be
    // WRITTEN, never what the run is. The real terminal frame settles the run.
    const seen: string[] = [];
    const { orchestrator, commands } = makeOrchestrator((event) => seen.push(event.payload.type));
    const { res, body } = fakeResponse();
    const { child, emit } = fakeChild();
    const req = new EventEmitter() as IncomingMessage;

    handlePostChatNonSSE('session-1', req, res, child as never, depsFor(orchestrator));
    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);

    emit(JSON.stringify({ type: 'chat:turn_start', data: { turnCount: 1 } }));
    await drain();
    expect(seen).toContain('run.started');

    // The client goes away mid-turn.
    req.emit('close');
    await drain();

    // Nothing was written. The response this would have written is the one
    // that just went away, and aiming a body at it surfaces as a stream error
    // on a socket nobody owns.
    expect(body()).toEqual({});
    expect(res.writableEnded).toBe(false);

    // The run was NOT closed. `run.started` is still the only run event, so
    // there is no terminal of any kind — cancelled, crashed or completed —
    // manufactured out of a socket closing.
    expect(seen.filter((type) => type.startsWith('run.'))).toEqual(['run.started']);

    // And the worker was NOT interrupted. Contract §D separates disconnect
    // from cancel; Desktop keeps its old adapter behaviour here. An
    // `interrupt` in this list would be a silent behaviour change to a path
    // that never had one. An explicit stop is a different request and goes
    // through `cancelSession`.
    expect(commands).not.toContain('interrupt');

    // The turn still finishes, on the worker's own verdict, recorded into the
    // run that stayed open for it.
    emit(JSON.stringify({ type: 'chat:done' }));
    await drain();
    expect(seen).toContain('run.completed');

    // ...and still writes nothing, because there is no longer anyone to read
    // it. Settling the run and answering the client are separate acts.
    expect(body()).toEqual({});
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
