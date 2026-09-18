/**
 * conductor-undo-redo-handlers.ts — IPC handler bodies for
 * conductor:undo and conductor:redo (plan 534 Phase 3.7.d).
 *
 * Why this file exists: the original handlers in electron/ipc/db-handlers.ts
 * each held ~120 lines of inline switch + transaction + broadcast logic.
 * That bloat made the file difficult to review and impossible to unit-test
 * without spinning up an Electron renderer.
 *
 * The IPC body shrinks to two lines: look up getDb() and call this
 * module's handler. All DML, transaction wrapping, and result-patch
 * broadcast now live in runConductorUndo / runConductorRedo
 * (electron/db/core/conductors/conductor-undo-redo.ts) and in the
 * handlers below.
 *
 * The getDb / getChannelManager references are injected lazily because
 * both are late-binding services: they may not be registered yet when
 * these handlers are wired up. The createHandlers factory accepts both
 * accessors so db-handlers.ts can pass its internal getDb() helper.
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { SqliteDatabase } from '../../db/core/database';
import { runConductorRedo, runConductorUndo } from '../../db/core/conductors/conductor-undo-redo';

export interface ConductorHandlerDeps {
  /** Resolves the active database; throws if not initialized. */
  getDb: () => SqliteDatabase;
  /** Returns the ChannelManager if one is registered, else null. */
  getChannelManager: () => { sendToChannel(channel: string, payload: unknown): void } | null;
}

type PatchEvent = {
  kind: 'undo' | 'redo';
  canvasId: string;
  actionId: number;
  patch: Record<string, unknown>;
};

/**
 * Build the handler functions. db-handlers.ts passes its internal helpers
 * via this factory so we do not duplicate the database-init guard.
 */
export function createConductorUndoRedoHandlers(deps: ConductorHandlerDeps) {
  function broadcast(event: PatchEvent): void {
    deps.getChannelManager()?.sendToChannel('conductor', {
      type: 'conductor:state:patch',
      _v2: true,
      ...event,
    });
  }

  function undo(_event: IpcMainInvokeEvent, canvasId: string) {
    return runConductorUndo(deps.getDb(), canvasId, broadcast);
  }

  function redo(_event: IpcMainInvokeEvent, canvasId: string) {
    return runConductorRedo(deps.getDb(), canvasId, broadcast);
  }

  return { undo, redo };
}