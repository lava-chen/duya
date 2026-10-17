/**
 * Plan 610 S1, Desktop half: a queued `run:event` outruns its own `done` frame.
 *
 * ## The gap this closes
 *
 * The worker writes `{ type: 'run:event', epoch, envelope }` on stdout and the
 * standalone Host awaits it (`run-execution.ts:446`). The Desktop router cannot:
 * `normalizeAndObserve` is synchronous because it is called from a sync `onData`
 * handler that has to RETURN a frame for SSE. So Desktop hands the line to
 * `queueNativeRunEvent`, which appends behind the caller's back.
 *
 * That is only safe because of ONE thing, and this file exists to prove it:
 * `#finish` awaits the session's queue before it releases the session→run
 * binding and before `settle` records the terminal. Without that wait, the
 * worker's final lines — `run.completed` above all — reach
 * `#appendNativeRunEvent` after `#release` has deleted `#bySession`, come back
 * `session ... has no live run`, and are dropped SILENTLY. A Desktop chat turn
 * would keep its run row and record zero events, which is the exact silent
 * degradation this channel was added to end.
 *
 * ## What is REAL here
 *
 * Real: `RunOrchestrator`, `RunController`, the wire validation, a real SQLite
 * `RunStore` with the real migrations, and a real native writer over it. The
 * frames are the wire frames, enqueued through the same public method the router
 * calls.
 *
 * NOT real: the Desktop router's own `normalizeAndObserve` branch (it is four
 * lines that call this method — `router-run-tee.test.ts` and the router's own
 * frame-path suites cover that hop), and a real worker process. What is proven
 * here is the ordering guarantee and its consequence in the ledger.
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

const SESSION_ID = 's-native-queue-race';
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

/** One durable write, in the order the run layer actually made it. */
interface TimelineEntry {
  readonly kind: 'append' | 'complete';
  readonly seq?: number;
  readonly type?: string;
}

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: InstanceType<typeof RunOrchestrator>;
  readonly runId: string;
  readonly timeline: TimelineEntry[];
  readonly refusals: string[];
  readonly close: () => void;
}

async function openHarness(
  options: { readonly failSeq?: number } = {},
): Promise<Harness> {
  const dbDir = trackTempDir('duya-native-queue-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  // The order in which durable calls were made. This is how "the events landed
  // before the terminal" is checked rather than asserted: the claim is about
  // sequencing, and a list of finished rows cannot express it.
  const timeline: TimelineEntry[] = [];

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId: outcome.runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
    }
    if (action === 'run:append') {
      const { events } = payload as { events: readonly RunEventEnvelope[] };
      const written = store.appendEvents(events);
      return writeRunReceiptOnWire({ state: 'applied', runId: (payload as { runId: string }).runId }, { written });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: RunTerminalState };
      timeline.push({ kind: 'complete', type: terminal.status });
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
          if (options.failSeq !== undefined && envelopes.some((e) => e.seq === options.failSeq)) {
            timeline.push({ kind: 'append', seq: envelopes[0]?.seq, type: 'refused' });
            return { state: 'failed', reason: 'the store refused this batch' };
          }
          const written = store.appendEvents(envelopes, presented);
          timeline.push({ kind: 'append', seq: envelopes[0]?.seq, type: envelopes[0]?.payload.type });
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
      warn: (message: string) => refusals.push(message),
      error: (message: string) => refusals.push(message),
    } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const workspaceDir = trackTempDir('duya-native-queue-ws-');
  const opened = await orchestrator.openRun(SESSION_ID, {
    prompt: 'queue drain proof',
    options: { sessionId: SESSION_ID },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: workspaceDir,
  } as never);
  if (!opened.accepted) throw new Error(`the harness run did not open: ${JSON.stringify(opened)}`);

  return { store, orchestrator, runId: opened.runId, timeline, refusals, close: () => db.close() };
}

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function frame(runId: string, seq: number, type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch: EPOCH,
    envelope: { runId, sessionId: SESSION_ID, seq, payload: { type, ...payload } },
  };
}

/** The frames a turn produces, ending in the terminal the `done` frame races. */
function turnFrames(runId: string): readonly Record<string, unknown>[] {
  return [
    frame(runId, 2, 'turn.started'),
    frame(runId, 3, 'assistant.text_block', { text: 'queued behind a sync tee' }),
    // Ephemeral by the registry's own rule: accepted, deliberately not stored.
    frame(runId, 4, 'assistant.text_delta', { text: 'q' }),
    frame(runId, 5, 'assistant.message_finalized', { text: 'queued behind a sync tee' }),
    frame(runId, 6, 'run.completed'),
  ];
}

/** `type#seq`, the identity this slice is about. */
function identities(store: RunStore, runId: string): readonly string[] {
  return store.listEvents(runId, 0).map((row) => `${row.event_type}#${row.seq}`);
}

describe('plan-610 S1 Desktop — a queued run:event outlives the done frame that races it', () => {
  it('lands every durable envelope, the terminal included, when the tee cannot await', async () => {
    const harness = await openHarness();
    try {
      // Exactly the Desktop shape: enqueue from a synchronous caller, with
      // nothing awaited between the enqueue and the settle. The first `await` in
      // this test is the settle itself.
      for (const line of turnFrames(harness.runId)) {
        harness.orchestrator.queueNativeRunEvent(SESSION_ID, line);
      }
      // The `done` frame, normalised the way the router normalises it.
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      // The Runtime's own sequence numbers, holes included: seq 4 is ephemeral
      // and absent by design, which is what makes this a claim about the
      // Runtime's numbering rather than a renumbered 1..4.
      expect(identities(harness.store, harness.runId)).toEqual([
        'turn.started#2',
        'assistant.text_block#3',
        'assistant.message_finalized#5',
        'run.completed#6',
      ]);
      // Not one refusal was reported — the drop this file exists to prevent
      // would surface here as `session ... has no live run`.
      expect(harness.refusals.filter((line) => line.includes('no live run'))).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('writes every event before the terminal row, not alongside it', async () => {
    const harness = await openHarness();
    try {
      for (const line of turnFrames(harness.runId)) {
        harness.orchestrator.queueNativeRunEvent(SESSION_ID, line);
      }
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      const completeAt = harness.timeline.findIndex((entry) => entry.kind === 'complete');
      const appendedSeqs = harness.timeline.filter((e) => e.kind === 'append').map((e) => e.seq);
      expect(completeAt).toBeGreaterThanOrEqual(0);
      // Every envelope the worker sent is durable BEFORE the run row is decided.
      // A drain that ran after `settle` would leave the terminal first in this
      // list while every row still existed by the time the assertions read them.
      expect(appendedSeqs.slice(0, completeAt)).toEqual([2, 3, 5, 6]);
      expect(harness.timeline[completeAt]?.type).toBe('completed');
    } finally {
      harness.close();
    }
  });

  it('keeps a lost event from settling as a success, which requires the same drain', async () => {
    // The drain is not only about rows that exist: `settle` reads the loss
    // counter to decide whether this run may record a success at all. An append
    // that has not been ATTEMPTED by settle time reports no loss, so the run
    // would record `completed` over a transcript it never wrote.
    const harness = await openHarness({ failSeq: 5 });
    try {
      for (const line of turnFrames(harness.runId)) {
        harness.orchestrator.queueNativeRunEvent(SESSION_ID, line);
      }
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      const terminal = await harness.orchestrator.settleSession(SESSION_ID);

      // The refusal is on the record, with its own reason.
      expect(harness.refusals.filter((line) => line.includes('the store refused this batch'))).toHaveLength(1);
      // And the run did not claim a clean transcript.
      expect(terminal?.status).not.toBe('completed');
    } finally {
      harness.close();
    }
  });

  it('refuses a malformed line and leaves the ledger untouched', async () => {
    const harness = await openHarness();
    try {
      const good = frame(harness.runId, 2, 'turn.started');
      const malformed: readonly Record<string, unknown>[] = [
        // No finite integer attempt: nothing to fence against.
        { type: 'run:event', epoch: 1.5, envelope: frame(harness.runId, 3, 'turn.ended').envelope },
        // Not an envelope.
        { type: 'run:event', epoch: EPOCH, envelope: 'run.completed' },
        // No runId: no identity to write under.
        { type: 'run:event', epoch: EPOCH, envelope: { seq: 4, payload: { type: 'turn.ended' } } },
        // Seq 0 is not an identity.
        { type: 'run:event', epoch: EPOCH, envelope: { runId: harness.runId, seq: 0, payload: { type: 'turn.ended' } } },
        // No typed payload.
        { type: 'run:event', epoch: EPOCH, envelope: { runId: harness.runId, seq: 5, payload: 42 } },
        // A live process naming a run this session is not executing.
        frame('some-other-run', 6, 'run.completed'),
      ];

      for (const line of [good, ...malformed]) {
        harness.orchestrator.queueNativeRunEvent(SESSION_ID, line);
      }
      harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
      await harness.orchestrator.settleSession(SESSION_ID);

      // Five wire refusals and one identity refusal, each naming itself: a gate
      // that cannot say WHY it refused is how a wire bug becomes an
      // unattributable data loss.
      expect(harness.refusals.filter((line) => line.startsWith('dropped a native run:event'))).toHaveLength(6);
      expect(harness.refusals.some((line) => line.includes('finite integer attempt'))).toBe(true);
      expect(harness.refusals.some((line) => line.includes('no envelope object'))).toBe(true);
      expect(harness.refusals.some((line) => line.includes('no runId'))).toBe(true);
      expect(harness.refusals.some((line) => line.includes('safe integer >= 1'))).toBe(true);
      expect(harness.refusals.some((line) => line.includes('no typed payload'))).toBe(true);
      expect(harness.refusals.some((line) => line.includes('is executing run'))).toBe(true);
      // And the ledger proves it: the one good frame, and nothing else.
      expect(identities(harness.store, harness.runId)).toEqual(['turn.started#2']);
    } finally {
      harness.close();
    }
  });
});
