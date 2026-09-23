/**
 * workflow-store.test.ts — plan 552 Phase 4: run metadata rows, dedup
 * idempotency, snapshot blob (definition + node stack), wait-tracker
 * queries, and crash reconciliation (§6.2: mark interrupted, never
 * auto-rerun).
 *
 * Plan 560 additions: the run-anchoring columns, the journal's move out
 * of the snapshot blob into `workflow_run_events`, and the `seq` cursor
 * contract the SSE stream is built on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowRunStore } from '../workflow-store';
import type { SqliteDatabase } from '../database';
import type { JournalRecord } from '../../../../packages/agent/src/modes/workflow/journal';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

/** Minimal journal record — the store treats it as an opaque JSON payload. */
function record(seq: number, overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    seq,
    kind: 'node_result',
    nodeId: `n${seq}`,
    attempt: 1,
    status: 'succeeded',
    atMs: 1_000 + seq,
    ...overrides,
  } as JournalRecord;
}

describe.skipIf(!nativeSqliteAvailable)('WorkflowRunStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: WorkflowRunStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-store-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of WorkflowRunStore.migrations) m.up(db);
    store = new WorkflowRunStore(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates runs and round-trips metadata', () => {
    const run = store.createRun({
      workflowName: 'invoice-sync',
      workflowVersionId: 'v1',
      status: 'active',
      triggerKind: 'cron',
      params: { invoice_id: 'INV-1' },
    });
    const loaded = store.getRun(run.id);
    expect(loaded).toMatchObject({
      workflowName: 'invoice-sync',
      workflowVersionId: 'v1',
      status: 'active',
      triggerKind: 'cron',
      params: { invoice_id: 'INV-1' },
      waitTill: null,
    });
  });

  it('dedup_key is unique — getRunByDedupKey returns the first run (idempotency)', () => {
    const first = store.createRun({ workflowName: 'wf', dedupKey: 'cron:2026-09-20T09:00' });
    const again = store.getRunByDedupKey('cron:2026-09-20T09:00');
    expect(again?.id).toBe(first.id);
    // A second row with the same key is rejected at the DB level.
    expect(() =>
      store.createRun({ workflowName: 'wf', dedupKey: 'cron:2026-09-20T09:00' }),
    ).toThrow();
  });

  it('updateStatus / setWaitTill / setVersionId bump the row', () => {
    const run = store.createRun({ workflowName: 'wf' });
    expect(store.updateStatus(run.id, 'blocked', 'awaiting approval')).toBe(true);
    expect(store.setWaitTill(run.id, 123456)).toBe(true);
    expect(store.setVersionId(run.id, 'v2')).toBe(true);
    const loaded = store.getRun(run.id)!;
    expect(loaded.status).toBe('blocked');
    expect(loaded.waitTill).toBe(123456);
    expect(loaded.workflowVersionId).toBe('v2');
    expect(loaded.pauseMessage).toBe('awaiting approval');
  });

  it('listRuns filters by status and name', () => {
    store.createRun({ workflowName: 'a', status: 'complete' });
    store.createRun({ workflowName: 'b', status: 'active' });
    store.createRun({ workflowName: 'b', status: 'failed' });
    expect(store.listRuns({ status: 'active' })).toHaveLength(1);
    expect(store.listRuns({ workflowName: 'b' })).toHaveLength(2);
  });

  it('listWaitingPast returns only parked runs past their deadline', () => {
    const a = store.createRun({ workflowName: 'a', status: 'blocked' });
    store.setWaitTill(a.id, 1000);
    const b = store.createRun({ workflowName: 'b', status: 'blocked' });
    store.setWaitTill(b.id, Date.now() + 3_600_000);
    store.createRun({ workflowName: 'c', status: 'complete' });
    const waiting = store.listWaitingPast(Date.now());
    expect(waiting.map((r) => r.id)).toEqual([a.id]);
  });

  it('reconcileStaleRuns marks engine-orphaned runs interrupted, never in-flight ones', () => {
    const live = store.createRun({ workflowName: 'a', status: 'active' });
    const dead = store.createRun({ workflowName: 'b', status: 'active' });
    const done = store.createRun({ workflowName: 'c', status: 'complete' });

    const stale = store.reconcileStaleRuns(new Set([live.id]));
    expect(stale.map((r) => r.id)).toEqual([dead.id]);
    expect(store.getRun(dead.id)?.status).toBe('interrupted');
    expect(store.getRun(live.id)?.status).toBe('active'); // engine still on it
    expect(store.getRun(done.id)?.status).toBe('complete'); // terminal untouched
  });

  it('deleteRun removes the row, the blob and the event stream', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({ runId: run.id, definition: {}, nodeStack: [] });
    store.appendJournalRecord(run.id, record(0));
    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.getRun(run.id)).toBeNull();
    expect(store.loadSnapshot(run.id)).toBeNull();
    expect(store.getEventCount(run.id)).toBe(0);
  });

  // ─── plan 560: run anchoring ───────────────────────────────────────────────

  it('round-trips the plan-560 anchoring columns', () => {
    const run = store.createRun({
      workflowName: 'wf',
      origin: 'library',
      scope: 'project',
      projectDir: 'E:/Projects/demo',
      parentSessionId: null,
    });
    expect(store.getRun(run.id)).toMatchObject({
      origin: 'library',
      scope: 'project',
      projectDir: 'E:/Projects/demo',
      parentSessionId: null,
      artifacts: [],
      summary: null,
      finishedAt: null,
      spentTokens: null,
    });
  });

  it('createRun defaults origin to library and accepts an agent anchor', () => {
    expect(store.createRun({ workflowName: 'a' }).origin).toBe('library');
    const agentRun = store.createRun({
      workflowName: 'b',
      origin: 'agent',
      parentSessionId: 'sess-1',
    });
    expect(store.getRun(agentRun.id)).toMatchObject({ origin: 'agent', parentSessionId: 'sess-1' });
  });

  it('listRuns filters by origin — the runs tab separates anchors', () => {
    store.createRun({ workflowName: 'wf', origin: 'library' });
    store.createRun({ workflowName: 'wf', origin: 'session' });
    store.createRun({ workflowName: 'wf', origin: 'agent', parentSessionId: 's' });
    expect(store.listRuns({ origin: 'library' })).toHaveLength(1);
    expect(store.listRuns({ origin: 'agent' })).toHaveLength(1);
    expect(store.listRuns()).toHaveLength(3);
  });

  it('finishRun writes the terminal outcome and leaves omitted fields alone', () => {
    const run = store.createRun({ workflowName: 'wf', status: 'active' });
    expect(
      store.finishRun(run.id, {
        status: 'complete',
        summary: 'published v0.9.0',
        artifacts: [{ id: 'a1', name: 'release.json', contentType: 'application/json', bytes: 371, relPath: 'release.json' }],
        spentTokens: 1_821_463,
      }),
    ).toBe(true);
    const done = store.getRun(run.id)!;
    expect(done.status).toBe('complete');
    expect(done.summary).toBe('published v0.9.0');
    expect(done.spentTokens).toBe(1_821_463);
    expect(done.artifacts[0]).toMatchObject({ name: 'release.json', relPath: 'release.json', bytes: 371 });
    expect(done.finishedAt).toBeGreaterThan(0);

    // A second, partial write must not clobber summary / artifacts.
    store.finishRun(run.id, { status: 'failed' });
    const failed = store.getRun(run.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.summary).toBe('published v0.9.0');
    expect(failed.artifacts).toHaveLength(1);
  });

  it('listActiveRunIds returns only RUNNING-class rows', () => {
    const live = store.createRun({ workflowName: 'a', status: 'active' });
    const planning = store.createRun({ workflowName: 'b', status: 'planning' });
    store.createRun({ workflowName: 'c', status: 'complete' });
    expect(store.listActiveRunIds().sort()).toEqual([live.id, planning.id].sort());
  });

  // ─── plan 560: journal → workflow_run_events ──────────────────────────────

  it('snapshot blob round-trips definition + node stack, and the journal lives in the event table', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({
      runId: run.id,
      definition: { name: 'wf', phases: [] },
      nodeStack: [{ nodeId: 'n1', status: 'succeeded', output: 7 }],
    });
    const snap = store.loadSnapshot(run.id)!;
    expect((snap.definition as { name: string }).name).toBe('wf');
    expect(snap.nodeStack[0]).toMatchObject({ nodeId: 'n1', output: 7 });
    // New writes carry no journal in the blob.
    expect(snap.journal).toEqual([]);

    store.appendJournalRecord(run.id, record(0));
    store.appendJournalRecord(run.id, record(1));
    expect(store.loadJournal(run.id)).toHaveLength(2);
    expect(store.getEventCount(run.id)).toBe(2);
  });

  it('saveSnapshot ingests any journal handed to it instead of dropping it', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({
      runId: run.id,
      definition: {},
      nodeStack: [],
      journal: [record(0), record(1)],
    });
    expect(store.loadJournal(run.id)).toHaveLength(2);
    // ...and the blob itself stays journal-free.
    expect(store.loadSnapshot(run.id)!.journal).toEqual([]);
  });

  it('listEvents honours the afterSeq cursor and latestEventSeq reports the head', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({ runId: run.id, definition: {}, nodeStack: [] });
    for (const seq of [0, 1, 2, 3]) store.appendJournalRecord(run.id, record(seq));

    expect(store.listEvents(run.id).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(store.listEvents(run.id, 1).map((r) => r.seq)).toEqual([2, 3]);
    expect(store.listEvents(run.id, 3)).toEqual([]);
    expect(store.latestEventSeq(run.id)).toBe(3);
    expect(store.latestEventSeq('nope')).toBeNull();
  });

  it('re-appending the same seq is idempotent — SSE replay cannot duplicate a frame', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({ runId: run.id, definition: {}, nodeStack: [] });
    store.appendJournalRecord(run.id, record(0, { status: 'running' }));
    store.appendJournalRecord(run.id, record(0, { status: 'succeeded' }));
    const events = store.listEvents(run.id);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('succeeded'); // last write wins at the same cursor
  });

  // ─── plan 560: migrations ─────────────────────────────────────────────────

  it('migrations are idempotent — replaying the whole list changes nothing', () => {
    const run = store.createRun({ workflowName: 'wf', origin: 'session', status: 'active' });
    store.saveSnapshot({ runId: run.id, definition: { name: 'wf' }, nodeStack: [] });
    store.appendJournalRecord(run.id, record(0, { atMs: 42 }));

    for (const m of WorkflowRunStore.migrations) m.up(db);

    expect(store.getRun(run.id)).toMatchObject({ origin: 'session', status: 'active' });
    expect(store.listEvents(run.id)).toHaveLength(1);
    expect(store.loadSnapshot(run.id)!.journal).toEqual([]);
  });

  it('migration 31 relocates a legacy inline journal and strips it from the blob', () => {
    const run = store.createRun({ workflowName: 'wf' });
    const legacyRows = [record(0), record(1), record(2)];
    // Simulate a pre-31 blob: journal inlined in snapshot_json.
    db.prepare(
      `INSERT INTO workflow_run_snapshots (run_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)`,
    ).run(run.id, JSON.stringify({ definition: { name: 'wf' }, nodeStack: [], journal: legacyRows }), Date.now());

    const migration31 = WorkflowRunStore.migrations.find((m) => m.id === 31)!;
    migration31.up(db);

    expect(store.listEvents(run.id).map((r) => r.seq)).toEqual([0, 1, 2]);
    const blob = db
      .prepare('SELECT snapshot_json FROM workflow_run_snapshots WHERE run_id = ?')
      .get(run.id) as { snapshot_json: string };
    const parsed = JSON.parse(blob.snapshot_json) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('journal');
    expect(parsed).toHaveProperty('nodeStack');

    // Re-running is a no-op (INSERT OR IGNORE on the (run_id, seq) key).
    migration31.up(db);
    expect(store.getEventCount(run.id)).toBe(3);
  });

  it('migration 31 keeps reading a legacy journal when the blob never migrated', () => {
    const run = store.createRun({ workflowName: 'wf' });
    db.prepare(
      `INSERT INTO workflow_run_snapshots (run_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)`,
    ).run(run.id, JSON.stringify({ definition: {}, nodeStack: [], journal: [record(0)] }), Date.now());

    // No migration run → the legacy read path is the only source.
    expect(store.loadJournal(run.id)).toHaveLength(1);
  });

  it('migration 30 re-labels pre-existing rows as session-anchored', () => {
    // A row inserted before 30 existed has no `origin`; the migration adds
    // the column and must not claim those runs came from the library.
    const legacyDb = new Database(':memory:') as unknown as SqliteDatabase;
    const [m28, m29] = WorkflowRunStore.migrations;
    m28.up(legacyDb);
    m29.up(legacyDb);
    legacyDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_name, status, params_json, created_at, updated_at)
         VALUES ('old', 'wf', 'complete', '{}', 1, 1)`,
      )
      .run();

    const migration30 = WorkflowRunStore.migrations.find((m) => m.id === 30)!;
    migration30.up(legacyDb);

    const legacyStore = new WorkflowRunStore(legacyDb);
    expect(legacyStore.getRun('old')).toMatchObject({
      origin: 'session',
      artifacts: [],
      projectDir: null,
      finishedAt: null,
    });

    // A row created after the migration defaults to the run-anchored path.
    expect(legacyStore.createRun({ workflowName: 'new' }).origin).toBe('library');
    legacyDb.close();
  });
});
