/**
 * project-store.test.ts — ProjectStore CRUD coverage for `duya-core.db`.
 *
 * The project entity (name/description/paths + project_bots + icon/color)
 * moved here from memory-state (plan 534). The legacy memory-state
 * projectEntity.test.ts was removed; this minimal suite is its replacement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectStore,
  parseProjectPaths,
  serializeProjectPaths,
  type ProjectRow,
} from '../project-store';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('ProjectStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: ProjectStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-project-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of ProjectStore.migrations) m.up(db);
    store = new ProjectStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('insert → get round-trips a project with defaults', () => {
    const row = store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    expect(row.project_id).toBe('p-1');
    expect(row.name).toBe('');
    expect(row.description).toBeNull();
    expect(parseProjectPaths(row.paths)).toEqual([]);
    expect(row.icon).toBeNull();
    expect(row.color).toBeNull();
    expect(row.created_at).toBeTypeOf('number');
    expect(row.last_seen_at).toBeTypeOf('number');

    const fetched = store.get('p-1');
    expect(fetched).toEqual(row);
    expect(store.get('missing')).toBeNull();
  });

  it('update patches entity fields', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    const ok = store.update('p-1', {
      name: 'duya',
      description: 'Agent desktop app',
      icon: 'rocket',
      color: 'blue',
    });
    expect(ok).toBe(true);
    const row = store.get('p-1')!;
    expect(row.name).toBe('duya');
    expect(row.description).toBe('Agent desktop app');
    expect(row.icon).toBe('rocket');
    expect(row.color).toBe('blue');
    // update on a missing id returns false.
    expect(store.update('missing', { name: 'x' })).toBe(false);
  });

  it('update with paths keeps canonical_root coherent with paths[0]', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    store.update('p-1', {
      paths: serializeProjectPaths([
        { path: 'E:/repos/one', description: 'main' },
        { path: 'E:/repos/one-site', description: null },
      ]),
      canonical_root: 'E:/repos/one',
    });
    const row = store.get('p-1')!;
    expect(row.canonical_root).toBe('E:/repos/one');
    expect(parseProjectPaths(row.paths)).toEqual([
      { path: 'E:/repos/one', description: 'main' },
      { path: 'E:/repos/one-site', description: null },
    ]);
  });

  it('appendPath dedupes — same path is not added twice', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    store.appendPath('p-1', 'E:/repos/one');
    store.appendPath('p-1', 'E:/repos/one');
    store.appendPath('p-1', 'E:/repos/one-site');
    const row = store.get('p-1')!;
    expect(parseProjectPaths(row.paths).map((e) => e.path)).toEqual([
      'E:/repos/one',
      'E:/repos/one-site',
    ]);
  });

  it('touch updates last_seen_at', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    const later = Date.now() + 5000;
    store.touch('p-1', later);
    expect(store.get('p-1')!.last_seen_at).toBe(later);
  });

  it('joinBot / listBotsByProject / removeBot round-trip with PK dedupe', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    store.addBot('p-1', 'bot-a', 1000);
    store.addBot('p-1', 'bot-b', 2000);
    // Duplicate membership is ignored (INSERT OR IGNORE on composite PK).
    store.addBot('p-1', 'bot-a', 3000);

    let bots = store.listBotsByProject('p-1');
    expect(bots).toEqual([
      { project_id: 'p-1', bot_id: 'bot-a', joined_at: 1000 },
      { project_id: 'p-1', bot_id: 'bot-b', joined_at: 2000 },
    ]);

    store.removeBot('p-1', 'bot-a');
    bots = store.listBotsByProject('p-1');
    expect(bots.map((b) => b.bot_id)).toEqual(['bot-b']);
  });

  it('list orders by created_at or last_seen_at', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    store.insert({ project_id: 'p-2', canonical_root: 'E:/repos/two' });
    db.prepare('UPDATE projects SET created_at = 100 WHERE project_id = ?').run('p-1');
    db.prepare('UPDATE projects SET created_at = 200 WHERE project_id = ?').run('p-2');

    expect(store.list().map((p) => p.project_id)).toEqual(['p-1', 'p-2']);
    expect(store.list({ orderBy: 'last_seen_at' })).toHaveLength(2);
  });

  it('delete removes the project row', () => {
    store.insert({ project_id: 'p-1', canonical_root: 'E:/repos/one' });
    expect(store.delete('p-1')).toBe(true);
    expect(store.get('p-1')).toBeNull();
    expect(store.delete('p-1')).toBe(false);
  });
});