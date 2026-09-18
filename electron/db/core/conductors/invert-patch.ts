/**
 * invert-patch.ts — Pure inverse-patch function for conductor actions.
 *
 * Extracted from electron/ipc/db-handlers.ts during plan 534 Phase 3.7
 * (route migration). Given a result patch produced by a conductor:action
 * and the action_type, returns the patch that restores the previous state.
 *
 * The IPC handler then applies this inverted patch inside a SQLite
 * transaction and broadcasts it on the conductor channel.
 *
 * Why pure: invert-patch must be unit-testable in isolation and must not
 * import better-sqlite3, channelManager, or any Electron module.
 *
 * Coverage: every action_type handled by `conductor:action` must have a
 * branch here — otherwise undo silently no-ops. As of plan 534 Phase 3.7,
 * the action handler covers 17 action_types; all 17 are listed below.
 *
 * Widget.* cases remain because plan 534 Phase 3.6 has not yet removed the
 * legacy dual-write path. Once Phase 3.6 lands, the widget.* branches
 * become dead code and can be deleted.
 */

export type ConductorActionType =
  | 'canvas.rename'
  | 'widget.create'
  | 'widget.move'
  | 'widget.resize'
  | 'widget.update_config'
  | 'widget.update_data'
  | 'widget.delete'
  | 'widget.restore'
  | 'element.create'
  | 'element.move'
  | 'element.update'
  | 'element.delete'
  | 'element.arrange'
  | 'element.create_native'
  | 'connector.create'
  | 'element.update_content'
  | 'element.reparent';

/**
 * Compute the inverse of a conductor action result patch.
 *
 * Conventions:
 * - Return an empty object `{}` when the inverse is a destructive no-op
 *   (e.g. undo of a create = delete, undo of a delete = restore from snapshot
 *   which is handled by the redo branch, not by invertPatch).
 * - `prevXxx` fields in the patch carry the pre-action value; if absent we
 *   fall back to `xxx` itself, which means "undo a no-op" — the patch is a
 *   no-op identity that still produces a transaction log entry.
 *
 * Patch shape (must match what conductor:action writes — see db-handlers.ts):
 *   - canvas.rename:    { name, prevName }
 *   - widget.*:         { prevPosition, prevConfig, prevData, deletedWidget, restoredWidget, ... }
 *   - element.create:   { element }
 *   - element.move:     { position, prevPosition }
 *   - element.update:   { config, vizSpec, position, prevConfig, prevVizSpec, prevPosition }
 *   - element.delete:   { deletedElement }
 *   - element.create_native: { element }
 *   - connector.create:  { element }  (rows share the conductor_elements table)
 *   - element.update_content: { config, prevConfig }
 *   - element.reparent:  { metadata, prevMetadata }
 */
export function invertPatch(
  patch: Record<string, unknown>,
  actionType: string,
): Record<string, unknown> {
  switch (actionType) {
    case 'canvas.rename':
      return { name: patch.prevName || 'Untitled' };

    // widget.* (legacy dual-write path; Phase 3.6 will retire)
    case 'widget.create':
      return {};
    case 'widget.move':
    case 'widget.resize':
      return { position: (patch as any).prevPosition || patch.position };
    case 'widget.update_config':
      return { config: (patch as any).prevConfig || patch.config };
    case 'widget.update_data':
      return { data: (patch as any).prevData || patch.data };
    case 'widget.delete':
      return {};
    case 'widget.restore':
      return {};

    // element.*
    case 'element.create':
      return {};
    case 'element.move':
      return { position: (patch as any).prevPosition || patch.position };
    case 'element.update':
      return {
        config: (patch as any).prevConfig || patch.config,
        vizSpec: (patch as any).prevVizSpec ?? patch.vizSpec,
        position: (patch as any).prevPosition || patch.position,
      };
    case 'element.delete':
      return {};
    case 'element.arrange':
      return {};

    // element.create_native — undo = delete the native node by id.
    // The action handler stores the new element's row under patch.element;
    // we forward its id so the undo branch can DELETE FROM conductor_elements.
    case 'element.create_native':
      return { elementId: (patch as any).element?.id };

    // connector.create — undo = delete the connector row. Connectors are
    // also stored in conductor_elements (kind=native/connector) so the
    // patch shape matches element.create_native exactly: the row lives
    // under patch.element with an element.id.
    case 'connector.create':
      return { elementId: (patch as any).element?.id };

    // element.update_content — undo restores the previous config.
    // The action handler writes the new config under patch.config and the
    // old one under patch.prevConfig; we forward prevConfig so the undo
    // branch can UPDATE conductor_elements.config back to the previous JSON.
    case 'element.update_content':
      return { content: (patch as any).prevConfig ?? patch.config };

    // element.reparent — undo restores the previous parentId.
    // The action handler writes the new metadata under patch.metadata and
    // the old one under patch.prevMetadata; both are JSON objects with a
    // parentId field. We forward the previous parentId.
    case 'element.reparent':
      return { parentId: (patch as any).prevMetadata?.parentId ?? (patch as any).metadata?.parentId };

    default:
      return {};
  }
}