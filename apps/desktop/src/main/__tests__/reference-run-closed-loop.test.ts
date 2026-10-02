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
 * Assertions read the SQLite rows DIRECTLY rather than through the store's own
 * accessors. Asserting through the same API that wrote the data proves the API
 * is self-consistent; reading the table proves the bytes are on disk.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestFingerprint } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';
import { dispatchControlPlaneAction } from '../control-plane/run-control-plane';
import { RunStore, RUN_STORE_MIGRATIONS } from '../db/core/run-store';

let db: Database.Database;
let dir: string;

/** Raw worker frames, in the shape the worker writes to stdout. */
const FRAMES = {
  turnStart: { type: 'chat:turn_start', data: {} },
  text: { type: 'chat:text', data: 'Hello from the worker' },
  toolUse: { type: 'chat:tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
  toolResult: { type: 'chat:tool_result', id: 'call-1', data: { result: 'file contents' } },
  toolProgress: { type: 'chat:tool_progress', id: 'call-1', data: { elapsedSeconds: 2 } },
  done: { type: 'chat:done' },
} satisfies Record<string, Record<string, unknown>>;

/**
 * Drive the loop: open a run, push frames through the REAL router tee, settle.
 *
 * `deps` is a real `RouterDeps` shape, not a cast of the orchestrator: the tee
 * is called exactly as the router calls it.
 */
async function runTurn(sessionId: string): Promise<string | null> {
  let dispatched = false;
  const channel = createWorkerExecutionChannel(() => {
    dispatched = true;
  });
  const orchestrator = new RunOrchestrator({
    channel,
    dbRequest: (action, payload) => dispatchControlPlaneAction(action, payload),
  });

  const runId = await orchestrator.openRun(sessionId, {
    workingDirectory: '/repo',
    model: 'claude-opus',
    providerId: 'anthropic-main',
    apiFormat: 'anthropic',
    runOrigin: 'user',
  });
  if (runId === null) return null;

  // The worker was told to go. This is the moment the run must already be on
  // disk — if `run.started` were still buffered, a crash here would lose it.
  expect(dispatched).toBe(true);

  const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;
  for (const frame of [
    FRAMES.turnStart,
    FRAMES.text,
    FRAMES.toolUse,
    FRAMES.toolProgress,
    FRAMES.toolResult,
    FRAMES.done,
  ]) {
    normalizeAndObserve(sessionId, frame, deps);
  }

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
  hoisted.stores = { runs: new RunStore(db) };
});

afterEach(() => {
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
    // and asserting it would be asserting a falsehood: a volatile event still
    // consumes a sequence number, so the durable rows after it sit at 6, 7...
    // A gap is the RECORD of something that happened and was deliberately not
    // stored. `PRIMARY KEY (run_id, seq)` does not forbid gaps; only this
    // invariant says anything useful about them.
    const seqs = events.map((e) => Number(e['seq']));
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!); // strictly increasing
    }
    expect(new Set(seqs).size).toBe(seqs.length); // never repeated

    // Exactly one sequence number went to a non-durable event (`tool.progress`),
    // and every other number in 1..max landed as a row. If this drifts, either
    // a durable event is being dropped or a volatile one is being stored.
    const maxSeq = seqs[seqs.length - 1]!;
    expect(maxSeq).toBe(seqs.length + 1);
    const missing: number[] = [];
    for (let n = 1; n <= maxSeq; n += 1) if (!seqs.includes(n)) missing.push(n);
    expect(missing).toHaveLength(1);

    // The whole point of translating: the legacy frame became protocol events.
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.text_block');
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');

    // The envelope is the real thing, not a summary row.
    const first = JSON.parse(String(events[0]!['envelope_json'])) as Record<string, unknown>;
    expect(first['runId']).toBe(runId);
    expect((first['payload'] as Record<string, unknown>)['type']).toBe('run.started');
  });

  it('gives a volatile event a sequence number without giving it a row', async () => {
    // `tool.progress` is volatile. The ledger still advances `seq` for it —
    // that is what makes the durable subset's seq a faithful index of the
    // stream — but the store must not grow a row for it.
    const runId = await runTurn('session-volatile');
    const types = rows('SELECT event_type FROM run_events WHERE run_id = ?', runId!).map((r) => r['event_type']);

    expect(types).not.toContain('tool.progress');

    // The proof that it was not silently ignored: the run recorded MORE events
    // than the frames that produced rows, so seq moved past it.
    const maxSeq = Number(rows('SELECT MAX(seq) AS m FROM run_events WHERE run_id = ?', runId!)[0]!['m']);
    expect(maxSeq).toBeGreaterThan(types.length);
  });

  it('records a turn that ends in an error as failed, not completed', async () => {
    let dispatched = false;
    const orchestrator = new RunOrchestrator({
      channel: createWorkerExecutionChannel(() => {
        dispatched = true;
      }),
      dbRequest: (action, payload) => dispatchControlPlaneAction(action, payload),
    });
    const runId = await orchestrator.openRun('session-err', {
      workingDirectory: '/repo',
      model: 'claude-opus',
      providerId: 'anthropic-main',
    });
    expect(dispatched).toBe(true);
    expect(runId).not.toBeNull();

    const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;
    normalizeAndObserve('session-err', { type: 'chat:text', data: 'partial' }, deps);
    // The worker puts `message` and `code` at the TOP level of `chat:error`
    // (`agent-process-entry.ts:2106`), not inside `data`. Feeding the nested
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
