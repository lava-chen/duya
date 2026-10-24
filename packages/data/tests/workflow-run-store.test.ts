import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowRunStore } from '../src/workflow-run-store.js';

describe('WorkflowRunStore snapshot concurrency', () => {
  let db: Database.Database;
  let store: WorkflowRunStore;

  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of [...WorkflowRunStore.migrations].sort((a, b) => a.id - b.id)) {
      migration.up(db);
    }
    store = new WorkflowRunStore(db);
    store.createRun({ id: 'run-1', workflowName: 'fixture', status: 'active' });
  });

  afterEach(() => db.close());

  it('round-trips the persisted run-level concurrency cap without a schema migration', () => {
    store.saveSnapshot({
      runId: 'run-1',
      definition: { name: 'fixture', nodes: [] },
      definitionHash: 'a'.repeat(64),
      definitionHashSource: 'dag',
      maxConcurrency: 4,
      nodeStack: [],
      journal: [],
    });

    expect(store.loadSnapshot('run-1')?.maxConcurrency).toBe(4);
    expect((db.prepare('PRAGMA table_info(workflow_run_snapshots)').all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(['run_id', 'snapshot_json', 'updated_at']);
  });

  it('keeps legacy snapshots without a run-level cap readable', () => {
    store.saveSnapshot({
      runId: 'run-1',
      definition: { name: 'fixture', nodes: [] },
      nodeStack: [],
      journal: [],
    });

    expect(store.loadSnapshot('run-1')).toMatchObject({
      runId: 'run-1',
      definition: { name: 'fixture', nodes: [] },
    });
    expect(store.loadSnapshot('run-1')?.maxConcurrency).toBeUndefined();
  });
});
