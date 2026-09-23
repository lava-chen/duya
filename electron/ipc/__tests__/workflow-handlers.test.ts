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
import { registerWorkflowHandlers, _setWorkflowRuntimeHttpForTesting } from '../workflow-handlers';

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
        'workflow:get-events',
        'workflow:journal',
        'workflow:list',
        'workflow:list-runs',
        'workflow:permission-resolve',
        'workflow:run',
        'workflow:snapshot',
        'workflow:status',
        'workflow:trigger',
      ].sort(),
    );
  });

  it('cancel keeps session-anchored runs on the store-level path', async () => {
    const store = getCoreStores().workflowRuns;

    const done = store.createRun({ workflowName: 'a', status: 'complete', origin: 'session' });
    await expect(handlers.get('workflow:cancel')!(undefined, done.id)).resolves.toEqual({ ok: false, reason: 'terminal' });

    const parked = store.createRun({ workflowName: 'b', status: 'blocked', origin: 'session' });
    store.setWaitTill(parked.id, Date.now() + 60_000);
    await expect(handlers.get('workflow:cancel')!(undefined, parked.id)).resolves.toEqual({ ok: true });
    const after = store.getRun(parked.id)!;
    expect(after.status).toBe('cancelled');
    expect(after.waitTill).toBeNull();

    await expect(handlers.get('workflow:cancel')!(undefined, 'ghost')).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('cancel forwards a library run to the runtime and does not lie about its status', async () => {
    const store = getCoreStores().workflowRuns;
    // `origin` defaults to 'library', so a run only reaches the store-level
    // path when the session anchor stamps itself explicitly.
    const run = store.createRun({ workflowName: 'lib', status: 'active' });
    expect(run.origin).toBe('library');

    const calls: Array<{ path: string; payload: unknown }> = [];
    _setWorkflowRuntimeHttpForTesting(async (path, payload) => {
      calls.push({ path, payload });
      return { status: 200, body: { ok: true } };
    });
    try {
      await expect(handlers.get('workflow:cancel')!(undefined, run.id)).resolves.toEqual({ ok: true });
      expect(calls).toEqual([{ path: `/workflow-runtime/${run.id}/cancel`, payload: {} }]);
      // Only the process that actually stopped the child may mark it terminal.
      expect(store.getRun(run.id)!.status).toBe('active');
    } finally {
      _setWorkflowRuntimeHttpForTesting(null);
    }
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

  // ─── plan 560: run-anchored surface ────────────────────────────────────────

  it('trigger posts the launch-dialog payload to the run-anchored endpoint', async () => {
    const calls: Array<{ path: string; payload: unknown }> = [];
    _setWorkflowRuntimeHttpForTesting(async (path, payload) => {
      calls.push({ path, payload });
      return { status: 201, body: { ok: true, runId: 'run-9' } };
    });
    try {
      await expect(
        handlers.get('workflow:trigger')!(undefined, {
          name: 'digest',
          projectDir: 'E:/proj',
          params: { day: 'mon' },
        }),
      ).resolves.toEqual({ ok: true, runId: 'run-9' });

      // §7.5: the dialog's directory is the run's cwd — it has to survive the
      // whole trip, because the manager turns it into the agent nodes'
      // workingDirectory.
      expect(calls).toEqual([
        {
          path: '/workflow-runtime/trigger',
          payload: { name: 'digest', projectDir: 'E:/proj', params: { day: 'mon' }, scope: null },
        },
      ]);
    } finally {
      _setWorkflowRuntimeHttpForTesting(null);
    }
  });

  it('trigger surfaces a refusal verbatim instead of a fake runId', async () => {
    _setWorkflowRuntimeHttpForTesting(async () => ({
      status: 503,
      body: { ok: false, error: 'no active LLM provider configured' },
    }));
    try {
      await expect(handlers.get('workflow:trigger')!(undefined, { name: 'digest' })).resolves.toEqual({
        ok: false,
        error: 'no active LLM provider configured',
      });
    } finally {
      _setWorkflowRuntimeHttpForTesting(null);
    }
  });

  it('reads the run record, history and journal backfill from the core store', () => {
    const store = getCoreStores().workflowRuns;
    const run = store.createRun({ workflowName: 'digest', status: 'active' });
    store.appendJournalRecord(run.id, {
      seq: 0, kind: 'phase', nodeId: 'p0', attempt: 1, status: 'running', action: 'collect', atMs: 1,
    });
    store.appendJournalRecord(run.id, {
      seq: 1, kind: 'node_result', nodeId: 'n1', attempt: 1, status: 'succeeded', atMs: 2,
    });
    const other = store.createRun({ workflowName: 'other', status: 'complete' });

    const record = handlers.get('workflow:status')!(undefined, run.id) as {
      workflowName: string;
      origin: string;
    };
    expect(record).toMatchObject({ workflowName: 'digest', origin: 'library' });

    const library = handlers.get('workflow:list-runs')!(undefined, { origin: 'library' }) as Array<{
      id: string;
    }>;
    expect(library.map((r) => r.id).sort()).toEqual([run.id, other.id].sort());

    const scoped = handlers.get('workflow:list-runs')!(undefined, { workflowName: 'digest' }) as Array<{
      id: string;
    }>;
    expect(scoped.map((r) => r.id)).toEqual([run.id]);

    // `afterSeq` is the backfill cursor: replay only what the client missed.
    const tail = handlers.get('workflow:get-events')!(undefined, { runId: run.id, afterSeq: 0 }) as Array<{
      seq: number;
    }>;
    expect(tail.map((e) => e.seq)).toEqual([1]);
    const all = handlers.get('workflow:get-events')!(undefined, { runId: run.id }) as Array<{
      seq: number;
    }>;
    expect(all.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('permission-resolve forwards the answer for the blocked child', async () => {
    const calls: Array<{ path: string; payload: unknown }> = [];
    _setWorkflowRuntimeHttpForTesting(async (path, payload) => {
      calls.push({ path, payload });
      return { status: 200, body: { ok: true } };
    });
    try {
      await expect(
        handlers.get('workflow:permission-resolve')!(undefined, {
          runId: 'run-1',
          requestId: 'req-7',
          decision: 'deny',
        }),
      ).resolves.toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: '/workflow-runtime/run-1/permission',
          payload: { requestId: 'req-7', decision: 'deny' },
        },
      ]);
    } finally {
      _setWorkflowRuntimeHttpForTesting(null);
    }
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
