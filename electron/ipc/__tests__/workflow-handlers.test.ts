/**
 * workflow-handlers.test.ts — plan 552 Phase 7: the console IPC reads
 * (list / get / journal / snapshot / delete) against an in-memory core
 * database with the store injected via _setCoreStoresForTesting.
 *
 * Note: the native better-sqlite3 test follows the same skip guard as
 * the other core-db suites — where the ABI is unavailable the suite is
 * skipped cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import * as osMod from 'node:os';
import { CoreDatabase, WorkflowRunStore } from '../../db/core';
import { _setCoreStoresForTesting } from '../../db/core-connection';
import { registerWorkflowHandlers } from '../workflow-handlers';

let nativeSqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const probe = (require('better-sqlite3') as typeof BetterSqlite3)(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

const registered: string[] = [];
const handlers = new Map<string, (_e: unknown, payload?: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (_e: unknown, payload?: unknown) => unknown) => {
      registered.push(channel);
      handlers.set(channel, fn);
    },
  },
}));

describe.skipIf(!nativeSqliteAvailable)('workflow console handlers', () => {
  let tmpDir: string;

  beforeEach(() => {
    registered.length = 0;
    handlers.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-handlers-test-'));
    const BetterSqlite3 = require('better-sqlite3') as typeof BetterSqlite3;
    const coreDb = new CoreDatabase({
      filename: path.join(tmpDir, 'core.db'),
      sqlite: BetterSqlite3,
      migrations: [...WorkflowRunStore.migrations],
    });
    _setCoreStoresForTesting({
      coreDb,
      workflowRuns: new WorkflowRunStore(coreDb.db),
    } as Parameters<typeof _setCoreStoresForTesting>[0]);
    registerWorkflowHandlers();
  });

  afterEach(() => {
    _setCoreStoresForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers exactly the console channels', () => {
    expect(registered.sort()).toEqual(
      [
        'workflow:cancel',
        'workflow:defs:get',
        'workflow:defs:list',
        'workflow:delete',
        'workflow:get',
        'workflow:journal',
        'workflow:list',
        'workflow:snapshot',
      ].sort(),
    );
  });

  it('cancel refuses terminal runs and clears wait_till for parked ones', () => {
    const store = (require('../../db/core-connection') as {
      getCoreStores: () => { workflowRuns: WorkflowRunStore };
    }).getCoreStores().workflowRuns;

    const done = store.createRun({ workflowName: 'a', status: 'complete' });
    expect(handlers.get('workflow:cancel')!(undefined, done.id)).toEqual({ ok: false, reason: 'terminal' });

    const parked = store.createRun({ workflowName: 'b', status: 'blocked' });
    store.setWaitTill(parked.id, Date.now() + 60_000);
    expect(handlers.get('workflow:cancel')!(undefined, parked.id)).toEqual({ ok: true });
    const after = store.getRun(parked.id)!;
    expect(after.status).toBe('cancelled');
    expect(after.waitTill).toBeNull();

    expect(handlers.get('workflow:cancel')!(undefined, 'ghost')).toEqual({ ok: false, reason: 'not_found' });
  });


  it('list → get → journal → delete round-trip', () => {
    const store = (require('../../db/core-connection') as {
      getCoreStores: () => { workflowRuns: WorkflowRunStore };
    }).getCoreStores().workflowRuns;
    const run = store.createRun({
      workflowName: 'invoice-sync',
      status: 'complete',
      triggerKind: 'cron',
      dedupKey: 'cron:invoice-sync:2026-09-21T01:00',
    });
    store.saveSnapshot({ runId: run.id, definition: { name: 'invoice-sync' }, nodeStack: [], journal: [] });
    store.appendJournalRecord(run.id, {
      seq: 0, kind: 'node_result', nodeId: 'a', attempt: 1, status: 'succeeded', result: null, atMs: 1,
    });

    const listed = handlers.get('workflow:list')!(undefined, { limit: 10 }) as Array<{ id: string; status: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: run.id, status: 'complete' });

    const got = handlers.get('workflow:get')!(undefined, run.id) as { workflowName: string };
    expect(got.workflowName).toBe('invoice-sync');

    const journal = handlers.get('workflow:journal')!(undefined, run.id) as Array<{ nodeId: string }>;
    expect(journal).toHaveLength(1);
    expect(journal[0].nodeId).toBe('a');

    const snapshot = handlers.get('workflow:snapshot')!(undefined, run.id) as { definition: unknown };
    expect(snapshot.definition).toEqual({ name: 'invoice-sync' });

    expect(handlers.get('workflow:delete')!(undefined, run.id)).toBe(true);
    expect(handlers.get('workflow:get')!(undefined, run.id)).toBeNull();
  });
});

// ─── definition library (no native sqlite needed) ───

describe('workflow definition library handlers', () => {
  beforeEach(() => {
    registered.length = 0;
    handlers.clear();
    registerWorkflowHandlers();
  });

it('defs:list reads the definition library for a project directory', () => {
  const projectDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'wf-defs-'));
  try {
    const defsDir = path.join(projectDir, '.duya', 'workflows');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(defsDir, 'repo-digest.yaml'),
      [
        'name: repo-digest',
        'description: Digest the repo',
        'phases:',
        '  - phase: work',
        '    title: Work',
        '    nodes:',
        '      - id: a',
        '        noop: true',
      ].join('\n'),
      'utf8',
    );
    const defs = handlers.get('workflow:defs:list')!(undefined, projectDir) as Array<{
      name: string;
      scope: string;
      valid: boolean;
      phaseCount: number;
    }>;
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: 'repo-digest', scope: 'project', valid: true, phaseCount: 1 });

    const one = handlers.get('workflow:defs:get')!(undefined, { name: 'repo-digest', projectDir }) as {
      summary: { description: string };
      definition: { name: string };
    };
    expect(one.summary.description).toBe('Digest the repo');
    expect(one.definition.name).toBe('repo-digest');

    expect(handlers.get('workflow:defs:get')!(undefined, { name: 'ghost', projectDir })).toBeNull();
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

});
