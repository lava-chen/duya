import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConductorStore } from '../conductor-store';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('ConductorStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: ConductorStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-conductor-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of ConductorStore.migrations) m.up(db);
    store = new ConductorStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('runs all migrations', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conductor_%' ORDER BY name"
    ).all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain('conductor_canvases');
    expect(tables.map(t => t.name)).toContain('conductor_canvas_groups');
    expect(tables.map(t => t.name)).toContain('conductor_widgets');
    expect(tables.map(t => t.name)).toContain('conductor_actions');
    expect(tables.map(t => t.name)).toContain('conductor_elements');
  });

  it('createCanvas + getCanvas + listCanvases', () => {
    const canvas = store.createCanvas({ name: 'My Canvas' });
    expect(canvas.id).toBeTruthy();
    expect(store.getCanvas(canvas.id)?.name).toBe('My Canvas');
    expect(store.listCanvases()).toHaveLength(1);
  });

  it('updateCanvas', () => {
    const canvas = store.createCanvas({ name: 'Old Name' });
    const updated = store.updateCanvas(canvas.id, { name: 'New Name' });
    expect(updated?.name).toBe('New Name');
  });

  it('deleteCanvas', () => {
    const canvas = store.createCanvas({ name: 'To Delete' });
    store.deleteCanvas(canvas.id);
    expect(store.getCanvas(canvas.id)).toBeNull();
  });

  it('createGroup + listGroups', () => {
    const group = store.createGroup({ name: 'Group 1' });
    expect(group.id).toBeTruthy();
    expect(store.listGroups()).toHaveLength(1);
  });

  it('createWidget + listWidgetsByCanvas', () => {
    const canvas = store.createCanvas({ name: 'Canvas' });
    const widget = store.createWidget({ canvasId: canvas.id, kind: 'widget', type: 'task-list' });
    expect(widget.id).toBeTruthy();
    expect(store.listWidgetsByCanvas(canvas.id)).toHaveLength(1);
  });

  it('createElement + listElementsByCanvas', () => {
    const canvas = store.createCanvas({ name: 'Canvas' });
    const elem = store.createElement({ canvasId: canvas.id, elementKind: 'native/sticky' });
    expect(elem.id).toBeTruthy();
    expect(store.listElementsByCanvas(canvas.id)).toHaveLength(1);
  });

  it('createAction + listActionsBySession', () => {
    const canvas = store.createCanvas({ name: 'Canvas' });
    store.createAction({ canvasId: canvas.id, actionType: 'widget.create', actor: 'user' });
    expect(store.listActionsBySession(canvas.id)).toHaveLength(1);
  });
});
