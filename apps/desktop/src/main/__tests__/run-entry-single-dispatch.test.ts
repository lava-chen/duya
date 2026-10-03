/**
 * Plan 587 R2.1 — the single run entry, driven the way the router drives it.
 *
 * ## What was wrong, in four separate ways
 *
 * 1. **Two dispatches.** `openRun` opened the run and the channel fired a
 *    callback that knew a bare run id; the router then sent the real
 *    `chat:start` itself, with a SECOND freshly minted id. Nothing connected
 *    them, so a run could exist with an executor that had never been told it
 *    was executing anything.
 * 2. **A fake running run.** `sendCommand` returns `false` when no worker is
 *    there, and the router discarded that. The run opened, looked live, and
 *    nothing would ever close it.
 * 3. **No manifest or input identity on the command.** The executor was told
 *    what to do but not which run it was executing or what it had been given.
 * 4. **The non-SSE path recorded nothing**, so half the product's chat turns
 *    had no run row at all — and a reconnect GET and the POST tee were the only
 *    thing keeping "observed exactly once" true by convention rather than by
 *    construction.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the ADAPTER and the ORDERING, offline, with no worker process and
 * no provider key. They do NOT prove that a real `DuyaAgent` consumes the
 * canonical id — that needs a live worker, and the last hop
 * (`chat:start.runId` → `ChatOptions.runId`) is covered by
 * `packages/agent/tests/unit/agent/run-identity.test.ts` at the seam rather than
 * end to end. A harness that only works with mocks is not proof for a
 * host-boundary claim, so nothing here claims it.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NON_DESKTOP_CONSUMERS,
  RUN_ENTRY_DIVERGENCES,
  RunOrchestrator,
  createWorkerExecutionChannel,
  type ChatStartCommand,
} from '../agents/server/run-orchestrator';
import { normalizeAndObserve, type RouterDeps } from '../agents/server/router';
import { manifestFor } from './run-entry-manifest-fixture';

interface Call {
  action: string;
  payload: Record<string, unknown>;
}

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  prompt: 'hello',
  options: {} as Record<string, unknown>,
};

function recorder(): { calls: Call[]; request: (a: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'run:create') return { ok: true, runId: payload.runId };
      if (action === 'run:append') return { ok: true, written: (payload.events as unknown[]).length };
      return { ok: true, applied: true };
    },
  };
}

describe('R2.1 — one run entry dispatches the turn', () => {
  it('issues exactly one chat:start, carrying the run’s own identity', async () => {
    const { calls, request } = recorder();
    const sent: ChatStartCommand[] = [];
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({
        dispatch: (command) => {
          sent.push(command);
          return true;
        },
        interrupt: () => true,
      }),
    });

    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);
    if (!start.accepted) throw new Error('unreachable');

    // ONE dispatch. Before this the router sent its own command as well, so
    // the executor was told to begin twice with two different ids.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('chat:start');
    expect(sent[0]?.runId).toBe(start.runId);
    expect(sent[0]?.sessionId).toBe('session-1');
    // The prompt travels through the run rather than beside it. Two parallel
    // descriptions of one turn is the double source of truth §R2.2 names.
    expect(sent[0]?.prompt).toBe('hello');

    // The manifest reference is the hash the Control Plane already pinned on the
    // row — not a second computation of it.
    const created = calls.find((c) => c.action === 'run:create');
    expect(sent[0]?.manifestHash).toBe(created?.payload.manifestHash);
    expect(typeof sent[0]?.inputRevision).toBe('string');
    expect((sent[0]?.inputRevision as string).length).toBe(64);

    // The turn id is a TURN id. Reusing the run id for it would make the two
    // identities indistinguishable again, which is how they got confused.
    expect(sent[0]?.id).not.toBe(start.runId);
  });

  it('binds the session to the run BEFORE it dispatches', async () => {
    // This is the hazard the single entry creates: dispatch now happens inside
    // `openRun`, so the executor can produce its first frame while the host is
    // still inside `openRun`. The router's tee resolves a session to its run
    // through that binding, so binding afterwards would race the very first
    // frame of every turn.
    //
    // It used to pass only because a frame cannot arrive on a microtask — an
    // accident of scheduling, not a guarantee. Here `dispatch` observes a frame
    // SYNCHRONOUSLY, which is the hostile version of the race.
    const { request } = recorder();
    let orchestrator: RunOrchestrator;
    let observedLate = false;
    orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({
        dispatch: () => {
          const outcome = orchestrator.observe('session-1', {
            type: 'turn_start',
            data: { turnCount: 1 },
          });
          observedLate = outcome.late;
          return true;
        },
        interrupt: () => true,
      }),
    });

    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);
    // The frame landed in a live run, not in "no run / already ended".
    expect(observedLate).toBe(false);
    expect(orchestrator.runForSession('session-1')).not.toBeNull();
  });

  it('reports a worker that is not there as NOT ACCEPTED, and closes the run', async () => {
    // `sendCommand` returning `false` is the ordinary "there is no worker to
    // run this on". The router used to discard it: the run opened, looked live,
    // and nothing would ever close it.
    const { calls, request } = recorder();
    let dispatched = false;
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({
        dispatch: () => {
          dispatched = true;
          return false;
        },
        interrupt: () => true,
      }),
    });

    const start = await orchestrator.openRun('session-1', intent);
    expect(start).toMatchObject({ accepted: false, stage: 'dispatch_refused' });

    // Nothing was asked to execute — "not accepted" and "not dispatched" are
    // the same fact now, which is the property R2.1 asks for.
    expect(dispatched).toBe(true);
    expect(orchestrator.runForSession('session-1')).toBeNull();

    // And no run is left LOOKING live. The row existed (run:create succeeded),
    // so it had to be closed: a `running` row nothing will ever finish is the
    // exact shape of the bug.
    const complete = calls.find((c) => c.action === 'run:complete');
    expect(complete).toBeDefined();
    const terminal = complete?.payload.terminal as { status?: string; error?: { code?: string } };
    expect(terminal?.status).toBe('failed');
    expect(terminal?.error?.code).not.toBeUndefined();
  });

  it('reaches the host’s existing stop function through ExecutionHandle.stop', async () => {
    // `ExecutionHandle.stop` used to be an empty function, so `cancel` returned
    // `{ applied: true }` — the one field a host reads to know its stop did
    // something — for a stop that had touched nothing at all.
    //
    // Exercised on the channel directly rather than through a new orchestrator
    // cancel route. `RunController.cancel` is already proven to call
    // `handle.stop(graceMs)` and to re-check `isClosed` afterwards (R1.2), so
    // the only uncovered part is the last hop: does that stop reach the host's
    // EXISTING interrupt, or nowhere? Adding a public cancel route here would
    // be a new entry the product does not call yet, and re-wiring the DELETE
    // handler onto the arbiter is R2.3.
    const interrupts: Array<{ sessionId: string; graceMs: number; reason: string }> = [];
    const channel = createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: (sessionId, graceMs, reason) => {
        interrupts.push({ sessionId, graceMs, reason });
        return true;
      },
    });
    const manifest = manifestFor({ runId: 'run-1', sessionId: 'session-1' });

    const handle = await channel.start(
      manifest,
      { sessionId: 'session-1', prompt: 'hello', options: {}, revision: 'a'.repeat(64) },
      { frame: () => undefined, end: () => undefined },
    );
    await handle.stop(2000);

    // ONE call, keyed by session, through the host's existing function. Not a
    // second interrupt invented here.
    expect(interrupts).toEqual([
      { sessionId: 'session-1', graceMs: 2000, reason: 'run-cancel' },
    ]);
  });

  it('records each worker frame once, under the dispatched run’s own id', async () => {
    // §R2.1's "the message SSE tee observes exactly once". The structural
    // guarantee is that exactly ONE POST branch runs per request and the GET
    // reconnect view never calls the tee; what this pins is the two consequences
    // that would break first if it did.
    //
    // The id assertion is the R2.1 half: before this, the run layer's channel
    // and the router's `chat:start` carried two unrelated ids, so there was no
    // single "the run this turn executed as" to compare. Now there is, and every
    // durable event has to be filed under it.
    const { calls, request } = recorder();
    const sent: ChatStartCommand[] = [];
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({
        dispatch: (command) => {
          sent.push(command);
          return true;
        },
        interrupt: () => true,
      }),
    });
    const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;

    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);

    const frames = [
      { type: 'chat:turn_start', data: { turnCount: 1 } },
      { type: 'chat:text', data: 'hello' },
      { type: 'chat:done' },
    ];
    for (const frame of frames) normalizeAndObserve('session-1', frame, deps);
    await orchestrator.settleSession('session-1');

    // Every durable write is filed under the id the executor was told to run as.
    const appended = calls.filter((c) => c.action === 'run:append');
    expect(appended.length).toBeGreaterThan(0);
    for (const call of appended) expect(call.payload.runId).toBe(sent[0]?.runId);

    const seqs = appended.flatMap((c) =>
      (c.payload.events as Array<{ seq: number }>).map((e) => e.seq),
    );
    // Gapless from 1, and every seq appears once. A second observer would
    // append a second event for the same worker frame and break the gapless run.
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Re-observing the same frames — what a second tee or a replaying reader
    // would do — records nothing. The terminal is decided and immutable.
    const before = calls.length;
    for (const frame of frames) normalizeAndObserve('session-1', frame, deps);
    expect(calls).toHaveLength(before);
  });

  it('answers the non-SSE turn with a real RunResult', async () => {
    // The non-SSE path opened no run at all, so half the product's chat turns
    // had no run row. It has no event stream to read an outcome off, so it must
    // get the runtime's own `RunResult` — which is only readable from the
    // handle the start returned.
    const { request } = recorder();
    const orchestrator = new RunOrchestrator({
      dbRequest: request,
      channel: createWorkerExecutionChannel({ dispatch: () => true, interrupt: () => true }),
    });
    const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;

    const start = await orchestrator.openRun('session-1', intent);
    expect(start.accepted).toBe(true);

    normalizeAndObserve('session-1', { type: 'chat:turn_start', data: { turnCount: 1 } }, deps);
    normalizeAndObserve('session-1', { type: 'chat:text', data: 'hi' }, deps);
    normalizeAndObserve('session-1', { type: 'chat:done' }, deps);
    await orchestrator.settleSession('session-1');

    const result = await orchestrator.resultFor('session-1');
    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(result?.runId).toBe(start.accepted ? start.runId : null);

    // A session that never had a run gets `null`, NOT a fabricated success.
    expect(await orchestrator.resultFor('session-never-ran')).toBeNull();
  });
});

describe('R2.1 — the consumers this PR does NOT move', () => {
  it('registers every non-Desktop producer with paths that still exist', () => {
    const root = resolve(__dirname, '../../../../..');
    expect(NON_DESKTOP_CONSUMERS.length).toBeGreaterThan(0);
    for (const entry of NON_DESKTOP_CONSUMERS) {
      expect(existsSync(resolve(root, entry.startPath)), `${entry.consumer} startPath`).toBe(true);
      expect(existsSync(resolve(root, entry.permissionPath)), `${entry.consumer} permissionPath`).toBe(
        true,
      );
      if (entry.stopPath !== null) {
        expect(existsSync(resolve(root, entry.stopPath)), `${entry.consumer} stopPath`).toBe(true);
      }
      // Every one of them is registered for the migration slice, not migrated
      // here. A row that claims `H8` for something already moved would be the
      // kind of drift this file exists to catch.
      expect(entry.ownedBy).toBe('H8');
    }
  });

  it('records the CLI divergence instead of pretending the CLI is a consumer', () => {
    // Plan 587 §R2.1 lists `packages/cli` as a consumer of the single run entry.
    // It is not one: it is HTTP CRUD, and the real headless entry constructs a
    // `DuyaAgent` directly, bypassing `chat:start`. Reporting it as migrated
    // on the strength of a Desktop-only change would be the worst outcome.
    expect(RUN_ENTRY_DIVERGENCES).toHaveLength(1);
    expect(RUN_ENTRY_DIVERGENCES[0]?.claim).toContain('packages/cli');
    expect(RUN_ENTRY_DIVERGENCES[0]?.reality).toContain('packages/agent/src/cli/index.ts');
    expect(
      NON_DESKTOP_CONSUMERS.some((entry) => entry.consumer.includes('cli')),
    ).toBe(false);
  });
});
