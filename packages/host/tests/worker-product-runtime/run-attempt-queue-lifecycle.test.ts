/**
 * Plan 610 S1 follow-up: the RUN LAYER's own housekeeping — the attempt's
 * lifecycle, and the queue the synchronous tee creates.
 *
 * ## Why this file exists
 *
 * Two per-run structures outlived the run they belonged to:
 *
 *  - **The attempt.** It was a bare `Map<runId, number>` captured once at
 *    `openRun` and deleted at `#release` — which runs BEFORE
 *    `controller.settle`. So the terminal CAS, the one write the attempt fence
 *    exists for, found no entry and was sent with NO `epoch` at all. A start
 *    that threw leaked its entry outright, because `#forgetRun` released the
 *    model binding and not the attempt.
 *  - **The queue.** `queueNativeRunEvent` wrote `#nativeQueues` unconditionally
 *    and the only cleanup was identity-guarded on the tail `#finish` had
 *    drained. A frame enqueued after that cleanup re-created an entry nothing
 *    would ever remove, for every conversation that ended mid-write, forever.
 *
 * ## What is REAL here
 *
 * Real: `RunOrchestrator`, `RunController`, the wire validation, a real SQLite
 * `RunStore` with the real migrations, and a real native writer over it. The
 * frames are wire frames, enqueued through the same public method the Desktop
 * router calls.
 *
 * NOT real: the Desktop router's own tee, and a worker process. The Desktop
 * half of both claims — what a client is TOLD — is in
 * `apps/desktop/src/main/__tests__/terminal-publication-barrier.test.ts`, which
 * drives `normalizeAndObserve` and the real route handlers. Everything here is
 * orchestrator-level and is labelled as such.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { RunTerminalState } from '@duya/agent-runtime';

const { RunOrchestrator, createWorkerExecutionChannel } = await import('@duya/host/run-orchestrator');
const { writeRunReceiptOnWire } = await import('@duya/host/run-receipt');
const { RunStore, RUN_STORE_MIGRATIONS, RunEpochFencedError } = await import('@duya/data/run-store');

const SESSION_ID = 's-attempt-lifecycle';
const EPOCH = 0;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

function trackTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** One durable write, with the attempt it was made under. */
interface DurableCall {
  readonly kind: 'append' | 'complete';
  readonly epoch?: unknown;
  readonly type?: string;
}

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: InstanceType<typeof RunOrchestrator>;
  readonly calls: DurableCall[];
  readonly refusals: string[];
  readonly openResult: { readonly accepted: boolean; readonly runId: string | null };
  readonly close: () => void;
}

async function openHarness(
  options: { readonly acceptDispatch?: boolean; readonly degradeCreateReply?: boolean } = {},
): Promise<Harness> {
  const dbDir = trackTempDir('duya-attempt-lifecycle-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  const calls: DurableCall[] = [];

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      if (options.degradeCreateReply === true) {
        // The real historical shape: the ROW was written by real code and only
        // the REPLY on the way back is unreadable, so the caller learns "no run"
        // while a `running` row exists with nothing that will ever move it.
        return { ok: 'yes', note: 'a reply the reader cannot parse' };
      }
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId: outcome.runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
    }
    if (action === 'run:append') {
      const { events } = payload as { events: readonly RunEventEnvelope[] };
      calls.push({ kind: 'append', epoch: payload['epoch'], type: events[0]?.payload.type });
      const written = store.appendEvents(events);
      return writeRunReceiptOnWire({ state: 'applied', runId: (payload as { runId: string }).runId }, { written });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: RunTerminalState };
      calls.push({ kind: 'complete', epoch: payload['epoch'], type: terminal.status });
      const outcome = store.settleRun(runId, terminal);
      return outcome.state === 'applied'
        ? writeRunReceiptOnWire({ state: 'applied', runId })
        : writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

  const refusals: string[] = [];

  const orchestrator = new RunOrchestrator({
    nativeWriter: {
      currentEpoch: (runId: string) => store.currentEpoch(runId),
      append: (runId: string, envelopes: readonly RunEventEnvelope[], presented: number) => {
        try {
          const written = store.appendEvents(envelopes, presented);
          return written === 0 ? { state: 'duplicate' } : { state: 'written', written };
        } catch (error) {
          if (error instanceof RunEpochFencedError) {
            return { state: 'fenced', presented, current: store.currentEpoch(runId) ?? 0 };
          }
          throw error;
        }
      },
    },
    logger: {
      info: () => {},
      warn: (message: string, data?: Record<string, unknown>) => refusals.push(`${message} ${JSON.stringify(data ?? {})}`),
      error: (message: string, data?: Record<string, unknown>) => refusals.push(`${message} ${JSON.stringify(data ?? {})}`),
    } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => options.acceptDispatch ?? true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const opened = await orchestrator.openRun(SESSION_ID, {
    prompt: 'attempt lifecycle proof',
    options: { sessionId: SESSION_ID },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: trackTempDir('duya-attempt-lifecycle-ws-'),
  } as never);

  return { store, orchestrator, calls, refusals, openResult: opened, close: () => db.close() };
}

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function frame(runId: string, seq: number, type: string, epoch = EPOCH): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch,
    envelope: { runId, sessionId: SESSION_ID, seq, payload: { type } },
  };
}

describe('plan-610 S1 run layer — the attempt has a lifecycle', () => {
  it('is established when the run opens, and readable while the run is live', async () => {
    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;

      // Established at OPEN, not at write time: the number exists before a
      // single frame has arrived, because it is the attempt the run was
      // dispatched under.
      expect(harness.orchestrator.attemptFor(runId)).toEqual({ epoch: EPOCH, retired: false, superseded: null });
      expect(harness.orchestrator.retainedAttempts).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('is presented on run:complete, which is the write the fence exists for', async () => {
    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;
      for (const line of [frame(runId, 2, 'turn.started'), frame(runId, 3, 'run.completed')]) {
        harness.orchestrator.queueNativeRunEvent(SESSION_ID, line);
      }
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      const complete = harness.calls.find((call) => call.kind === 'complete');
      expect(complete).toBeDefined();
      // `#release` runs BEFORE `controller.settle`, so an attempt that was
      // DELETED rather than retired at release left this write with no epoch at
      // all — an unfenced terminal CAS, which is precisely the case the fence is
      // supposed to stop.
      expect(complete?.epoch).toBe(EPOCH);
    } finally {
      harness.close();
    }
  });

  it('is retired when the run ends and gone afterwards, so it cannot present again', async () => {
    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      // Ended: no live attempt to present, and the binding is released rather
      // than left for the next turn of this session to find.
      expect(harness.orchestrator.attemptFor(runId)).toBeNull();
      expect(harness.orchestrator.retainedAttempts).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('leaves nothing behind when the start is refused', async () => {
    // The attempt is established two lines before `controller.start`, so a
    // dispatch refusal used to leave one permanent entry for a run that never
    // executed anything.
    const harness = await openHarness({ acceptDispatch: false });
    try {
      expect(harness.openResult.accepted).toBe(false);
      expect(harness.orchestrator.retainedAttempts).toBe(0);
      expect(harness.orchestrator.attemptFor(harness.openResult.runId as string)).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('names the attempt the run was opened under when the store reports it superseded', async () => {
    // The run layer cannot poll the attempt — the store owns it, and this host
    // may not even be able to read it. A `fenced` refusal is therefore the only
    // observation available, so the log has to carry BOTH numbers: the one the
    // run was opened under and the one that now holds write authority.
    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;
      // Opened under 0, and the store has since moved to a new attempt.
      expect(harness.store.beginAttempt(runId)).toBe(1);
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 2, 'turn.started'));

      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      const fenced = harness.refusals.filter((line) => line.includes('superseded attempt'));
      expect(fenced).toHaveLength(1);
      expect(fenced[0]).toContain('"established":0');
      expect(fenced[0]).toContain('"current":1');
      // Stated, because "we found out at write time" is the honest half of the
      // claim and a reader would otherwise assume it was polled.
      expect(fenced[0]).toContain('learnedAt');
    } finally {
      harness.close();
    }
  });
});

describe('plan-610 S1 run layer — an abandoned run still lands its terminal', () => {
  it('presents an attempt on both writes, so the row is never left running', async () => {
    // `run:create` wrote the row and the REPLY came back unreadable, so
    // `openRun` reports `run_not_created` while a `running` row exists that
    // nothing will ever execute. `#closeAbandonedRun` is the only thing that can
    // close it.
    //
    // Both of its writes are FENCED writes. A payload with no readable attempt is
    // refused rather than made unfenced, so a close that forgot the attempt
    // leaves the row exactly as stranded as not having called it at all — the
    // failure this test exists to keep from coming back.
    const harness = await openHarness({ degradeCreateReply: true });
    try {
      expect(harness.openResult.accepted).toBe(false);
      expect(harness.openResult.stage).toBe('run_not_created');

      // The run this Host was trying to open is the row the store really wrote.
      const row = harness.store.listRunsBySession(SESSION_ID)[0];
      expect(row).toBeDefined();
      const runId = row?.id as string;
      // Not left `running`: that is the whole claim.
      expect(row?.status).toBe('failed');
      expect(row?.terminal).toBe('failed');
      expect(row?.finished_at).not.toBeNull();

      // Both writes carried the attempt, rather than relying on a default.
      const append = harness.calls.find((call) => call.kind === 'append');
      const complete = harness.calls.find((call) => call.kind === 'complete');
      expect(append?.epoch).toBe(EPOCH);
      expect(complete?.epoch).toBe(EPOCH);

      // And the run layer kept nothing for a run that never dispatched.
      expect(harness.orchestrator.retainedAttempts).toBe(0);
      expect(harness.orchestrator.retainedNativeQueues).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe('plan-610 S1 run layer — a late frame retains nothing', () => {
  it('refuses a run:event that arrives after its run settled, and keeps no queue for it', async () => {    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 2, 'turn.started'));
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      // The run is over and the session will never run again.
      expect(harness.orchestrator.retainedNativeQueues).toBe(0);

      // The worker's stdout can still be delivering: the `done` frame settles
      // the run while lines are in flight. This is the enqueue that used to
      // re-create an entry nothing would ever remove.
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 3, 'assistant.text_block'));

      // Refused, with the same sentence the awaited path uses, so a log search
      // for this refusal does not depend on which side of the boundary the frame
      // landed.
      const refusals = harness.refusals.filter((line) => line.includes('no live run'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain(`session ${SESSION_ID} has no live run`);
      // And the refusal is what keeps the map from growing: no entry was made.
      expect(harness.orchestrator.retainedNativeQueues).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('still queues and drains the frames of a LIVE run', async () => {
    // The guard must not break the case it exists beside: frames arriving while
    // the run is live still serialize onto the tail and still land in order.
    const harness = await openHarness();
    try {
      const runId = harness.openResult.runId as string;
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 2, 'turn.started'));
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 3, 'assistant.text_block'));
      harness.orchestrator.queueNativeRunEvent(SESSION_ID, frame(runId, 4, 'run.completed'));
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      expect(harness.store.listEvents(runId, 0).map((row) => `${row.event_type}#${row.seq}`)).toEqual([
        'turn.started#2',
        'assistant.text_block#3',
        'run.completed#4',
      ]);
      expect(harness.orchestrator.retainedNativeQueues).toBe(0);
    } finally {
      harness.close();
    }
  });
});
