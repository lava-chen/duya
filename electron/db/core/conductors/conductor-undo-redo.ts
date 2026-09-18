/**
 * conductor-undo-redo.ts — Pure-function undo/redo logic for conductor
 * actions, extracted from electron/ipc/db-handlers.ts during plan 534
 * Phase 3.7.b.
 *
 * Why pure: better-sqlite3 transactions must run inside a single call
 * stack, but the orchestration ("which action to undo", "what to write
 * back") can live outside the IPC handler. This module accepts a
 * SqliteDatabase handle and an onPatch callback, runs everything in a
 * transaction, and emits the patch via the hook. No Electron imports.
 *
 * Coverage: every action_type handled by `conductor:undo` and
 * `conductor:redo` in the legacy db-handlers.ts path. Phase 3.7.b'
 * added DML for element.create_native / connector.create /
 * element.update_content / element.reparent that previously no-op'd
 * here while still being inline in the action handler.
 */

import { invertPatch } from './invert-patch';
import type { SqliteDatabase } from '../database';

export interface ConductorUndoResult {
  success: boolean;
  actionId?: number;
  inverted?: Record<string, unknown>;
  reason?: string;
}

export interface ConductorRedoResult {
  success: boolean;
  actionId?: number;
  patch?: Record<string, unknown>;
  reason?: string;
}

export type ConductorPatchSink = (event: {
  kind: 'undo' | 'redo';
  canvasId: string;
  actionId: number;
  patch: Record<string, unknown>;
}) => void;

/**
 * Apply the inverse of the latest reversible action on a canvas.
 * Returns a typed result so the IPC layer can broadcast over ChannelManager.
 */
export function runConductorUndo(
  db: SqliteDatabase,
  canvasId: string,
  onPatch?: ConductorPatchSink,
): ConductorUndoResult {
  const d = db;
  const now = Date.now();

  const lastAction = d
    .prepare(
      'SELECT * FROM conductor_actions WHERE canvas_id = ? AND reversible = 1 AND undone_at IS NULL ORDER BY ts DESC LIMIT 1',
    )
    .get(canvasId) as
    | {
        id: number;
        widget_id: string | null;
        action_type: string;
        result_patch: string | null;
      }
    | undefined;
  if (!lastAction) return { success: false, reason: 'No reversible action to undo' };

  const patch = lastAction.result_patch ? JSON.parse(lastAction.result_patch) : null;
  if (!patch) return { success: false, reason: 'No result patch to invert' };

  const inverted = invertPatch(patch, lastAction.action_type);
  const actionId = lastAction.id;
  const widgetId = lastAction.widget_id;

  const txn = d.transaction(() => {
    d.prepare('UPDATE conductor_actions SET undone_at = ? WHERE id = ?').run(now, actionId);

    switch (lastAction.action_type) {
      case 'canvas.rename': {
        d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(
          inverted.name as string,
          now,
          canvasId,
        );
        break;
      }
      case 'widget.create': {
        d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
        d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
        break;
      }
      case 'widget.move':
      case 'widget.resize': {
        d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(inverted.position),
          now,
          widgetId,
        );
        const widgetPos = inverted.position as { x?: number; y?: number; w?: number; h?: number };
        const canvasPos = {
          x: widgetPos.x ?? 0,
          y: widgetPos.y ?? 0,
          w: widgetPos.w ?? 4,
          h: widgetPos.h ?? 3,
          zIndex: 0,
          rotation: 0,
        };
        d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(canvasPos),
          now,
          widgetId,
        );
        break;
      }
      case 'widget.update_config': {
        d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(inverted.config),
          now,
          widgetId,
        );
        d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(inverted.config),
          now,
          widgetId,
        );
        break;
      }
      case 'widget.update_data': {
        d.prepare(
          'UPDATE conductor_widgets SET data = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(inverted.data), now, widgetId);
        d.prepare(
          'UPDATE conductor_elements SET config = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(inverted.data), now, widgetId);
        break;
      }
      case 'widget.delete': {
        const delWidget = (patch as any).deletedWidget;
        if (delWidget) {
          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`,
          ).run(
            delWidget.id,
            canvasId,
            delWidget.kind,
            delWidget.type,
            JSON.stringify(delWidget.position),
            JSON.stringify(delWidget.config),
            JSON.stringify(delWidget.data),
            delWidget.dataVersion,
            JSON.stringify(delWidget.permissions),
            now,
            now,
          );
          const dwPos = delWidget.position;
          const ecPos = {
            x: dwPos.x ?? 0,
            y: dwPos.y ?? 0,
            w: dwPos.w ?? 4,
            h: dwPos.h ?? 3,
            zIndex: 0,
            rotation: 0,
          };
          const mgConfig = { ...delWidget.data, ...delWidget.config };
          const ecMeta = { label: `${delWidget.kind}:${delWidget.type}`, tags: [], createdBy: 'user' };
          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`,
          ).run(
            delWidget.id,
            canvasId,
            `widget/${delWidget.type}`,
            JSON.stringify(ecPos),
            JSON.stringify(mgConfig),
            delWidget.dataVersion,
            JSON.stringify(delWidget.permissions),
            JSON.stringify(ecMeta),
            now,
            now,
          );
        }
        break;
      }
      case 'widget.restore': {
        d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
        d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
        break;
      }
      case 'element.create': {
        d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
        break;
      }
      case 'element.move': {
        d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(inverted.position),
          now,
          widgetId,
        );
        break;
      }
      case 'element.update': {
        if (inverted.config !== undefined) {
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(inverted.config),
            now,
            widgetId,
          );
        }
        if ((inverted as any).vizSpec !== undefined) {
          d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(
            (inverted as any).vizSpec ? JSON.stringify((inverted as any).vizSpec) : null,
            now,
            widgetId,
          );
        }
        if (inverted.position !== undefined) {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(inverted.position),
            now,
            widgetId,
          );
        }
        break;
      }
      case 'element.delete': {
        const delElement = (patch as any).deletedElement;
        if (delElement) {
          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          ).run(
            delElement.id,
            canvasId,
            delElement.elementKind,
            JSON.stringify(delElement.position),
            JSON.stringify(delElement.config),
            delElement.vizSpec ? JSON.stringify(delElement.vizSpec) : null,
            delElement.state,
            delElement.dataVersion,
            JSON.stringify(delElement.permissions),
            JSON.stringify(delElement.metadata),
            now,
            now,
          );
        }
        break;
      }
      case 'element.arrange': {
        break;
      }
      // Phase 3.7.b' ports the four action_types whose forward DML writes
      // to conductor_elements (native nodes, connectors, content merge,
      // reparent) into the undo path. The redo path lives further down.
      case 'element.create_native': {
        const nativeId = inverted.elementId as string | undefined;
        if (nativeId) {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(nativeId);
        }
        break;
      }
      case 'connector.create': {
        const connectorId = inverted.elementId as string | undefined;
        if (connectorId) {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(connectorId);
        }
        break;
      }
      case 'element.update_content': {
        const prevConfig = inverted.content as Record<string, unknown> | undefined;
        if (widgetId && prevConfig !== undefined) {
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(prevConfig),
            now,
            widgetId,
          );
        }
        break;
      }
      case 'element.reparent': {
        const prevParentId = inverted.parentId as string | null | undefined;
        if (widgetId) {
          const existing = d
            .prepare('SELECT metadata FROM conductor_elements WHERE id = ? AND canvas_id = ?')
            .get(widgetId, canvasId) as { metadata: string } | undefined;
          if (existing) {
            const meta = JSON.parse(existing.metadata);
            meta.parentId = prevParentId ?? null;
            d.prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(
              JSON.stringify(meta),
              now,
              widgetId,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  });
  txn();

  onPatch?.({ kind: 'undo', canvasId, actionId, patch: inverted });
  return { success: true, actionId, inverted };
}

/**
 * Replay the most recently undone action on a canvas.
 */
export function runConductorRedo(
  db: SqliteDatabase,
  canvasId: string,
  onPatch?: ConductorPatchSink,
): ConductorRedoResult {
  const d = db;
  const now = Date.now();

  const undoneAction = d
    .prepare(
      'SELECT * FROM conductor_actions WHERE canvas_id = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC LIMIT 1',
    )
    .get(canvasId) as
    | {
        id: number;
        widget_id: string | null;
        action_type: string;
        result_patch: string | null;
      }
    | undefined;
  if (!undoneAction) return { success: false, reason: 'No action to redo' };

  const patch = undoneAction.result_patch ? JSON.parse(undoneAction.result_patch) : null;
  if (!patch) return { success: false, reason: 'No result patch to redo' };

  const actionId = undoneAction.id;
  const widgetId = undoneAction.widget_id;

  const txn = d.transaction(() => {
    d.prepare('UPDATE conductor_actions SET undone_at = NULL WHERE id = ?').run(actionId);

    switch (undoneAction.action_type) {
      case 'canvas.rename': {
        d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(
          (patch as any).name,
          now,
          canvasId,
        );
        break;
      }
      case 'widget.create': {
        const widget = (patch as any).widget;
        d.prepare(
          `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`,
        ).run(
          widget.id,
          canvasId,
          widget.kind,
          widget.type,
          JSON.stringify(widget.position),
          JSON.stringify(widget.config),
          JSON.stringify(widget.data),
          widget.dataVersion,
          JSON.stringify(widget.permissions),
          widget.createdAt,
          now,
        );
        const element = (patch as any).element;
        if (element) {
          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`,
          ).run(
            element.id,
            canvasId,
            element.elementKind,
            JSON.stringify(element.position),
            JSON.stringify(element.config),
            element.dataVersion ?? 1,
            JSON.stringify(element.permissions),
            JSON.stringify(element.metadata),
            element.createdAt ?? now,
            now,
          );
        }
        break;
      }
      case 'widget.move':
      case 'widget.resize': {
        d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify((patch as any).position),
          now,
          widgetId,
        );
        const wPos = (patch as any).position;
        const cPos = {
          x: wPos.x ?? 0,
          y: wPos.y ?? 0,
          w: wPos.w ?? 4,
          h: wPos.h ?? 3,
          zIndex: 0,
          rotation: 0,
        };
        d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(cPos),
          now,
          widgetId,
        );
        break;
      }
      case 'widget.update_config': {
        d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify((patch as any).config),
          now,
          widgetId,
        );
        d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify((patch as any).config),
          now,
          widgetId,
        );
        break;
      }
      case 'widget.update_data': {
        d.prepare(
          'UPDATE conductor_widgets SET data = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify((patch as any).data), now, widgetId);
        d.prepare(
          'UPDATE conductor_elements SET config = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify((patch as any).data), now, widgetId);
        break;
      }
      case 'widget.delete': {
        d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
        d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
        break;
      }
      case 'widget.restore': {
        const restoredWidget = (patch as any).restoredWidget;
        if (restoredWidget) {
          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`,
          ).run(
            restoredWidget.id,
            canvasId,
            restoredWidget.kind,
            restoredWidget.type,
            JSON.stringify(restoredWidget.position),
            JSON.stringify(restoredWidget.config),
            JSON.stringify(restoredWidget.data),
            restoredWidget.dataVersion,
            JSON.stringify(restoredWidget.permissions),
            now,
            now,
          );
          const rsPos = restoredWidget.position;
          const rsCPos = {
            x: rsPos.x ?? 0,
            y: rsPos.y ?? 0,
            w: rsPos.w ?? 4,
            h: rsPos.h ?? 3,
            zIndex: 0,
            rotation: 0,
          };
          const rsConfig = { ...restoredWidget.data, ...restoredWidget.config };
          const rsMeta = { label: `${restoredWidget.kind}:${restoredWidget.type}`, tags: [], createdBy: 'user' };
          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`,
          ).run(
            restoredWidget.id,
            canvasId,
            `widget/${restoredWidget.type}`,
            JSON.stringify(rsCPos),
            JSON.stringify(rsConfig),
            restoredWidget.dataVersion,
            JSON.stringify(restoredWidget.permissions),
            JSON.stringify(rsMeta),
            now,
            now,
          );
        }
        break;
      }
      case 'element.create': {
        const element = (patch as any).element;
        if (element) {
          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          ).run(
            element.id,
            canvasId,
            element.elementKind,
            JSON.stringify(element.position),
            JSON.stringify(element.config),
            element.vizSpec ? JSON.stringify(element.vizSpec) : null,
            element.state,
            element.dataVersion,
            JSON.stringify(element.permissions),
            JSON.stringify(element.metadata),
            element.createdAt,
            now,
          );
        }
        break;
      }
      case 'element.move': {
        d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify((patch as any).position),
          now,
          widgetId,
        );
        break;
      }
      case 'element.update': {
        if ((patch as any).config !== undefined) {
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify((patch as any).config),
            now,
            widgetId,
          );
        }
        if ((patch as any).vizSpec !== undefined) {
          d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify((patch as any).vizSpec),
            now,
            widgetId,
          );
        }
        if ((patch as any).position !== undefined) {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify((patch as any).position),
            now,
            widgetId,
          );
        }
        break;
      }
      case 'element.delete': {
        d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);
        break;
      }
      case 'element.arrange': {
        break;
      }
      // Phase 3.7.b' redo DML — re-applies the forward action's effect.
      // element.create_native / connector.create both INSERT a fresh row
      // into conductor_elements from (patch).element (connectors share the
      // same table with element_kind=native/connector).
      // Placeholder count (10 `?` after the inline NULL/NULL/'idle'/1):
      //   element.id, canvasId, element.elementKind, element.nativeKind,
      //   JSON.stringify(position), JSON.stringify(config),
      //   JSON.stringify(permissions), JSON.stringify(metadata),
      //   element.createdAt ?? now, now (updated_at)
      case 'element.create_native':
      case 'connector.create': {
        const element = (patch as any).element;
        if (element) {
          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`,
          ).run(
            element.id,
            canvasId,
            element.elementKind,
            element.nativeKind ?? null,
            JSON.stringify(element.position),
            JSON.stringify(element.config),
            JSON.stringify(element.permissions),
            JSON.stringify(element.metadata),
            element.createdAt ?? now,
            now,
          );
        }
        break;
      }
      case 'element.update_content': {
        const nextConfig = (patch as any).config as Record<string, unknown> | undefined;
        if (widgetId && nextConfig !== undefined) {
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(nextConfig),
            now,
            widgetId,
          );
        }
        break;
      }
      case 'element.reparent': {
        if (widgetId) {
          const existing = d
            .prepare('SELECT metadata FROM conductor_elements WHERE id = ? AND canvas_id = ?')
            .get(widgetId, canvasId) as { metadata: string } | undefined;
          if (existing) {
            const meta = JSON.parse(existing.metadata);
            const newParentId = ((patch as any).metadata?.parentId ?? null) as string | null;
            meta.parentId = newParentId;
            d.prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(
              JSON.stringify(meta),
              now,
              widgetId,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  });
  txn();

  onPatch?.({ kind: 'redo', canvasId, actionId, patch });
  return { success: true, actionId, patch };
}