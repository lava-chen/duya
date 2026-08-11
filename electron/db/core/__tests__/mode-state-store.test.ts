/**
 * mode-state-store.test.ts — ModeStateStore (plan 413c).
 *
 * Coverage:
 *  - upsert → get round-trip (camelCase row surface)
 *  - get returns null for a missing (session, mode) pair
 *  - repeated upsert is idempotent (single row, overwrite semantics)
 *  - setStatus updates only the queryable status column
 *  - listBySession returns all modes for a session
 *  - listByStatus filters across sessions
 *  - delete removes the row and reports whether one existed
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModeStateStore } from '../stores';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('ModeStateStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: ModeStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-state-store-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    for (const m of ModeStateStore.migrations) m.up(db);
    store = new ModeStateStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('upsert then get returns the camelCase row', () => {
    store.upsert('sess-1', 'plan-task', 'active', JSON.stringify({ state: 'active' }), 3);

    const row = store.get('sess-1', 'plan-task');
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe('sess-1');
    expect(row!.mode).toBe('plan-task');
    expect(row!.status).toBe('active');
    expect(row!.reminderCount).toBe(3);
    expect(JSON.parse(row!.snapshotJson)).toEqual({ state: 'active' });
    expect(typeof row!.updatedAt).toBe('number');
  });

  it('get returns null for a missing (session, mode) pair', () => {
    expect(store.get('missing', 'plan-task')).toBeNull();

    store.upsert('sess-1', 'plan-task', 'active', '{}', 0);
    // Same session, different mode → still no row.
    expect(store.get('sess-1', 'goal-mode')).toBeNull();
  });

  it('repeated upsert is idempotent — overwrites, keeps a single row', () => {
    store.upsert('sess-1', 'plan-task', 'pending', JSON.stringify({ state: 'pending' }), 0);
    store.upsert('sess-1', 'plan-task', 'active', JSON.stringify({ state: 'active' }), 5);

    const rows = db.prepare('SELECT * FROM mode_state_snapshots').all() as unknown[];
    expect(rows).toHaveLength(1);

    const row = store.get('sess-1', 'plan-task')!;
    expect(row.status).toBe('active');
    expect(row.reminderCount).toBe(5);
    expect(JSON.parse(row.snapshotJson)).toEqual({ state: 'active' });
  });

  it('setStatus updates only the queryable status column', () => {
    store.upsert('sess-1', 'plan-task', 'active', JSON.stringify({ state: 'active' }), 2);
    const before = store.get('sess-1', 'plan-task')!.updatedAt;

    store.setStatus('sess-1', 'plan-task', 'inactive');

    const row = store.get('sess-1', 'plan-task')!;
    expect(row.status).toBe('inactive');
    // Payload and reminder count untouched.
    expect(JSON.parse(row.snapshotJson)).toEqual({ state: 'active' });
    expect(row.reminderCount).toBe(2);
    expect(row.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('listBySession returns every mode snapshot for the session', () => {
    store.upsert('sess-1', 'plan-task', 'active', '{}', 2);
    store.upsert('sess-1', 'goal-mode', 'inactive', '{}', 0);
    store.upsert('sess-2', 'plan-task', 'inactive', '{}', 0);

    const rows = store.listBySession('sess-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.mode).sort()).toEqual(['goal-mode', 'plan-task']);
  });

  it('listByStatus filters across sessions', () => {
    store.upsert('sess-1', 'plan-task', 'active', '{}', 0);
    store.upsert('sess-2', 'plan-task', 'inactive', '{}', 0);
    store.upsert('sess-3', 'plan-task', 'active', '{}', 0);

    const rows = store.listByStatus('active');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['sess-1', 'sess-3']);
  });

  it('delete removes the row and reports whether one existed', () => {
    store.upsert('sess-1', 'plan-task', 'active', '{}', 0);
    expect(store.delete('sess-1', 'plan-task')).toBe(true);
    expect(store.get('sess-1', 'plan-task')).toBeNull();
    // Second delete is a no-op.
    expect(store.delete('sess-1', 'plan-task')).toBe(false);
  });
});
