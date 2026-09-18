import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConductorStore } from '../../conductor-store';
import { runConductorRedo, runConductorUndo } from '../conductor-undo-redo';
import type { SqliteDatabase } from '../../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('runConductorUndo / runConductorRedo (plan 534 Phase 3.7.b)', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: ConductorStore;
  let patchSink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-undo-redo-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of ConductorStore.migrations) m.up(db);
    store = new ConductorStore(db);
    patchSink = vi.fn();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  describe('early-exit paths', () => {
    it('undo returns failure reason when no reversible action exists', () => {
      const result = runConductorUndo(db, 'missing-canvas');
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/No reversible/i);
      expect(patchSink).not.toHaveBeenCalled();
    });

    it('redo returns failure reason when no undone action exists', () => {
      const result = runConductorRedo(db, 'missing-canvas');
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/No action to redo/i);
    });
  });

  describe('canvas.rename', () => {
    it('undo restores the previous name and emits undo patch', () => {
      const canvas = store.createCanvas({ name: 'Original' });
      store.createAction({
        canvasId: canvas.id,
        actionType: 'canvas.rename',
        actor: 'user',
        resultPatch: { name: 'Renamed', prevName: 'Original' },
      });

      const result = runConductorUndo(db, canvas.id, patchSink);
      expect(result.success).toBe(true);
      expect(result.actionId).toBeDefined();
      expect(result.inverted).toEqual({ name: 'Original' });
      expect(store.getCanvas(canvas.id)?.name).toBe('Original');
      expect(patchSink).toHaveBeenCalledWith({
        kind: 'undo',
        canvasId: canvas.id,
        actionId: result.actionId,
        patch: { name: 'Original' },
      });
    });

    it('redo replays the rename after an undo', () => {
      const canvas = store.createCanvas({ name: 'Original' });
      store.createAction({
        canvasId: canvas.id,
        actionType: 'canvas.rename',
        actor: 'user',
        resultPatch: { name: 'Renamed', prevName: 'Original' },
      });

      runConductorUndo(db, canvas.id);
      const redo = runConductorRedo(db, canvas.id, patchSink);
      expect(redo.success).toBe(true);
      expect(redo.patch).toEqual({ name: 'Renamed', prevName: 'Original' });
      expect(store.getCanvas(canvas.id)?.name).toBe('Renamed');
    });
  });

  describe('widget.create / widget.delete (dual-table)', () => {
    it('undo of widget.create removes from widgets and elements tables', () => {
      const canvas = store.createCanvas({ name: 'C' });
      const widget = store.createWidget({
        canvasId: canvas.id,
        kind: 'widget',
        type: 'task-list',
      });
      store.createElement({
        canvasId: canvas.id,
        elementKind: 'widget/task-list',
      });
      store.createAction({
        canvasId: canvas.id,
        widgetId: widget.id,
        actionType: 'widget.create',
        actor: 'user',
        resultPatch: { widget: { id: widget.id }, element: { id: widget.id } },
      });

      const result = runConductorUndo(db, canvas.id);
      expect(result.success).toBe(true);
      expect(store.getWidget(widget.id)).toBeNull();
      expect(store.getElement(widget.id)).toBeNull();
    });

    it('undo of widget.delete re-inserts the widget and element', () => {
      const canvas = store.createCanvas({ name: 'C' });
      const widget = store.createWidget({
        canvasId: canvas.id,
        kind: 'widget',
        type: 'task-list',
      });
      store.createElement({
        canvasId: canvas.id,
        elementKind: 'widget/task-list',
      });
      // Manually delete the widget/element rows so the undo can re-insert them.
      db.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widget.id);
      db.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widget.id);
      store.createAction({
        canvasId: canvas.id,
        widgetId: widget.id,
        actionType: 'widget.delete',
        actor: 'user',
        resultPatch: {
          deletedWidget: {
            id: widget.id,
            kind: 'widget',
            type: 'task-list',
            position: { x: 0, y: 0, w: 4, h: 3 },
            config: {},
            data: {},
            dataVersion: 1,
            permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: false },
          },
        },
      });

      const result = runConductorUndo(db, canvas.id);
      expect(result.success).toBe(true);
      expect(store.getWidget(widget.id)).not.toBeNull();
      expect(store.getElement(widget.id)).not.toBeNull();
    });
  });

  describe('element.move / element.update', () => {
    it('undo of element.move restores the previous position', () => {
      const canvas = store.createCanvas({ name: 'C' });
      const elem = store.createElement({
        canvasId: canvas.id,
        elementKind: 'native/sticky',
        position: { x: 5, y: 5, w: 4, h: 3 },
      });
      store.createAction({
        canvasId: canvas.id,
        widgetId: elem.id,
        actionType: 'element.move',
        actor: 'user',
        resultPatch: { position: { x: 5, y: 5 }, prevPosition: { x: 1, y: 1 } },
      });

      runConductorUndo(db, canvas.id);
      const restored = store.getElement(elem.id);
      expect(restored?.position).toEqual({ x: 1, y: 1 });
    });

    it('undo of element.update restores config and position only (vizSpec left unchanged when not in patch)', () => {
      const canvas = store.createCanvas({ name: 'C' });
      const elem = store.createElement({
        canvasId: canvas.id,
        elementKind: 'native/sticky',
        position: { x: 5, y: 5, w: 4, h: 3 },
      });
      store.createAction({
        canvasId: canvas.id,
        widgetId: elem.id,
        actionType: 'element.update',
        actor: 'user',
        resultPatch: {
          config: { theme: 'dark' },
          prevConfig: { theme: 'light' },
          position: { x: 9, y: 9 },
          prevPosition: { x: 0, y: 0 },
        },
      });

      runConductorUndo(db, canvas.id);
      const restored = store.getElement(elem.id);
      expect(restored?.config).toEqual({ theme: 'light' });
      expect(restored?.position).toEqual({ x: 0, y: 0 });
    });
  });

  describe('undo/redo ordering', () => {
    it('undo marks the action as undone, then redo clears undone_at', () => {
      const canvas = store.createCanvas({ name: 'Original' });
      store.createAction({
        canvasId: canvas.id,
        actionType: 'canvas.rename',
        actor: 'user',
        resultPatch: { name: 'Renamed', prevName: 'Original' },
      });

      runConductorUndo(db, canvas.id);
      const actions1 = store.listActionsBySession(canvas.id);
      expect(actions1[0].undoneAt).not.toBeNull();

      runConductorRedo(db, canvas.id);
      const actions2 = store.listActionsBySession(canvas.id);
      expect(actions2[0].undoneAt).toBeNull();
    });

    it('emits undo then redo patches through the same sink', () => {
      const canvas = store.createCanvas({ name: 'X' });
      store.createAction({
        canvasId: canvas.id,
        actionType: 'canvas.rename',
        actor: 'user',
        resultPatch: { name: 'Y', prevName: 'X' },
      });

      runConductorUndo(db, canvas.id, patchSink);
      runConductorRedo(db, canvas.id, patchSink);

      expect(patchSink).toHaveBeenCalledTimes(2);
      expect(patchSink.mock.calls[0][0].kind).toBe('undo');
      expect(patchSink.mock.calls[1][0].kind).toBe('redo');
    });
  });

  describe('no-op action types', () => {
    it('element.arrange undo is a no-op (still commits to action log)', () => {
      const canvas = store.createCanvas({ name: 'C' });
      store.createAction({
        canvasId: canvas.id,
        actionType: 'element.arrange',
        actor: 'user',
        resultPatch: {},
      });

      const result = runConductorUndo(db, canvas.id);
      expect(result.success).toBe(true);
      expect(result.inverted).toEqual({});
    });
  });
});