/**
 * The Reference Run, end to end, against a real database.
 *
 * ## Why this file exists
 *
 * Every other test in this plan proves one seam in isolation:
 *
 *   - `reference-run-control-plane.test.ts` drives a REAL `RunStore` on REAL
 *     SQLite, but calls it directly.
 *   - `run-orchestrator.test.ts` drives a REAL `RunOrchestrator` and a REAL
 *     `RunController`, but through a `dbRequest` double that records calls.
 *   - `router-run-tee.test.ts` drives the REAL router, but only the tee.
 *
 * So every component is proven and the JOIN is not. A seam can be individually
 * correct and the composition still be wrong: a `dbRequest` double cannot catch
 * an action name the bridge never routes, a direct `RunStore` call cannot catch
 * a Control Plane that hands the store the wrong field, and a mocked channel
 * cannot catch a `seq` that only looks gapless until a real `PRIMARY KEY` sees
 * it. This file closes the loop with nothing mocked except the process boundary
 * that genuinely cannot exist in a unit test — `getCoreStores()`, which in
 * production is a boot-time singleton over `duya-core.db`.
 *
 * ## What "end to end" means here, precisely
 *
 * A real router normaliser, a real orchestrator, a real controller, a real
 * ledger, a real translator, a real Control Plane and a real SQLite file. The
 * only double is the `ExecutionChannel`'s dispatch callback, which stands in for
 * the worker process — the one participant that would otherwise need an API key
 * and a live model call. That boundary is drawn at the worker, not at storage,
 * so everything this plan actually built is exercised.
 *
 * ## The vocabulary changed, and the file followed it
 *
 * Plan 610 S1 (`cdee21d5`) flipped the run layer's authority: the durable
 * `run_events` ledger is written by the NATIVE `run:event` channel, under the
 * Runtime's OWN sequence, and the legacy `chat:*` frames are reverse-
 * translated for the live arm but no longer persisted. So the durable log this
 * file reads is the RUNTIME's, and the frames it drives are the Runtime's own
 * — written exactly as `worker-process-entry.ts` writes them.
 *
 * The legacy-only shape is not lost: `desktop-native-run-closed-loop.test.ts`
 * proves that a run whose worker speaks only the legacy vocabulary settles
 * with a deliberately EMPTY ledger, and that the run layer says so out loud.
 * This file is the other half: what the ledger holds when the worker speaks
 * the protocol.
 *
 * Assertions read the SQLite rows DIRECTLY rather than through the store's own
 * accessors. Asserting through the same API that wrote the data proves the API
 * is self-consistent; reading the table proves the bytes are on disk.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestFingerprint } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Control Plane reaches storage through `getCoreStores()`, a boot-time
 * singleton over the real `duya-core.db`. Substituting it is the one thing this
 * test fakes, and it is faked with a REAL `RunStore` on a REAL database — the
 * substitution removes a process boundary, not a behaviour.
 */
const hoisted = vi.hoisted(() => ({ stores: null as { runs: unknown } | null }));
vi.mock('../db/core-connection', () => ({
  getCoreStores: () => {
    if (hoisted.stores === null) throw new Error('core stores not set');
    return hoisted.stores;
  },
  getCoreStoresOrNull: () => hoisted.stores,
}));

import { normalizeAndObserve, type RouterDeps } from '../agents/server/router';
import { RunOrchestrator, createWorkerExecutionChannel, type WorkerInterrupt } from '../agents/server/run-orchestrator';
import { createDesktopNativeRunEventWriter } from '../agents/server/native-run-event-writer';
import { dispatchControlPlaneAction, __setDesktopHostRunApiForTesting } from '../control-plane/run-control-plane';
import { createHostRunApi } from '@duya/host/run-api';
import { RunStore, RUN_STORE_MIGRATIONS } from '../db/core/run-store';

/**
 * A stop the host has already completed: accepted, and the worker left cleanly.
 *
 * Shared by every double in this file so they all report the SAME thing. Before
 * R2.3 the binding returned a boolean, which could not distinguish this from a
 * worker that had to be killed.
 */
const COOPERATIVE_INTERRUPT: WorkerInterrupt = {
  accepted: true,
  settled: Promise.resolve('cooperative'),
};


let db: Database.Database;
let dir: string;

/**
 * The Runtime's own messages, in the order the Runtime mints them.
 *
 * `ASSISTANT_MESSAGE_ID` is the RUN-SCOPED id the Runtime gives the message it
 * finalised, and the text block it supersedes carries the same one: the
 * finalized message has to join the block it replaces instead of sitting
 * beside it under a second identity.
 */
const ASSISTANT_MESSAGE_ID = 'msg-run-scoped-1';
const ASSISTANT_TEXT = 'Hello from the worker';

/**
 * The frames one turn produces, as the Runtime writes them.
 *
 * `seq` is the Runtime's own sequence and it is what the ledger is keyed on.
 * The `text_delta` is EPHEMERAL — counted in metrics, never retained — so it
 * consumes a sequence number without leaving a row. That gap is the record of
 * something that happened and was deliberately not stored.
 */
const TURN_FRAMES: readonly { seq: number; type: string; payload: Record<string, unknown> }[] = [
  { seq: 1, type: 'run.started', payload: {} },
  { seq: 2, type: 'turn.started', payload: {} },
  {
    seq: 3,
    type: 'assistant.text_block',
    payload: { messageId: ASSISTANT_MESSAGE_ID, text: ASSISTANT_TEXT },
  },
  { seq: 4, type: 'tool.call_started', payload: { toolCallId: 'call-1', name: 'Read' } },
  { seq: 5, type: 'assistant.text_delta', payload: { messageId: ASSISTANT_MESSAGE_ID, text: 'Hello' } },
  { seq: 6, type: 'tool.call_completed', payload: { toolCallId: 'call-1', status: 'success' } },
  {
    seq: 7,
    type: 'assistant.message_finalized',
    payload: {
      messageId: ASSISTANT_MESSAGE_ID,
      stopReason: 'completed',
      content: [{ type: 'text', text: ASSISTANT_TEXT }],
    },
  },
  { seq: 8, type: 'run.completed', payload: {} },
];

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function nativeFrame(
  runId: string,
  sessionId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch: 0,
    envelope: { runId, sessionId, seq, payload: { type, ...payload } },
  };
}

/**
 * Drive the loop: open a run, push the Runtime's frames through the REAL
 * router tee, settle.
 *
 * `deps` is a real `RouterDeps` shape, not a cast of the orchestrator: the tee
 * is called exactly as the router calls it.
 */
async function runTurn(sessionId: string): Promise<string | null> {
  let dispatched = false;
  // R2.1: the channel dispatches, and it REPORTS whether the worker took it.
  // The `false` here is what makes a refused dispatch a terminal rather than a
  // run that looks live, so a `true` is the honest value for this harness.
  const channel = createWorkerExecutionChannel({
    dispatch: () => {
      dispatched = true;
      return true;
    },
    interrupt: () => COOPERATIVE_INTERRUPT,
  });
  const request = (action: string, payload: Record<string, unknown>) =>
    dispatchControlPlaneAction(action, payload) as Promise<unknown>;
  const orchestrator = new RunOrchestrator({
    channel,
    dbRequest: request,
    // The ONE durable writer for Runtime-minted envelopes, exactly as
    // `agents/server/index.ts` composes it. Without it the run layer refuses
    // every native event and the ledger stays empty.
    nativeWriter: createDesktopNativeRunEventWriter({
      request,
      logger: { warn: () => undefined },
    }),
  });

  const start = await orchestrator.openRun(sessionId, {
    workingDirectory: '/repo',
    model: 'claude-opus',
    providerId: 'anthropic-main',
    apiFormat: 'anthropic',
    prompt: 'hello',
    options: {},
  });
  if (!start.accepted) return null;
  const runId = start.runId;

  // The worker was told to go. This is the moment the run must already be on
  // disk — if `run.started` were still buffered, a crash here would lose it.
  expect(dispatched).toBe(true);

  const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;
  for (const frame of TURN_FRAMES) {
    normalizeAndObserve(sessionId, nativeFrame(runId, sessionId, frame.seq, frame.type, frame.payload), deps);
  }
  // The legacy terminal frame is still what ends the turn for the host; the
  // Runtime's own terminal envelope is the one in the ledger.
  normalizeAndObserve(sessionId, { type: 'chat:done', reason: 'completed' }, deps);

  await orchestrator.settleSession(sessionId);
  return runId;
}

/** Read the table directly. */
function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-reference-run-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const runs = new RunStore(db);
  hoisted.stores = { runs };
  // The Control Plane now speaks the typed Host Run API, and the Desktop's
  // adapter reaches storage through it. The seam points it at the SAME real
  // RunStore this file asserts against, so the measurement keeps a real
  // durable store without standing up a Host HTTP process.
  __setDesktopHostRunApiForTesting(createHostRunApi({ runs }));
});

afterEach(() => {
  __setDesktopHostRunApiForTesting(null);
  hoisted.stores = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Reference Run, closed', () => {
  it('lands a runs row, a gapless durable log, and one terminal state', async () => {
    const runId = await runTurn('session-e2e');
    expect(runId).not.toBeNull();

    // ── the run row ──────────────────────────────────────────────────────
    const run = rows('SELECT * FROM runs WHERE id = ?', runId!)[0];
    expect(run).toBeDefined();
    expect(run!['session_id']).toBe('session-e2e');
    expect(run!['status']).toBe('completed');
    // `terminal` is the status ARM, not a JSON blob; the error lives in its own
    // column so a completed run carries no error-shaped nulls to confuse a
    // reader. Asserting the shape here keeps a future "let's just JSON it all"
    // refactor from silently changing the column's contract.
    expect(run!['terminal']).toBe('completed');
    expect(run!['error_json']).toBeNull();
    expect(run!['started_at']).not.toBeNull();
    expect(run!['finished_at']).not.toBeNull();

    // The manifest is stored verbatim, so its fingerprint is re-derivable from
    // the row alone. This is the property that makes a resume verifiable, and
    // it is only checkable if the JSON round-trips.
    const manifest = JSON.parse(String(run!['manifest_json'])) as Record<string, unknown>;
    expect(manifestFingerprint(manifest as never)).toBe(run!['manifest_hash']);

    // ── the durable log ──────────────────────────────────────────────────
    const events = rows('SELECT seq, event_type, envelope_json FROM run_events WHERE run_id = ? ORDER BY seq', runId!);
    const types = events.map((e) => e['event_type']);

    expect(types[0]).toBe('run.started');
    expect(types[types.length - 1]).toBe('run.completed');

    // `seq` is a faithful index of the STREAM, not of the rows.
    //
    // It is tempting to assert the durable subset is 1..N gapless. It is not,
    // and asserting it would be asserting a falsehood: a non-retained event
    // still consumes a sequence number, so the durable rows after it sit at 6,
    // 7... A gap is the RECORD of something that happened and was deliberately
    // not stored. `PRIMARY KEY (run_id, seq)` does not forbid gaps; only this
    // invariant says anything useful about them.
    const seqs = events.map((e) => Number(e['seq']));
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!); // strictly increasing
    }
    expect(new Set(seqs).size).toBe(seqs.length); // never repeated

    // The authoritative assistant message is in the DURABLE ledger, read back
    // out of the real `run_events` table — the same read E4.4's assertion makes
    // against a real Electron renderer. It is here because the envelope
    // crossed the REAL router tee, the real orchestrator, the real native
    // writer, the real Control Plane and the real store, so a break anywhere
    // on that path loses the row.
    //
    // Order is the part worth asserting: `transcript-snapshot.ts` reads the
    // finalized message as superseding the per-block events of the SAME message,
    // so it has to land after them and before the run's terminal.
    expect(types).toContain('assistant.message_finalized');
    expect(types.indexOf('assistant.message_finalized')).toBeGreaterThan(
      types.lastIndexOf('assistant.text_block'),
    );
    expect(types.indexOf('assistant.message_finalized')).toBeLessThan(types.indexOf('run.completed'));
    // The `messageId` is the runtime's run-scoped one, so the finalized message
    // joins the text block it supersedes instead of sitting beside it under a
    // second identity.
    const textBlock = events.find((e) => e['event_type'] === 'assistant.text_block')!;
    const finalizedRow = events.find((e) => e['event_type'] === 'assistant.message_finalized')!;
    const textBlockId = (
      JSON.parse(String(textBlock['envelope_json'])) as { payload: { messageId: string } }
    ).payload.messageId;
    const finalizedPayload = (
      JSON.parse(String(finalizedRow['envelope_json'])) as {
        payload: { messageId: string; stopReason: string; content: { type: string; text?: string }[] };
      }
    ).payload;
    expect(finalizedPayload.messageId).toBe(textBlockId);
    expect(finalizedPayload.stopReason).toBe('completed');
    // And the durable TEXT is the message — the property E4.4 compares against
    // what the renderer streamed.
    expect(
      finalizedPayload.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
    ).toBe(ASSISTANT_TEXT);

    // Exactly one sequence number went to a non-retained event
    // (`assistant.text_delta`), and every other number in 1..max landed as a
    // row. If this drifts, either a durable event is being dropped or a
    // non-retained one is being stored.
    const maxSeq = seqs[seqs.length - 1]!;
    expect(maxSeq).toBe(seqs.length + 1);
    const missing: number[] = [];
    for (let n = 1; n <= maxSeq; n += 1) if (!seqs.includes(n)) missing.push(n);
    expect(missing).toHaveLength(1);

    // The whole point of the native channel: the ledger is the RUNTIME's
    // events, under the RUNTIME's identity — not a projection of some other
    // vocabulary.
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.text_block');
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');

    // The envelope is the real thing, not a summary row.
    const first = JSON.parse(String(events[0]!['envelope_json'])) as Record<string, unknown>;
    expect(first['runId']).toBe(runId);
    expect((first['payload'] as Record<string, unknown>)['type']).toBe('run.started');
  });

  it('gives a non-retained event a sequence number without giving it a row', async () => {
    // `assistant.text_delta` is ephemeral: counted in metrics, never retained.
    // The ledger still advances `seq` for it — that is what makes the durable
    // subset's seq a faithful index of the stream — but the store must not grow
    // a row for it.
    const runId = await runTurn('session-volatile');
    const types = rows('SELECT event_type FROM run_events WHERE run_id = ?', runId!).map((r) => r['event_type']);

    expect(types).not.toContain('assistant.text_delta');

    // The proof that it was not silently ignored: the run recorded MORE events
    // than the frames that produced rows, so seq moved past it.
    const maxSeq = Number(rows('SELECT MAX(seq) AS m FROM run_events WHERE run_id = ?', runId!)[0]!['m']);
    expect(maxSeq).toBeGreaterThan(types.length);
  });

  it('records a turn that ends in an error as failed, not completed', async () => {
    let dispatched = false;
    const request = (action: string, payload: Record<string, unknown>) =>
      dispatchControlPlaneAction(action, payload) as Promise<unknown>;
    const orchestrator = new RunOrchestrator({
      channel: createWorkerExecutionChannel({
        dispatch: () => {
          dispatched = true;
          return true;
        },
        interrupt: () => COOPERATIVE_INTERRUPT,
      }),
      dbRequest: request,
      nativeWriter: createDesktopNativeRunEventWriter({
        request,
        logger: { warn: () => undefined },
      }),
    });
    const start = await orchestrator.openRun('session-err', {
      workingDirectory: '/repo',
      model: 'claude-opus',
      providerId: 'anthropic-main',
      prompt: 'hello',
      options: {},
    });
    expect(dispatched).toBe(true);
    expect(start.accepted).toBe(true);
    if (!start.accepted) throw new Error('unreachable');
    const runId = start.runId;

    const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;
    normalizeAndObserve('session-err', { type: 'chat:text', data: 'partial' }, deps);
    // The Runtime's own envelopes, under its own sequence. They are written
    // BEFORE the legacy terminal frame, because the legacy frame is what ends
    // the turn and the run layer releases the session's binding when it does.
    normalizeAndObserve('session-err', nativeFrame(runId, 'session-err', 1, 'run.started', {}), deps);
    normalizeAndObserve(
      'session-err',
      nativeFrame(runId, 'session-err', 2, 'run.failed', {
        error: { code: 'provider_rate_limited', message: 'upstream 429' },
      }),
      deps,
    );
    // The worker puts `message` and `code` at the TOP level of `chat:error`
    // (`worker-process-entry.ts`), not inside `data`. Feeding the nested
    // shape would make the router emit `code: undefined` and the run would be
    // recorded `internal` — a plausible-looking wrong answer.
    normalizeAndObserve(
      'session-err',
      { type: 'chat:error', message: 'upstream 429', code: 'provider_rate_limited' },
      deps,
    );
    await orchestrator.settleSession('session-err');

    const run = rows('SELECT status, terminal, error_json FROM runs WHERE id = ?', runId!)[0]!;
    expect(run['status']).toBe('failed');
    expect(run['terminal']).toBe('failed');

    // The producer said why. A terminal that lost the cause would be a status
    // with no explanation attached to it, and `runtime_crash` would become the
    // default story for every provider-side failure the product can actually
    // hit — a rate limit is not a crash.
    const error = JSON.parse(String(run['error_json'])) as { code: string; message: string };
    expect(error.code).toBe('provider_rate_limited');
    expect(error.message).toBe('upstream 429');

    // The log ends where the story ends: failed, not completed.
    const types = rows('SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq', runId!).map((r) => r['event_type']);
    expect(types[types.length - 1]).toBe('run.failed');
    expect(types).not.toContain('run.completed');
  });

  it('serves the run back through the Control Plane read path', async () => {
    const runId = await runTurn('session-read');
    expect(runId).not.toBeNull();

    const got = (await dispatchControlPlaneAction('run:get', { runId })) as {
      id: string;
      status: string;
      eventCount: number;
    };
    expect(got.id).toBe(runId);
    expect(got.status).toBe('completed');
    expect(got.eventCount).toBeGreaterThan(0);

    const fromCursor = (await dispatchControlPlaneAction('run:events', { runId, afterSeq: 0 })) as { seq: number }[];
    expect(fromCursor.length).toBe(got.eventCount);
    expect(fromCursor[0]!.seq).toBe(1);

    // The cursor is EXCLUSIVE, so paging cannot repeat a row.
    const afterFirst = (await dispatchControlPlaneAction('run:events', { runId, afterSeq: 1 })) as { seq: number }[];
    expect(afterFirst.every((e) => e.seq > 1)).toBe(true);

    // Session-as-projection: the session is a read over its runs.
    const listed = (await dispatchControlPlaneAction('run:list-session', { sessionId: 'session-read' })) as { id: string }[];
    expect(listed.map((r) => r.id)).toContain(runId);
  });

  it('keeps two runs of one session on independent event spaces', async () => {
    // The session is the projection, not the identity. Two turns in one
    // session must not share a `seq` space, or the second turn's log would be
    // unreadable against the first turn's.
    const first = await runTurn('session-two');
    const second = await runTurn('session-two');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);

    const a = rows('SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq', first!).map((r) => Number(r['seq']));
    const b = rows('SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq', second!).map((r) => Number(r['seq']));
    expect(a[0]).toBe(1);
    expect(b[0]).toBe(1);

    const listed = (await dispatchControlPlaneAction('run:list-session', { sessionId: 'session-two' })) as { id: string }[];
    expect(listed).toHaveLength(2);
  });
});
