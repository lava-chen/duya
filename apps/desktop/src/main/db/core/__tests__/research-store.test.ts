import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResearchStore } from '../research-store';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('ResearchStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: ResearchStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-research-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    for (const m of ResearchStore.migrations) m.up(db);
    store = new ResearchStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('runs all migrations', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('research_sessions');
    expect(tableNames).toContain('research_activities');
    expect(tableNames).toContain('research_events');
    expect(tableNames).toContain('research_projects');
    expect(tableNames).toContain('research_memory_objects');
    expect(tableNames).toContain('research_sources');
    expect(tableNames).toContain('import_batches');
  });

  it('createSession + getSession', () => {
    db.exec("INSERT INTO chat_sessions (id, created_at) VALUES ('ss1', 0)");
    const session = store.createSession({
      id: 's1',
      sessionId: 'ss1',
      originalQuery: 'test query',
    });
    expect(session.id).toBe('s1');
    expect(store.getSession('s1')?.id).toBe('s1');
  });

  it('updateSession', () => {
    db.exec("INSERT INTO chat_sessions (id, created_at) VALUES ('ss1', 0)");
    store.createSession({ id: 's1', sessionId: 'ss1', originalQuery: 'test' });
    const updated = store.updateSession('s1', { status: 'completed' });
    expect(updated?.status).toBe('completed');
  });

  it('createActivity + getActivitiesByRunId', () => {
    db.exec("INSERT INTO chat_sessions (id, created_at) VALUES ('ss1', 0)");
    store.createSession({ id: 's1', sessionId: 'ss1', originalQuery: 'test' });
    const act = store.createActivity({ id: 'a1', runId: 's1', sequence: 1, kind: 'search', title: 'Search' });
    expect(act.id).toBe('a1');
    const acts = store.getActivitiesByRunId('s1');
    expect(acts).toHaveLength(1);
  });

  it('createEvent + getEventsByRunId', () => {
    db.exec("INSERT INTO chat_sessions (id, created_at) VALUES ('ss1', 0)");
    store.createSession({ id: 's1', sessionId: 'ss1', originalQuery: 'test' });
    store.createEvent({ id: 'e1', runId: 's1', sequence: 1, eventType: 'search.started', payloadJson: '{}' });
    const evts = store.getEventsByRunId('s1');
    expect(evts).toHaveLength(1);
  });

  it('upsertSource + getSourcesByRunId', () => {
    db.exec("INSERT INTO chat_sessions (id, created_at) VALUES ('ss1', 0)");
    store.createSession({ id: 's1', sessionId: 'ss1', originalQuery: 'test' });
    store.upsertSource({ id: 'src1', runId: 's1', title: 'Test', sourceType: 'web', url: 'https://example.com' });
    const srcs = store.getSourcesByRunId('s1');
    expect(srcs).toHaveLength(1);
  });

  it('createProject + listProjects + deleteProject', () => {
    store.createProject({ id: 'p1', name: 'Test Project' });
    expect(store.listProjects()).toHaveLength(1);
    store.deleteProject('p1');
    expect(store.listProjects()).toHaveLength(0);
  });

  it('createMemoryObject + searchMemoryObjects', () => {
    store.createProject({ id: 'p1', name: 'Test' });
    store.createMemoryObject({ id: 'm1', projectId: 'p1', type: 'fact', content: 'The sky is blue' });
    const results = store.searchMemoryObjects('sky', { projectId: 'p1' });
    expect(results).toHaveLength(1);
  });

  it('createImportBatch + createImportItem', () => {
    store.createImportBatch({ id: 'b1', source: 'web' });
    store.createImportItem({
      id: 'i1',
      batchId: 'b1',
      sourceType: 'url',
      sourcePath: 'https://x.com',
      targetType: 'file',
      targetPath: '/tmp/x',
      title: 'Test URL',
    });
    const items = store.getImportItemsByBatch('b1');
    expect(items).toHaveLength(1);
  });
});
