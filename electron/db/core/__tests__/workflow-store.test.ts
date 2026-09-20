/**
 * workflow-store.test.ts — plan 552 Phase 4: run metadata rows, dedup
 * idempotency, snapshot blob (definition + journal), wait-tracker
 * queries, and crash reconciliation (§6.2: mark interrupted, never
 * auto-rerun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowRunStore } from '../workflow-store';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
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

  it('snapshot blob round-trips definition + node stack + journal', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({
      runId: run.id,
      definition: { name: 'wf', phases: [] },
      nodeStack: [{ nodeId: 'n1', status: 'succeeded', output: 7 }],
      journal: [
        { seq: 0, kind: 'node_result', nodeId: 'n1', attempt: 1, reqHash: 'abc', status: 'succeeded', result: 7, atMs: 1 },
      ],
    });
    const snap = store.loadSnapshot(run.id)!;
    expect((snap.definition as { name: string }).name).toBe('wf');
    expect(snap.nodeStack[0]).toMatchObject({ nodeId: 'n1', output: 7 });
    expect(snap.journal).toHaveLength(1);

    // Append mutates the journal in place.
    store.appendJournalRecord(run.id, {
      seq: 1, kind: 'approval', nodeId: 'n2', attempt: 1, status: 'waiting', result: null, atMs: 2,
    });
    expect(store.loadJournal(run.id)).toHaveLength(2);
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

  it('deleteRun removes both row and blob', () => {
    const run = store.createRun({ workflowName: 'wf' });
    store.saveSnapshot({ runId: run.id, definition: {}, nodeStack: [], journal: [] });
    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.getRun(run.id)).toBeNull();
    expect(store.loadSnapshot(run.id)).toBeNull();
  });
});
