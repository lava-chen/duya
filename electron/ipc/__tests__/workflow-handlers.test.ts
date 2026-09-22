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
import { _setCoreStoresForTesting, getCoreStores } from '../../db/core-connection';
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
  // The handler transitively imports `agent-server-lifecycle` →
  // `core/window-manager` → `core/bootstrap`, whose module-level
  // `isDev = !app?.isPackaged` reads `app`. Under vitest a named import that
  // the factory omits throws at module-eval time, so `app` (plus the
  // BrowserWindow surface window-manager touches while loading) must exist
  // even though this suite never drives them.
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  }),
}));

describe.skipIf(!nativeSqliteAvailable)('workflow console handlers', () => {
  let tmpDir: string;
  let coreDb: CoreDatabase;

  beforeEach(() => {
    registered.length = 0;
    handlers.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-handlers-test-'));
    const BetterSqlite3 = require('better-sqlite3') as typeof BetterSqlite3;
    coreDb = new CoreDatabase({
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
    // `_setCoreStoresForTesting(null)` only drops the reference — the SQLite
    // handle stays open and Windows refuses to unlink a locked file
    // (EBUSY). POSIX tolerates unlinking an open file, which is why this
    // only ever failed on Windows. Close the connection first, and keep the
    // cleanup non-fatal so the real assertion failure stays visible.
    try {
      coreDb.close();
    } catch {
      /* already closed — nothing to release */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a brief handle on the -wal/-shm siblings */
    }
  });

  it('registers exactly the console channels', () => {
    expect(registered.sort()).toEqual(
      [
        'workflow:cancel',
        'workflow:defs:create',
        'workflow:defs:delete',
        'workflow:defs:get',
        'workflow:defs:list',
        'workflow:defs:update',
        'workflow:delete',
        'workflow:dwf:delete',
        'workflow:dwf:get',
        'workflow:dwf:list',
        'workflow:dwf:save',
        'workflow:get',
        'workflow:journal',
        'workflow:list',
        'workflow:run',
        'workflow:snapshot',
      ].sort(),
    );
  });

  it('cancel refuses terminal runs and clears wait_till for parked ones', () => {
    const store = getCoreStores().workflowRuns;

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
    const store = getCoreStores().workflowRuns;
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
    // `WorkflowFileRegistry.list()` deliberately merges two roots: the
    // project scope the handler was given AND the real global library at
    // `~/.duya/workflows`. Asserting a total length therefore depended on
    // the developer's own home directory (any global def made it 2). Scope
    // the assertion to the project root this test created.
    const projectDefs = defs.filter((d) => d.scope === 'project');
    expect(projectDefs).toHaveLength(1);
    expect(projectDefs[0]).toMatchObject({ name: 'repo-digest', scope: 'project', valid: true, phaseCount: 1 });

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
