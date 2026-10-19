/**
 * Plan 610 S1: the two run-layer guarantees whose ONLY guard died with the
 * Desktop `RunOrchestrator`.
 *
 * ## Why this file exists
 *
 * `apps/desktop/src/main/agents/server/run-orchestrator.ts` is now two lines:
 *
 * ```ts
 * export * from '@duya/host/run-orchestrator';
 * ```
 *
 * `apps/desktop/src/main/__tests__/run-orchestrator.test.ts` still builds its
 * fixture for the Desktop-local implementation it used to own, so eight of its
 * cases fail with one signature: **no `run:*` durable call was recorded at
 * all** (`findIndex(...) === -1`, empty refusal arrays). Six of the eight have a
 * live equivalent on this side (`native-channel-faults` CASE 1-4,
 * `run-attempt-queue-lifecycle` "leaves nothing behind when the start is
 * refused"). Two did not:
 *
 *  1. `records run.started before the first frame is observed`
 *  2. `keeps concurrent sessions on separate runs`
 *
 * `grep` for either guarantee's wording hits that one now-red file and nothing
 * else. A red test still reads as "somebody is on it"; here nobody is.
 *
 * ## Guarantee 1 had to be RESTATED, not copied
 *
 * The old case asserted that `run:append` carrying `run.started` alone landed
 * before the first frame. **That write no longer exists**: this orchestrator
 * issues exactly two durable actions, `run:create` (`:707`) and `run:complete`
 * (`:574`). Event persistence belongs to the native channel alone.
 *
 * So the assertion below pins the guarantee's INTENT — "a run that crashes on
 * its first frame still leaves the record of what it was given" — against the
 * mechanism that now carries it: the durable **run row**, written before the
 * worker is dispatched. Copying the old assertions would have produced a test
 * that could only ever fail.
 *
 * ## What is REAL here
 *
 * Real `RunOrchestrator`, real `RunController`, a real SQLite `RunStore` with
 * the real migrations, a real native writer over it, and the real execution
 * channel. Native frames go in through `queueNativeRunEvent`, the same public
 * method the Desktop router calls.
 *
 * NOT real: a worker process, and the Desktop router's own tee (that half is
 * `apps/desktop/src/main/__tests__/terminal-publication-barrier.test.ts`).
 * Everything here is run-layer level and is labelled as such.
 *
 * ## Why these assertions have teeth
 *
 * Both read the DATABASE, not a call log:
 *
 *  - ordering is measured by asking the dispatch spy whether `run:create` had
 *    already returned when it ran, so dispatching one tick earlier flips it;
 *  - `countEvents(runId) === 0` is asserted alongside the row, so a future
 *    change that re-adds an event-level `run.started` cannot quietly make the
 *    row assertion vacuous by becoming the only record;
 *  - isolation is measured with `listEvents` per run, so "each session wrote
 *    something" cannot be satisfied by both sessions appending into ONE row.
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

const EPOCH = 0;
const SESSION_A = 's-open-durability-a';
const SESSION_B = 's-open-durability-b';
const PARENT_SESSION = 's-child-parent';
const CHILD_SESSION = 's-child-child';

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

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: InstanceType<typeof RunOrchestrator>;
  /**
   * One entry per dispatch the channel performed, recording whether the
   * `run:create` row was ALREADY durable at that moment. The ordering claim is
   * this array, not a call log nobody has to trust.
   */
  readonly dispatchedAfterCreateDurable: boolean[];
  readonly refusals: string[];
  readonly open: (sessionId: string) => Promise<{ readonly accepted: boolean; readonly runId: string | null }>;
  readonly close: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dbDir = trackTempDir('duya-open-durability-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  let createDurable = false;
  const dispatchedAfterCreateDurable: boolean[] = [];
  const refusals: string[] = [];

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      const receipt = outcome.state === 'created'
        ? writeRunReceiptOnWire({ state: 'created', runId: outcome.runId })
        : outcome.state === 'reused'
          ? writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId })
          : writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
      // Flipped only after the real store has the row, which is the whole
      // point: a dispatch that slipped in before this line would record false.
      createDurable = true;
      return receipt;
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: RunTerminalState };
      const outcome = store.settleRun(runId, terminal);
      return outcome.state === 'applied'
        ? writeRunReceiptOnWire({ state: 'applied', runId })
        : writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    // The native channel is the only event writer now, so an append arriving
    // here would mean that stopped being true. Named rather than swallowed.
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

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
      dispatch: () => {
        dispatchedAfterCreateDurable.push(createDurable);
        return true;
      },
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const open = async (sessionId: string, parentRunId?: string) => {
    createDurable = false;
    return orchestrator.openRun(sessionId, {
      prompt: `open durability proof for ${sessionId}`,
      options: { sessionId },
      model: 'claude-test',
      providerId: 'anthropic',
      workingDirectory: trackTempDir('duya-open-durability-ws-'),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    } as never);
  };

  return { store, orchestrator, dispatchedAfterCreateDurable, refusals, open, close: () => db.close() };
}

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function frame(runId: string, sessionId: string, seq: number, type: string, epoch = EPOCH): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch,
    envelope: { runId, sessionId, seq, payload: { type } },
  };
}

describe('run layer — the run row is durable before the worker is dispatched', () => {
  it('leaves the record of what the run was given even if no event ever lands', async () => {
    const harness = await makeHarness();
    try {
      const opened = await harness.open(SESSION_A);
      expect(opened.accepted).toBe(true);
      const runId = opened.runId as string;

      // The dispatch really happened...
      expect(harness.dispatchedAfterCreateDurable.length).toBeGreaterThanOrEqual(1);
      // ...and every one of them ran with the row already durable. This is the
      // restated `run.started` ordering claim: the host dispatches the moment
      // `openRun` proceeds, so anything not yet written is already too late.
      expect(harness.dispatchedAfterCreateDurable.every((after) => after)).toBe(true);

      // The row is what a reader gets back, and it says what was asked for.
      const row = harness.store.getRun(runId);
      expect(row).not.toBeNull();
      expect(row?.session_id).toBe(SESSION_A);
      expect(row?.status).toBe('running');
      expect(row?.input_hash).toEqual(expect.any(String));
      expect(harness.store.verifyManifest(runId)?.ok).toBe(true);

      // And the run has produced NOTHING event-side yet. Stated so the row
      // above cannot become decorative: if a future change re-adds an
      // event-level `run.started`, this assertion fails and forces whoever
      // did it to say which of the two records is now authoritative.
      expect(harness.store.countEvents(runId)).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe('run layer — concurrent sessions stay on separate runs', () => {
  it('routes each session its own run and writes each session only into its own ledger', async () => {
    // The bug this guards is a single shared "current run" field, which would
    // send one session's events into the other session's row.
    const harness = await makeHarness();
    try {
      const openedA = await harness.open(SESSION_A);
      const openedB = await harness.open(SESSION_B);
      expect(openedA.accepted).toBe(true);
      expect(openedB.accepted).toBe(true);
      const runA = openedA.runId as string;
      const runB = openedB.runId as string;
      expect(runA).not.toBe(runB);

      // Both sessions now have a live run. A frame arriving for either must be
      // resolved through the session, not through a shared slot.
      harness.orchestrator.queueNativeRunEvent(SESSION_A, frame(runA, SESSION_A, 1, 'turn.started'));
      harness.orchestrator.queueNativeRunEvent(SESSION_B, frame(runB, SESSION_B, 1, 'turn.started'));
      harness.orchestrator.queueNativeRunEvent(SESSION_B, frame(runB, SESSION_B, 2, 'assistant.text_block'));
      harness.orchestrator.observe(SESSION_B, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_B);

      // Each ledger holds exactly its own session's events. Asserted per run
      // and by COUNT, because "both sessions wrote something" is also
      // satisfied by both appending into one row.
      expect(harness.store.listEvents(runB, 0).map((row) => `${row.event_type}#${row.seq}`)).toEqual([
        'turn.started#1',
        'assistant.text_block#2',
      ]);
      expect(harness.store.countEvents(runB)).toBe(2);
      // Session A's ledger holds ITS frame and not session B's two. The count
      // is asserted because "both ledgers are non-empty" is also satisfied by
      // both sessions appending into one row.
      //
      // (This file's first draft asserted `countEvents(runA) === 0` here, on the
      // theory that a queue only drains at settle. It does not: the native
      // queue drains on its own tail, so A's frame is already durable. The
      // assertion above is the corrected one and it is STRONGER — it pins which
      // events are in there, not merely that some are.)
      expect(harness.store.listEvents(runA, 0).map((row) => `${row.event_type}#${row.seq}`)).toEqual([
        'turn.started#1',
      ]);
      expect(harness.store.countEvents(runA)).toBe(1);
      expect(harness.store.getRun(runA)?.status).toBe('running');

      // And the sessions each own exactly one run, read back by session rather
      // than by the run ids the test happens to be holding.
      expect(harness.store.listRunsBySession(SESSION_A).map((row) => row.id)).toEqual([runA]);
      expect(harness.store.listRunsBySession(SESSION_B).map((row) => row.id)).toEqual([runB]);
    } finally {
      harness.close();
    }
  });
});

/**
 * ## The third orphaned guarantee, found later (2026-10-18)
 *
 * `apps/desktop/src/main/__tests__/h8-2-worker-run-channel-seam.test.ts` has a
 * case named `takes the child to a durable terminal that the run layer will
 * answer for`. It is RED, and it is red on its FIRST assertion: production added
 * an attempt fence (`run:complete from desktop/host-run-api-adapter requires an
 * attempt epoch (no epoch): a run write with no attempt is refused rather than
 * made unfenced`), which is deliberate, and the case never sends an epoch.
 *
 * The refusal is correct. What it costs is that the case stops at line one, so
 * its later assertions — `finished_at` is a real timestamp, and the PARENT run is
 * not collaterally settled — never run. A loud red that provides no coverage is
 * still no coverage, so the guarantee is restated here against the mechanism that
 * is live on this side, exactly as guarantee 1 was.
 *
 * ## Why the parent assertion is the one worth making
 *
 * Settling a child is the point where a run layer could plausibly walk up its
 * own parent chain and close the parent too — which would make a sub-agent's
 * finished turn look like the end of the conversation. Both rows are read back
 * from SQLite, and the parent's non-settlement is asserted as a POSITIVE claim
 * (still `running`, no `finished_at`) rather than as an absence.
 */
describe('run layer — a child run reaches a durable terminal without settling its parent', () => {
  it('settles the child with a real finish time and leaves the parent running', async () => {
    const harness = await makeHarness();
    try {
      const parent = await harness.open(PARENT_SESSION);
      expect(parent.accepted).toBe(true);
      const parentRunId = parent.runId as string;

      const child = await harness.open(CHILD_SESSION, parentRunId);
      expect(child.accepted).toBe(true);
      const childRunId = child.runId as string;
      expect(childRunId).not.toBe(parentRunId);

      // The link is durable, not just carried in memory: read it from the row.
      expect(harness.store.getRun(childRunId)?.parent_run_id).toBe(parentRunId);

      // Give the child something to settle AROUND. Without this the terminal
      // assertions below would also pass for a run that never did any work.
      harness.orchestrator.queueNativeRunEvent(CHILD_SESSION, frame(childRunId, CHILD_SESSION, 1, 'turn.started'));
      harness.orchestrator.queueNativeRunEvent(CHILD_SESSION, frame(childRunId, CHILD_SESSION, 2, 'assistant.text_block'));
      harness.orchestrator.observe(CHILD_SESSION, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(CHILD_SESSION);

      // The child's terminal is durable, and it carries a real finish time —
      // the stranded shape (a terminal with no timestamp) is what the assertion
      // is here to keep out.
      const childRow = harness.store.getRun(childRunId);
      expect(childRow?.status).toBe('completed');
      expect(typeof childRow?.finished_at).toBe('number');

      // And it really had a transcript to close, so `completed` above is not a
      // statement about an empty run.
      expect(harness.store.countEvents(childRunId)).toBeGreaterThan(0);

      // THE assertion. A child that settles must not settle the run that asked
      // for it — otherwise a finished sub-agent reads as a finished conversation.
      const parentRow = harness.store.getRun(parentRunId);
      expect(parentRow?.status).toBe('running');
      expect(parentRow?.finished_at).toBeNull();
    } finally {
      harness.close();
    }
  });
});
