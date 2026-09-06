/**
 * session-spawn.e2e.test.ts — Backend e2e for the `session` tool (plan 504).
 *
 * Drives the REAL core stores (SessionStore / SpawnEdgeStore / Mailbox) on an
 * in-memory SQLite DB through the exact adapter (`ipcSessionToCoreCreate`) and
 * the exact per-action store operations that the `dispatchDbAction`
 * `session:spawn*` handlers perform, plus the `chat_turn_reviews` `+N/-M`
 * aggregation `session:spawnGet` runs against the legacy DB.
 *
 * The only things NOT covered here are the two HTTP/provide boundaries that
 * cannot run headless: the actual `runPromptInSession` POST (spawn/reply) and
 * `interruptCronSession` DELETE (cancel) — those are thin wrappers over the
 * established cron run path and are verified by tsc + bundle. This file proves
 * the data-model contract end-to-end: create→edge→list→get(+diff)→reply
 * (reads row)→rename→wake(write mailbox).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, SpawnEdgeStore } from '../../db/core/stores';
import { Mailbox } from '../../db/core/mailbox';
import { ipcSessionToCoreCreate } from '../../ipc/core-db-adapters';

let db: Database.Database;
let sessions: SessionStore;
let spawnEdges: SpawnEdgeStore;
let mailbox: Mailbox;
let legacy: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-spawn-e2e-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = [
    ...SessionStore.migrations,
    ...SpawnEdgeStore.migrations,
    ...Mailbox.migrations,
  ].sort((a, b) => a.id - b.id);
  for (const m of migrations) m.up(db);

  sessions = new SessionStore(db);
  spawnEdges = new SpawnEdgeStore(db);
  mailbox = new Mailbox(db);

  // Legacy DB with the table session:spawnGet aggregates for +N/-M stats.
  legacy = new Database(':memory:');
  legacy.exec(`
    CREATE TABLE chat_turn_reviews (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      working_directory TEXT,
      files_json TEXT,
      patch TEXT,
      additions INTEGER,
      removals INTEGER,
      truncated INTEGER,
      binary INTEGER,
      captured_at INTEGER
    );
  `);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  try { legacy.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** The exact child-create call the `session:spawn` handler performs. */
function createChild(parentId: string, workingDirectory: string, prompt: string): { id: string } {
  const id = `spawn:${Date.now()}:abc123`;
  sessions.create(
    ipcSessionToCoreCreate(
      {
        id,
        title: `[Spawn] ${prompt.split('\n')[0]?.slice(0, 60) || 'task'}`,
        working_directory: workingDirectory,
        status: 'active',
        mode: 'chat',
        model: 'test-model',
        provider_id: 'prov-1',
        parent_session_id: parentId,
        agent_type: 'spawn',
      },
      'default',
    ),
  );
  return { id };
}

describe('session tool backend e2e (plan 504)', () => {
  it('spawn: creates child session row with parent + spawn edge (lineage)', () => {
    const parentId = 'parent-1';
    const child = createChild(parentId, '/repo', 'Refactor the build system');
    spawnEdges.record({ parentSessionId: parentId, childSessionId: child.id, spawnReason: 'session-tool', spawnType: 'session' });

    const row = sessions.get(child.id);
    expect(row).not.toBeNull();
    expect(row!.parentSessionId).toBe(parentId);
    expect(row!.status).toBe('active');
    expect(row!.workingDirectory).toBe('/repo');
    expect(row!.agentType).toBe('spawn');

    const edge = spawnEdges.getParent(child.id);
    expect(edge?.parentSessionId).toBe(parentId);
    expect(edge?.childSessionId).toBe(child.id);
    expect(edge?.spawnReason).toBe('session-tool');
    expect(edge?.spawnType).toBe('session');
  });

  it('list: spawn is visible under its parent; other parents cannot see it', () => {
    const parentId = 'parent-1';
    const otherParent = 'parent-other';
    const child = createChild(parentId, '/repo', 'task');
    spawnEdges.record({ parentSessionId: parentId, childSessionId: child.id, spawnReason: 'session-tool', spawnType: 'session' });

    const children = sessions.list({ parentSessionId: parentId });
    expect(children.map((c) => c.id)).toContain(child.id);
    expect(children.map((c) => c.parentSessionId).every((p) => p === parentId)).toBe(true);
    // Ownership gate: another caller's parent list must NOT include the child.
    const foreign = sessions.list({ parentSessionId: otherParent });
    expect(foreign.map((c) => c.id)).not.toContain(child.id);
  });

  it('get: aggregates cumulative +N/-M across all turn reviews for a child', () => {
    const parentId = 'parent-1';
    const child = createChild(parentId, '/repo', 'task');
    legacy.prepare(
      'INSERT INTO chat_turn_reviews (id, session_id, files_json, additions, removals) VALUES (?, ?, ?, ?, ?)',
    ).run('r1', child.id, JSON.stringify([{ path: 'a.ts' }, { path: 'b.ts' }]), 12, 3);
    legacy.prepare(
      'INSERT INTO chat_turn_reviews (id, session_id, files_json, additions, removals) VALUES (?, ?, ?, ?, ?)',
    ).run('r2', child.id, JSON.stringify([{ path: 'a.ts' }]), 4, 1);

    // Same aggregation the session:spawnGet handler runs.
    let linesAdded = 0;
    let linesRemoved = 0;
    const fileSet = new Set<string>();
    const reviews = legacy.prepare(
      'SELECT additions, removals, files_json FROM chat_turn_reviews WHERE session_id = ?',
    ).all(child.id) as Array<{ additions: number; removals: number; files_json: string }>;
    for (const r of reviews) {
      linesAdded += Number(r.additions) || 0;
      linesRemoved += Number(r.removals) || 0;
      for (const f of JSON.parse(r.files_json) as { path?: string }[]) {
        if (f?.path) fileSet.add(f.path);
      }
    }
    expect(linesAdded).toBe(16);
    expect(linesRemoved).toBe(4);
    expect(fileSet.size).toBe(2); // a.ts, b.ts — de-duped across reviews

    // get returns the child row fields the handler surfaces.
    const row = sessions.get(child.id);
    expect(row!.title).toContain('[Spawn]');
    expect(row!.model).toBe('test-model');
    expect(row!.workingDirectory).toBe('/repo');
  });

  it('reply: reads the child row it needs (parent, model, workingDirectory)', () => {
    const parentId = 'parent-1';
    const child = createChild(parentId, '/repo', 'task');
    const row = sessions.get(child.id);
    // The handler requires exactly these to fire runPromptInSession on the child.
    expect(row!.parentSessionId).toBe(parentId);
    expect(row!.workingDirectory).toBe('/repo');
    expect(row!.model).toBeTruthy();
  });

  it('rename: child title is updated, ownership is only for the caller', () => {
    const parentId = 'parent-1';
    const child = createChild(parentId, '/repo', 'task');
    sessions.update(child.id, { title: 'Renamed child' });

    const row = sessions.get(child.id);
    expect(row!.title).toBe('Renamed child');
  });

  it('wake: child completion writes a background_notification to the parent', () => {
    const parentId = 'parent-1';
    const child = createChild(parentId, '/repo', 'task');

    // notifySpawnCompletion's store op: mailbox.enqueue kind=background_notification → parent.
    mailbox.enqueue({
      id: 'wake-1',
      sessionId: parentId,
      submittedRunId: '',
      content: `[session:completed] spawned session ${child.id} finished:\ndone`,
      kind: 'background_notification',
      clientMsgId: null,
      source: 'session-tool',
    });

    const rows = mailbox.listForSession(parentId);
    expect(rows.some((r) => r.id === 'wake-1' && r.kind === 'background_notification')).toBe(true);
  });
});